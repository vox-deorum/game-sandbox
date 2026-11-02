/** Public leaderboard visibility, attribution, and released history over real auth and SQLite. */
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentRef, Season, Storage } from '../../src/storage/index.js'
import type { TestUsers } from '../support/auth.js'
import { createRunOrFail, openTestApp, type TestApp } from '../support/harness.js'
import { TEST_DISABLED_OFFICIAL_LLM_POLICY } from '../support/llm-options.js'

const ENV_ID = 'flappy_bird'

describe('public leaderboard API', () => {
  let app: FastifyInstance
  let fixture: TestApp
  let storage: Storage
  let users: TestUsers

  beforeEach(async () => {
    fixture = await openTestApp()
    app = fixture.app
    storage = fixture.storage
    users = fixture.users
  })

  afterEach(async () => {
    await fixture.close()
  })

  async function declare(envId = ENV_ID, label: string | null = null): Promise<Season> {
    return storage.createSeason({ env_id: envId, deps_version: 1, label })
  }

  async function makeRun(seasonId: string, agents: AgentRef[]) {
    await users.headersFor('operator', { status: 'admin' })
    return createRunOrFail(storage, seasonId, users.idOf('operator'), () => ({
      parametersSnapshot: { players: 1 },
      scheduledGames: agents.map((agent, index) => ({
        match_index: 0,
        game_index: index,
        seed: index + 1,
        seats: [agent],
        seat_plan: 'solo',
      })),
      llmPolicy: TEST_DISABLED_OFFICIAL_LLM_POLICY,
    }))
  }

  it('lists released history newest first within one environment', async () => {
    const older = await declare()
    await storage.setReleaseStatus(older.id, 'released')
    const newer = await declare()
    await storage.setReleaseStatus(newer.id, 'released')
    await declare()
    const elsewhere = await declare('turn_based')
    await storage.setReleaseStatus(elsewhere.id, 'released')

    const res = await app.inject({ method: 'GET', url: `/api/environments/${ENV_ID}/seasons` })
    expect(res.statusCode).toBe(200)
    expect(res.json<Array<{ id: string }>>().map((season) => season.id)).toEqual([
      newer.id,
      older.id,
    ])
  })

  it.each([
    { includePrivate: false },
    { includePrivate: true },
  ])('lists season metadata with private access $includePrivate', async ({ includePrivate }) => {
    const released = await declare()
    await storage.setReleaseStatus(released.id, 'released')
    await storage.setSeasonDescription(released.id, 'Read the **rules**.')
    const submitOpen = await declare()
    await storage.setSubmissionStatus(submitOpen.id, 'open')
    const playOpen = await declare()
    await storage.setPlayStatus(playOpen.id, 'open')
    const hidden = await declare()
    const elsewhere = await declare('turn_based')
    await storage.setReleaseStatus(elsewhere.id, 'released')
    for (const season of [released, submitOpen, playOpen, hidden, elsewhere]) {
      await storage.updateSeasonConfig(season.id, {
        deps_version: 1,
        matches: [],
        overrides: { step_timeout_ms: 500 },
      })
      await storage.setSeasonRatingPrompt(season.id, 'Private scoring notes')
    }
    const callers = includePrivate
      ? [await users.headersFor('operator', { status: 'admin' })]
      : [undefined, await users.headersFor('viewer')]
    const expected = includePrivate
      ? [hidden.id, playOpen.id, submitOpen.id, released.id]
      : [playOpen.id, submitOpen.id, released.id]
    for (const headers of callers) {
      for (const filter of ['', `&envId=${ENV_ID}`]) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/seasons?${includePrivate ? 'includeUnreleased=true' : ''}${filter}`,
          headers,
        })
        expect(res.statusCode).toBe(200)
        const body = res.json<Array<Record<string, unknown> & { id: string }>>()
        expect(body.map((season) => season.id)).toEqual(
          filter ? expected : [elsewhere.id, ...expected],
        )
        expect(body.find((season) => season.id === released.id)).toMatchObject({
          description_markdown: 'Read the **rules**.',
        })
        for (const season of body) {
          expect(season).toMatchObject({
            submission_count: expect.any(Number),
            game_count: expect.any(Number),
          })
          for (const key of ['config', 'rating_prompt', 'board'])
            expect(season).not.toHaveProperty(key)
        }
      }
    }
  })

  it.each([
    ['anonymous', 401, 'auth_required'],
    ['normal', 403, 'not_operator'],
    ['pending', 403, 'not_operator'],
    ['guest', 403, 'not_operator'],
  ] as const)('refuses private season access for %s', async (caller, status, code) => {
    await declare()
    const headers =
      caller === 'anonymous' ? undefined : await users.headersFor('viewer', { status: caller })
    const res = await app.inject({
      method: 'GET',
      url: '/api/seasons?includeUnreleased=true',
      headers,
    })
    expect([res.statusCode, res.json().code]).toEqual([status, code])
  })

  it('counts active submissions after a participant resubmits', async () => {
    const season = await declare()
    await storage.setReleaseStatus(season.id, 'released')
    await users.headersFor('alice')
    await users.headersFor('bob')
    await makeSubmission(storage, season.id, users.idOf('alice'), '2026-06-11T00:00:00.000Z')
    await makeSubmission(storage, season.id, users.idOf('alice'), '2026-06-11T00:01:00.000Z')
    await makeSubmission(storage, season.id, users.idOf('bob'), '2026-06-11T00:02:00.000Z')

    const res = await app.inject({ method: 'GET', url: '/api/seasons' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([expect.objectContaining({ id: season.id, submission_count: 2 })])
  })

  it('returns an empty current board when nothing is released, plus the public targets', async () => {
    const submitTarget = await declare()
    await storage.setSubmissionStatus(submitTarget.id, 'open')
    const playTarget = await declare()
    await storage.setPlayStatus(playTarget.id, 'open')

    const res = await app.inject({ method: 'GET', url: `/api/environments/${ENV_ID}/leaderboards` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      current: unknown
      submission_season_id: string | null
      play_season_id: string | null
    }
    // Nothing released → empty current board, but the submit and play targets are still reported even
    // though both their seasons are unreleased.
    expect(body.current).toBeNull()
    expect(body.submission_season_id).toBe(submitTarget.id)
    expect(body.play_season_id).toBe(playTarget.id)
  })

  it('selects the latest released board independently of submit and play targets', async () => {
    const older = await declare()
    await storage.setReleaseStatus(older.id, 'released')
    const released = await declare()
    await storage.updateSeasonConfig(released.id, {
      deps_version: 1,
      matches: [],
      overrides: { parameters: { pipe_gap: 125 }, step_timeout_ms: 500 },
    })
    await storage.setReleaseStatus(released.id, 'released')
    const submit = await declare()
    await storage.setSubmissionStatus(submit.id, 'open')
    const play = await declare()
    await storage.setPlayStatus(play.id, 'open')

    const res = await app.inject({ method: 'GET', url: `/api/environments/${ENV_ID}/leaderboards` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      submission_season_id: submit.id,
      play_season_id: play.id,
      current: {
        season: { id: released.id },
        settings: { values: { pipe_gap: 125 }, rules: { step_timeout_ms: 500 } },
        board: { automated: [], human: [], games: [] },
      },
    })
  })

  it.each([
    ['normal', true],
    ['anonymous', false],
    ['admin', true],
    ['guest', false],
  ] as const)('serves released board identities appropriately for %s during open play', async (caller, namesVisible) => {
    await users.headersFor('alice')
    await users.headersFor('bob')
    const aliceId = users.idOf('alice')
    const bobId = users.idOf('bob')
    const season = await declare()
    await storage.setReleaseStatus(season.id, 'released')
    await storage.setPlayStatus(season.id, 'open')
    const alice = await makeSubmission(storage, season.id, aliceId)
    const bob = await makeSubmission(storage, season.id, bobId)
    const naive = { kind: 'builtin', name: 'naive' } as const
    const run = await makeRun(season.id, [agentRef(alice), agentRef(bob), naive])
    const games = await storage.listRunGames(run.id)
    for (const [index, agent] of [agentRef(alice), agentRef(bob), naive].entries()) {
      const game = games[index]
      if (game === undefined) throw new Error('Expected a game for each scheduled agent')
      await storage.recordGameResult({
        game_id: game.id,
        seat_index: 0,
        agent,
        episode_score: 5 - index,
        agent_compute_ms_total: 10,
        acted_tick_count: 2,
        failed: false,
        ...(index === 0
          ? {
              llm_usage_by_model: {
                small: {
                  calls: 1,
                  estimated_calls: 0,
                  input_tokens: 1,
                  reasoning_tokens: 0,
                  output_tokens: 2,
                  latency_ms: 5,
                },
              },
              llm_weighted_cost: 3,
            }
          : {}),
      })
    }
    await storage.setRunStatus(run.id, 'completed')
    await storage.upsertRating({
      season_id: season.id,
      env_id: ENV_ID,
      rater_user_id: bobId,
      agent: agentRef(alice),
      score: 4,
      feedback: 'A private peer comment',
    })

    const headers =
      caller === 'anonymous' ? undefined : await users.headersFor('viewer', { status: caller })
    const res = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/leaderboards`,
      headers,
    })
    expect(res.statusCode).toBe(200)
    const board = res.json<{
      current: {
        board: {
          automated: Array<{ agent: Record<string, unknown>; llm_weighted_cost: number | null }>
          human: Array<{ agent: Record<string, unknown> }>
          games: Array<{ seats: Array<Record<string, unknown>>; results: unknown[] }>
        }
      }
    }>().current.board
    const expectedRefs = [
      { kind: 'submission', submission_id: alice.id, user_id: aliceId },
      { kind: 'submission', submission_id: bob.id, user_id: bobId },
      { kind: 'builtin', name: 'naive', label: 'Naive agent' },
    ]
    expect(board.automated.map((row) => row.agent)).toMatchObject(expectedRefs)
    expect(board.human.map((row) => row.agent)).toMatchObject([expectedRefs[0]])
    expect(board.games.map((game) => game.seats)).toMatchObject([
      [expectedRefs[0]],
      [expectedRefs[1]],
      [expectedRefs[2]],
    ])
    expect(board.games.map((game) => game.results)).toEqual([
      [{ seat_index: 0, episode_score: 5, failed: false }],
      [{ seat_index: 0, episode_score: 4, failed: false }],
      [{ seat_index: 0, episode_score: 3, failed: false }],
    ])
    expect(board.automated[0]?.llm_weighted_cost).toBe(3)
    expect(res.body).not.toContain('A private peer comment')
    const names: Record<string, string> = { [aliceId]: 'alice', [bobId]: 'bob' }
    for (const ref of [
      ...board.automated.map((row) => row.agent),
      ...board.human.map((row) => row.agent),
      ...board.games.flatMap((game) => game.seats),
    ]) {
      if (ref.kind === 'submission') {
        if (namesVisible) expect(ref.user_name).toBe(names[ref.user_id as string])
        else expect(ref).not.toHaveProperty('user_name')
      }
    }
  })

  it('reads a historical release and refuses unavailable season boards', async () => {
    const hidden = await declare()
    const older = await declare()
    await storage.updateSeasonConfig(older.id, {
      deps_version: 1,
      matches: [],
      overrides: { parameters: { pipe_gap: 80 }, episode_timeout_ms: 30_000 },
    })
    await storage.setReleaseStatus(older.id, 'released')
    const newer = await declare()
    await storage.setReleaseStatus(newer.id, 'released')
    await users.headersFor('alice')
    await users.headersFor('bob')
    const oldAgent = await makeSubmission(storage, older.id, users.idOf('alice'))
    const newAgent = await makeSubmission(storage, newer.id, users.idOf('alice'))
    for (const [season, submission, score] of [
      [older, oldAgent, 2],
      [newer, newAgent, 5],
    ] as const) {
      await storage.upsertRating({
        season_id: season.id,
        env_id: ENV_ID,
        rater_user_id: users.idOf('bob'),
        agent: agentRef(submission),
        score,
        feedback: 'Useful movement',
      })
    }

    const res = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/seasons/${older.id}/leaderboards`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      season: { id: older.id },
      settings: { values: { pipe_gap: 80 }, rules: { episode_timeout_ms: 30_000 } },
      board: { human: [{ agent: { submission_id: oldAgent.id }, mean: 2, count: 1 }] },
    })
    for (const url of [
      `/api/environments/${ENV_ID}/seasons/${hidden.id}/leaderboards`,
      `/api/environments/${ENV_ID}/seasons/ghost/leaderboards`,
      `/api/environments/turn_based/seasons/${older.id}/leaderboards`,
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404)
    }
  })

  it('returns an empty placements payload for an owner with no submissions', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/agents/nobody/placements`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ env_id: ENV_ID, owner_id: 'nobody', placements: [] })
  })

  it('returns released owner placements across seasons and superseded attempts without comments', async () => {
    for (const name of ['alice', 'bob', 'carol']) await users.headersFor(name)
    const aliceId = users.idOf('alice')
    const hidden = await declare()
    const older = await declare(ENV_ID, 'Autumn')
    await storage.setReleaseStatus(older.id, 'released')
    const newer = await declare(ENV_ID, 'Winter')
    await storage.setReleaseStatus(newer.id, 'released')
    const hiddenAgent = await makeSubmission(storage, hidden.id, aliceId)
    const oldAttempt = await makeSubmission(storage, older.id, aliceId, '2026-06-11T00:00:00.000Z')
    await makeSubmission(storage, older.id, aliceId, '2026-06-11T00:01:00.000Z')
    const current = await makeSubmission(storage, newer.id, aliceId)
    const otherOwner = await makeSubmission(storage, newer.id, users.idOf('bob'))
    const placement = (agent: AgentRef, mean_score: number, recording_id: string) => ({
      rank: 1,
      agent,
      mean_score,
      mean_agent_compute_ms: 2,
      failure_count: 0,
      recording_id,
    })
    for (const [season, rows] of [
      [hidden, [placement(agentRef(hiddenAgent), 99, 'hidden-recording')]],
      [older, [placement(agentRef(oldAttempt), 7, 'visible-recording')]],
      [
        newer,
        [
          placement(agentRef(current), -2, 'recent-recording'),
          placement(agentRef(otherOwner), 88, 'other-recording'),
          placement({ kind: 'builtin', name: 'naive' }, 0, 'builtin-recording'),
        ],
      ],
    ] as const) {
      const run = await makeRun(
        season.id,
        rows.map((row) => row.agent),
      )
      await storage.setRunStatus(run.id, 'completed')
      await storage.replaceAutomatedPlacements(season.id, ENV_ID, run.id, [...rows])
    }
    for (const [rater, score] of [
      ['bob', 5],
      ['carol', 3],
    ] as const) {
      await storage.upsertRating({
        season_id: older.id,
        env_id: ENV_ID,
        rater_user_id: users.idOf(rater),
        agent: agentRef(oldAttempt),
        score,
        feedback: 'A private peer comment',
      })
    }

    const res = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/agents/${aliceId}/placements`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      env_id: string
      owner_id: string
      placements: Array<Record<string, unknown>>
    }>()
    expect(body).toMatchObject({ env_id: ENV_ID, owner_id: aliceId })
    expect(body.placements).toHaveLength(2)
    expect(body.placements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          season_id: older.id,
          agent_submission_id: oldAttempt.id,
          mean_score: 7,
          recording_id: 'visible-recording',
          season_label: 'Autumn',
          human_mean: 4,
          human_count: 2,
        }),
        expect.objectContaining({
          season_id: newer.id,
          agent_submission_id: current.id,
          mean_score: -2,
          recording_id: 'recent-recording',
          season_label: 'Winter',
          human_mean: null,
          human_count: 0,
        }),
      ]),
    )
    for (const row of body.placements) {
      expect(row).not.toHaveProperty('feedback')
      expect(row).not.toHaveProperty('human_feedback')
    }
    expect(res.body).not.toContain('A private peer comment')
  })
})

/** Create a submission row for a test profile. */
async function makeSubmission(
  storage: Storage,
  seasonId: string,
  userId: string,
  createdAt = new Date().toISOString(),
) {
  return storage.createSubmission({
    season_id: seasonId,
    env_id: ENV_ID,
    user_id: userId,
    source_kind: 'git',
    repo_url: 'https://example.test/repo',
    commit_sha: 'sha1',
    local_path: null,
    ref: null,
    created_at: createdAt,
  })
}

/** The submitted-agent ref for a submission row. */
function agentRef(submission: { id: string; user_id: string }) {
  return { kind: 'submission' as const, submission_id: submission.id, user_id: submission.user_id }
}
