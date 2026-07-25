import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NewSubmissionInput, Season, Submission } from '../../src/storage/index.js'
import type { TestApp } from '../support/harness.js'
import { createRunOrFail, openTestApp } from '../support/harness.js'
import { TEST_DISABLED_OFFICIAL_LLM_POLICY } from '../support/llm-options.js'

const ENV = 'flappy_bird'

interface SeasonSummaryBody {
  id: string
  label: string | null
  created_at: string
  release_status: 'unreleased' | 'released'
  submission: { id: string; status: string; submitted_at: string } | null
  mean_score: number | null
}

interface EnvironmentSummaryBody {
  env_id: string
  current_season: SeasonSummaryBody | null
  previous_seasons: SeasonSummaryBody[]
}

describe('my agents API', () => {
  let testApp: TestApp

  beforeEach(async () => {
    testApp = await openTestApp()
  })

  afterEach(async () => {
    await testApp.close()
  })

  function submissionInput(season: Season, userId: string, createdAt: string): NewSubmissionInput {
    return {
      season_id: season.id,
      env_id: season.env_id,
      user_id: userId,
      source_kind: 'git',
      repo_url: 'https://example.test/agent.git',
      commit_sha: null,
      local_path: null,
      ref: null,
      created_at: createdAt,
    }
  }

  async function submit(season: Season, userId: string, createdAt: string): Promise<Submission> {
    return await testApp.storage.createSubmission(submissionInput(season, userId, createdAt))
  }

  async function place(season: Season, submission: Submission, meanScore: number): Promise<void> {
    const run = await createRunOrFail(testApp.storage, season.id, 'operator', () => ({
      parametersSnapshot: { players: 1 },
      scheduledGames: [
        { match_index: 0, game_index: 0, seed: 1, seats: [{ kind: 'builtin-naive' }] },
      ],
      llmPolicy: TEST_DISABLED_OFFICIAL_LLM_POLICY,
    }))
    await testApp.storage.replaceAutomatedPlacements(season.id, season.env_id, run.id, [
      {
        rank: 1,
        agent: {
          kind: 'submission',
          submission_id: submission.id,
          user_id: submission.user_id,
        },
        mean_score: meanScore,
        mean_agent_compute_ms: null,
        failure_count: 0,
        recording_id: null,
      },
    ])
  }

  async function read(headers: Record<string, string>): Promise<EnvironmentSummaryBody[]> {
    const response = await testApp.app.inject({ method: 'GET', url: '/api/my/agents', headers })
    expect(response.statusCode).toBe(200)
    return response.json() as EnvironmentSummaryBody[]
  }

  it('requires a signed-in user but permits a pending user', async () => {
    const anonymous = await testApp.app.inject({ method: 'GET', url: '/api/my/agents' })
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.json()).toMatchObject({ code: 'auth_required' })

    const pendingHeaders = await testApp.users.headersFor('pending', { status: 'pending' })
    const season = await testApp.storage.createSeason({ env_id: ENV, deps_version: 1 })
    await testApp.storage.setSubmissionStatus(season.id, 'open')
    const submission = await submit(
      season,
      testApp.users.idOf('pending'),
      '2026-07-14T00:00:00.000Z',
    )
    const pending = await read(pendingHeaders)
    expect(pending).toMatchObject([
      { current_season: { id: season.id, submission: { id: submission.id } } },
    ])
  })

  it('shows the exact current-season submission and keeps another user isolated', async () => {
    const current = await testApp.storage.createSeason({
      env_id: ENV,
      deps_version: 1,
      label: 'Current',
    })
    await testApp.storage.setSubmissionStatus(current.id, 'open')
    const aliceHeaders = await testApp.users.headersFor('alice')
    const bobHeaders = await testApp.users.headersFor('bob')
    const aliceSubmission = await submit(
      current,
      testApp.users.idOf('alice'),
      '2026-07-14T01:02:03.000Z',
    )

    const alice = await read(aliceHeaders)
    expect(alice).toHaveLength(1)
    expect(alice[0]).toMatchObject({
      env_id: ENV,
      current_season: {
        id: current.id,
        label: 'Current',
        release_status: 'unreleased',
        submission: {
          id: aliceSubmission.id,
          status: 'pending',
          submitted_at: '2026-07-14T01:02:03.000Z',
        },
        mean_score: null,
      },
      previous_seasons: [],
    })

    // The current season itself is visible, but Alice's ownership and submission never are.
    const bob = await read(bobHeaders)
    expect(bob).toMatchObject([
      { env_id: ENV, current_season: { id: current.id, submission: null }, previous_seasons: [] },
    ])
  })

  it('keeps active submissions independent across seasons and returns only three newest previous seasons', async () => {
    const aliceHeaders = await testApp.users.headersFor('alice')
    const userId = testApp.users.idOf('alice')
    const previous: Season[] = []
    for (let index = 0; index < 4; index += 1) {
      const season = await testApp.storage.createSeason({
        env_id: ENV,
        deps_version: 1,
        label: `Previous ${index}`,
      })
      previous.push(season)
      await submit(season, userId, `2026-07-1${index}T00:00:00.000Z`)
    }
    const current = await testApp.storage.createSeason({
      env_id: ENV,
      deps_version: 1,
      label: 'Current',
    })
    await testApp.storage.setSubmissionStatus(current.id, 'open')
    const currentSubmission = await submit(current, userId, '2026-07-14T00:00:00.000Z')

    const body = await read(aliceHeaders)
    expect(body[0]?.current_season?.submission?.id).toBe(currentSubmission.id)
    expect(body[0]?.previous_seasons.map((season) => season.id)).toEqual(
      previous
        .slice(1)
        .reverse()
        .map((season) => season.id),
    )
  })

  it('associates scores with any attempted submission and hides retained unreleased placements', async () => {
    const aliceHeaders = await testApp.users.headersFor('alice')
    const userId = testApp.users.idOf('alice')

    const negative = await testApp.storage.createSeason({
      env_id: ENV,
      deps_version: 1,
      label: 'Negative',
    })
    const scoredAttempt = await submit(negative, userId, '2026-07-10T00:00:00.000Z')
    await place(negative, scoredAttempt, -2.5)
    await testApp.storage.setReleaseStatus(negative.id, 'released')
    const replacement = await submit(negative, userId, '2026-07-11T00:00:00.000Z')

    const zero = await testApp.storage.createSeason({ env_id: ENV, deps_version: 1, label: 'Zero' })
    const zeroAttempt = await submit(zero, userId, '2026-07-12T00:00:00.000Z')
    await place(zero, zeroAttempt, 0)
    await testApp.storage.setReleaseStatus(zero.id, 'released')

    const hidden = await testApp.storage.createSeason({
      env_id: ENV,
      deps_version: 1,
      label: 'Hidden',
    })
    const hiddenAttempt = await submit(hidden, userId, '2026-07-13T00:00:00.000Z')
    await place(hidden, hiddenAttempt, 99)
    await testApp.storage.setReleaseStatus(hidden.id, 'released')
    await testApp.storage.setReleaseStatus(hidden.id, 'unreleased')

    const current = await testApp.storage.createSeason({
      env_id: ENV,
      deps_version: 1,
      label: 'Current without score',
    })
    await testApp.storage.setSubmissionStatus(current.id, 'open')
    await testApp.storage.setReleaseStatus(current.id, 'released')

    const environment = (await read(aliceHeaders))[0]
    expect(environment?.current_season).toMatchObject({
      id: current.id,
      release_status: 'released',
      submission: null,
      mean_score: null,
    })
    const summaries = environment?.previous_seasons ?? []
    expect(summaries.find((season) => season.id === negative.id)).toMatchObject({
      submission: { id: replacement.id },
      mean_score: -2.5,
    })
    expect(summaries.find((season) => season.id === zero.id)?.mean_score).toBe(0)
    expect(summaries.find((season) => season.id === hidden.id)).toMatchObject({
      release_status: 'unreleased',
      mean_score: null,
    })
  })

  it('includes environments with either a current season or submission history', async () => {
    const aliceHeaders = await testApp.users.headersFor('alice')
    const history = await testApp.storage.createSeason({ env_id: ENV, deps_version: 1 })
    await submit(history, testApp.users.idOf('alice'), '2026-07-13T00:00:00.000Z')
    const currentOnly = await testApp.storage.createSeason({ env_id: 'hearts', deps_version: 1 })
    await testApp.storage.setSubmissionStatus(currentOnly.id, 'open')

    const body = await read(aliceHeaders)
    expect(body.map((summary) => summary.env_id).sort()).toEqual([ENV, 'hearts'])
    expect(body.find((summary) => summary.env_id === ENV)).toMatchObject({
      current_season: null,
      previous_seasons: [{ id: history.id }],
    })
    expect(body.find((summary) => summary.env_id === 'hearts')).toMatchObject({
      current_season: { id: currentOnly.id, submission: null },
      previous_seasons: [],
    })
  })
})
