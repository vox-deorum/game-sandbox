/**
 * The public leaderboard and history reads (Stage 6.3), Docker-free. These prove the route-boundary
 * guarantee: board/history reads return only `released` seasons, while an open submission or play
 * window is still reported as a public target without exposing the season's boards.
 */
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Season, Storage } from '../../src/storage/index.js'
import type { TestUsers } from '../support/auth.js'
import { openTestApp, type TestApp } from '../support/harness.js'
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

  /** Declare a season directly in storage and return its row. */
  async function declare(): Promise<Season> {
    return storage.createSeason({ env_id: ENV_ID, deps_version: 1, label: null })
  }

  it('lists only released seasons for history, newest first', async () => {
    const unreleased = await declare()
    const released = await declare()
    await storage.setReleaseStatus(released.id, 'released')

    const res = await app.inject({ method: 'GET', url: `/api/environments/${ENV_ID}/seasons` })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as Array<{ id: string }>).map((i) => i.id)
    expect(ids).toEqual([released.id])
    expect(ids).not.toContain(unreleased.id)
  })

  it('lists every public-facing season across the three flags, without boards', async () => {
    const released = await declare()
    await storage.setReleaseStatus(released.id, 'released')
    await storage.setSeasonDescription(released.id, 'Read the **rules**.')
    const submitOpen = await declare()
    await storage.setSubmissionStatus(submitOpen.id, 'open')
    const playOpen = await declare()
    await storage.setPlayStatus(playOpen.id, 'open')
    const hidden = await declare() // closed and unreleased — never public

    const res = await app.inject({ method: 'GET', url: '/api/seasons' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<Record<string, unknown> & { id: string }>
    const ids = body.map((s) => s.id)
    expect(new Set(ids)).toEqual(new Set([released.id, submitOpen.id, playOpen.id]))
    expect(ids).not.toContain(hidden.id)
    // The index exposes only public listing metadata. Unreleased configuration, rating prompts, and
    // board payloads stay behind their operator/released-only routes.
    expect(
      body.every(
        (season) =>
          season.config === undefined &&
          season.rating_prompt === undefined &&
          season.board === undefined &&
          (season.id !== released.id || season.description_markdown === 'Read the **rules**.') &&
          typeof season.submission_count === 'number' &&
          typeof season.game_count === 'number',
      ),
    ).toBe(true)
  })

  it('lets an operator list every season — including fully-private ones — with ?includeUnreleased=true', async () => {
    const released = await declare()
    await storage.setReleaseStatus(released.id, 'released')
    const hidden = await declare() // closed and unreleased — never public

    // An admin session may see unreleased seasons; the flag is gated by `requireAdmin`.
    const res = await app.inject({
      method: 'GET',
      url: `/api/seasons?envId=${ENV_ID}&includeUnreleased=true`,
      headers: await users.headersFor('op', { status: 'admin' }),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<Record<string, unknown> & { id: string }>
    expect(body.map((s) => s.id)).toEqual([hidden.id, released.id])
    // Still the public listing shape: config, rating prompts, and boards stay out, counts stay in.
    expect(
      body.every(
        (season) =>
          season.config === undefined &&
          season.rating_prompt === undefined &&
          season.description_markdown === null &&
          typeof season.submission_count === 'number',
      ),
    ).toBe(true)
  })

  it('refuses ?includeUnreleased=true for a non-operator with 403 not_operator', async () => {
    const hidden = await declare()
    const carol = await users.headersFor('carol')

    const res = await app.inject({
      method: 'GET',
      url: `/api/seasons?envId=${ENV_ID}&includeUnreleased=true`,
      headers: carol,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'not_operator' })

    // Anonymous is refused with 401 rather than the non-operator 403.
    const anon = await app.inject({
      method: 'GET',
      url: `/api/seasons?envId=${ENV_ID}&includeUnreleased=true`,
    })
    expect(anon.statusCode).toBe(401)
    expect(anon.json()).toMatchObject({ code: 'auth_required' })

    // The flagless public list stays open to everyone and still hides the fully-private season.
    const open = await app.inject({
      method: 'GET',
      url: `/api/seasons?envId=${ENV_ID}`,
      headers: carol,
    })
    expect(open.statusCode).toBe(200)
    expect((open.json() as Array<{ id: string }>).map((s) => s.id)).not.toContain(hidden.id)
  })

  it('counts active submissions in the public season index, excluding superseded attempts', async () => {
    const season = await declare()
    await storage.setReleaseStatus(season.id, 'released')

    await storage.createSubmission({
      season_id: season.id,
      env_id: ENV_ID,
      user_id: 'alice',
      source_kind: 'git',
      repo_url: 'https://example.test/alice/first',
      commit_sha: 'sha-1',
      local_path: null,
      ref: null,
      created_at: '2026-06-11T00:00:00.000Z',
    })
    await storage.createSubmission({
      season_id: season.id,
      env_id: ENV_ID,
      user_id: 'alice',
      source_kind: 'git',
      repo_url: 'https://example.test/alice/current',
      commit_sha: 'sha-2',
      local_path: null,
      ref: null,
      created_at: '2026-06-11T00:01:00.000Z',
    })
    await storage.createSubmission({
      season_id: season.id,
      env_id: ENV_ID,
      user_id: 'bob',
      source_kind: 'git',
      repo_url: 'https://example.test/bob/current',
      commit_sha: 'sha-3',
      local_path: null,
      ref: null,
      created_at: '2026-06-11T00:02:00.000Z',
    })

    const res = await app.inject({ method: 'GET', url: '/api/seasons' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      expect.objectContaining({
        id: season.id,
        submission_count: 2,
      }),
    ])
  })

  it('narrows the public seasons list to one environment with ?envId=', async () => {
    const here = await declare()
    await storage.setReleaseStatus(here.id, 'released')
    const elsewhere = await storage.createSeason({
      env_id: 'turn_based',
      deps_version: 1,
      label: null,
    })
    await storage.setReleaseStatus(elsewhere.id, 'released')

    const res = await app.inject({ method: 'GET', url: `/api/seasons?envId=${ENV_ID}` })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as Array<{ id: string }>).map((s) => s.id)
    expect(ids).toEqual([here.id])
    expect(ids).not.toContain(elsewhere.id)
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

  it('returns the released current season and both boards', async () => {
    const released = await declare()
    await storage.setReleaseStatus(released.id, 'released')

    const res = await app.inject({ method: 'GET', url: `/api/environments/${ENV_ID}/leaderboards` })
    const body = res.json() as {
      current: {
        season: { id: string }
        board: { automated: unknown[]; human: unknown[]; games: unknown[] }
      }
    }
    expect(body.current.season.id).toBe(released.id)
    expect(body.current.board).toEqual({ automated: [], human: [], games: [] })
  })

  it('enriches board rows and matchup seats with owner display names beside stable ids', async () => {
    await users.headersFor('alice')
    await users.headersFor('bob')
    const aliceId = users.idOf('alice')
    const season = await declare()
    await storage.setReleaseStatus(season.id, 'released')

    // Two submitted agents on the completed run: one owned by a real user, one by an id with no
    // user row (the fallback case).
    const known = await makeSubmission(storage, season.id, aliceId)
    const orphaned = await makeSubmission(storage, season.id, 'ghost-user')
    const run = await storage.createRunWithSchedule(season.id, 'dev-user', () => ({
      parametersSnapshot: { seats: 1 },
      scheduledGames: [
        { match_index: 0, game_index: 0, seed: 1, slots: [agentRef(known)] },
        { match_index: 0, game_index: 1, seed: 2, slots: [agentRef(orphaned)] },
      ],
      llmPolicy: TEST_DISABLED_OFFICIAL_LLM_POLICY,
    }))
    if (run === undefined) throw new Error('expected a scheduled run')
    const games = await storage.listRunGames(run.id)
    for (const [index, submission] of [known, orphaned].entries()) {
      const game = games[index]
      if (game === undefined) {
        throw new Error('expected a scheduled game per submission')
      }
      await storage.recordGameResult({
        game_id: game.id,
        slot_index: 0,
        agent: agentRef(submission),
        episode_score: 5 - index,
        agent_compute_ms_total: 10,
        acted_tick_count: 2,
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
        failed: false,
      })
    }
    await storage.setRunStatus(run.id, 'completed')
    // One human rating gives the human board an (unranked) row carrying the same enriched ref.
    await storage.upsertRating({
      season_id: season.id,
      env_id: ENV_ID,
      rater_user_id: users.idOf('bob'),
      agent: agentRef(known),
      score: 4,
    })

    const res = await app.inject({ method: 'GET', url: `/api/environments/${ENV_ID}/leaderboards` })
    expect(res.statusCode).toBe(200)
    const board = (
      res.json() as {
        current: {
          board: {
            automated: Array<{ agent: Record<string, unknown>; llm_weighted_cost: number | null }>
            human: Array<{ agent: Record<string, unknown> }>
            games: Array<{ slots: Array<Record<string, unknown>> }>
          }
        }
      }
    ).current.board

    const automatedKnown = board.automated.find((row) => row.agent.user_id === aliceId)
    expect(automatedKnown?.agent).toMatchObject({ user_id: aliceId, user_name: 'alice' })
    expect(automatedKnown?.llm_weighted_cost).toBe(3)
    // No user row for the owner id: the stable id stays and no user_name appears.
    const automatedOrphan = board.automated.find((row) => row.agent.user_id === 'ghost-user')
    expect(automatedOrphan?.agent.user_name).toBeUndefined()

    expect(board.human[0]?.agent).toMatchObject({ user_id: aliceId, user_name: 'alice' })

    const seat = (slots: Array<Record<string, unknown>> | undefined) => slots?.[0]
    const gameSeats = board.games.map((game) => seat(game.slots))
    expect(gameSeats.find((s) => s?.user_id === aliceId)).toMatchObject({ user_name: 'alice' })
    expect(gameSeats.find((s) => s?.user_id === 'ghost-user')?.user_name).toBeUndefined()
  })

  it('serves a specific released season board and 404s an unreleased one', async () => {
    const unreleased = await declare()
    const released = await declare()
    await storage.setReleaseStatus(released.id, 'released')

    const ok = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/seasons/${released.id}/leaderboards`,
    })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { season: { id: string } }).season.id).toBe(released.id)

    const hidden = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/seasons/${unreleased.id}/leaderboards`,
    })
    expect(hidden.statusCode).toBe(404)

    const unknown = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/seasons/ghost/leaderboards`,
    })
    expect(unknown.statusCode).toBe(404)
  })

  it('returns an empty placements payload for an owner with no submissions', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/agents/nobody/placements`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ env_id: ENV_ID, owner_id: 'nobody', placements: [] })
  })

  it('returns only placements from released seasons', async () => {
    const unreleased = await declare()
    const hidden = await makeSubmission(storage, unreleased.id, 'alice')
    const hiddenRun = await storage.createRunWithSchedule(unreleased.id, 'dev-user', () => ({
      parametersSnapshot: { seats: 1 },
      scheduledGames: [{ match_index: 0, game_index: 0, seed: 1, slots: [agentRef(hidden)] }],
      llmPolicy: TEST_DISABLED_OFFICIAL_LLM_POLICY,
    }))
    if (hiddenRun === undefined) throw new Error('expected a scheduled run')
    await storage.replaceAutomatedPlacements(unreleased.id, ENV_ID, hiddenRun.id, [
      {
        rank: 1,
        agent: agentRef(hidden),
        mean_score: 99,
        mean_agent_compute_ms: 1,
        failure_count: 0,
        recording_id: 'hidden-recording',
      },
    ])

    const released = await declare()
    await storage.setReleaseStatus(released.id, 'released')
    const visible = await makeSubmission(storage, released.id, 'alice')
    const visibleRun = await storage.createRunWithSchedule(released.id, 'dev-user', () => ({
      parametersSnapshot: { seats: 1 },
      scheduledGames: [{ match_index: 0, game_index: 0, seed: 1, slots: [agentRef(visible)] }],
      llmPolicy: TEST_DISABLED_OFFICIAL_LLM_POLICY,
    }))
    if (visibleRun === undefined) throw new Error('expected a scheduled run')
    await storage.replaceAutomatedPlacements(released.id, ENV_ID, visibleRun.id, [
      {
        rank: 1,
        agent: agentRef(visible),
        mean_score: 7,
        mean_agent_compute_ms: 2,
        failure_count: 0,
        recording_id: 'visible-recording',
      },
    ])
    // Two ratings (mean 4) so the profile can show the live human-rating aggregate. Raters must be
    // someone other than the agent's owner (alice), who cannot rate their own agent.
    await storage.upsertRating({
      season_id: released.id,
      env_id: ENV_ID,
      rater_user_id: 'bob',
      agent: agentRef(visible),
      score: 5,
    })
    await storage.upsertRating({
      season_id: released.id,
      env_id: ENV_ID,
      rater_user_id: 'carol',
      agent: agentRef(visible),
      score: 3,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/agents/alice/placements`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      placements: Array<{
        season_id: string
        mean_score: number
        recording_id: string | null
        season_label: string | null
        human_mean: number | null
        human_count: number
      }>
    }
    expect(body.placements).toEqual([
      expect.objectContaining({
        season_id: released.id,
        mean_score: 7,
        recording_id: 'visible-recording',
        season_label: null,
        human_mean: 4,
        human_count: 2,
      }),
    ])
  })
})

/** Create a submission row for a test profile. */
async function makeSubmission(storage: Storage, seasonId: string, userId: string) {
  return storage.createSubmission({
    season_id: seasonId,
    env_id: ENV_ID,
    user_id: userId,
    source_kind: 'git',
    repo_url: 'https://example.test/repo',
    commit_sha: 'sha1',
    local_path: null,
    ref: null,
    created_at: new Date().toISOString(),
  })
}

/** The submitted-agent ref for a submission row. */
function agentRef(submission: { id: string; user_id: string }) {
  return { kind: 'submission' as const, submission_id: submission.id, user_id: submission.user_id }
}
