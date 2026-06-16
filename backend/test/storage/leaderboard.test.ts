/**
 * Storage coverage for the Stage 6.1 leaderboard surface, against the real Kysely implementation on
 * better-sqlite3 `:memory:` (no Docker). It proves the config codec gate, the one-open submission and
 * one-play-open invariants, the three-gate lifecycle, trigger-time roster/schedule snapshots, session
 * iteration attribution, latest-completed-run selection, placement rewrites, the rating
 * upsert/own-agent/Naive rules, both rating prompts, and leaderboard-recording retention protection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  AgentRef,
  IterationConfig,
  NewSessionInput,
  NewSubmissionInput,
  ScheduledGameInput,
  Storage,
} from '../../src/storage/index.js'
import { decodeIterationConfig } from '../../src/storage/index.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'

const ENV = 'flappy_bird'
const NAIVE: AgentRef = { kind: 'builtin-naive' }

function configWithMatch(depsVersion = 1): IterationConfig {
  return {
    deps_version: depsVersion,
    matches: [{ slots: ['submission'], seeds: [1, 2], games: 2 }],
  }
}

function submissionInput(overrides: Partial<NewSubmissionInput> = {}): NewSubmissionInput {
  return {
    iteration_id: 'iter',
    env_id: ENV,
    user_id: 'alice',
    source_kind: 'git',
    repo_url: 'https://example.com/a.git',
    commit_sha: null,
    local_path: null,
    ref: null,
    created_at: '2026-06-11T00:00:00.000Z',
    ...overrides,
  }
}

function sessionInput(overrides: Partial<NewSessionInput> = {}): NewSessionInput {
  return {
    id: 'sess-1',
    user_id: 'alice',
    env_id: ENV,
    mode: 'scripted',
    recording_id: null,
    created_at: '2026-06-11T00:00:00.000Z',
    ...overrides,
  }
}

const GAME_ONE: ScheduledGameInput = {
  match_index: 0,
  game_index: 0,
  seed: 1,
  slots: [{ kind: 'submission', submission_id: 's1', user_id: 'alice' }],
}
const ONE_GAME: ScheduledGameInput[] = [GAME_ONE]

/** Return the first element or fail loudly, so a test never silently passes on an empty result. */
function firstOf<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) {
    throw new Error('expected at least one row')
  }
  return row
}

/** Assert a lookup found its row and return it non-undefined, without a non-null assertion. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a defined value')
  }
  return value
}

describe('leaderboard storage on :memory:', () => {
  let storage: Storage

  beforeEach(async () => {
    storage = await openSqliteStorage(':memory:')
  })

  afterEach(async () => {
    await storage.close()
  })

  // --- iteration declaration and config ---

  it('createIteration writes an unreleased, submission-closed, play-closed row carrying deps_version', async () => {
    const iteration = await storage.createIteration({
      env_id: ENV,
      deps_version: 1,
      label: 'Week 1',
    })
    expect(iteration.submission_status).toBe('closed')
    expect(iteration.play_status).toBe('closed')
    expect(iteration.release_status).toBe('unreleased')
    expect(iteration.label).toBe('Week 1')
    expect(decodeIterationConfig(iteration.config)).toEqual({ deps_version: 1, matches: [] })
  })

  it('updateIterationConfig writes when there are no runs and no deps change', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    const result = await storage.updateIterationConfig(iteration.id, configWithMatch())
    expect(result.ok).toBe(true)
    const reread = await storage.getIteration(iteration.id)
    expect(decodeIterationConfig(defined(reread).config).matches).toHaveLength(1)
  })

  it('refuses an unforced config edit once a run exists, and a forced edit deletes the runs', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    await storage.updateIterationConfig(iteration.id, configWithMatch())
    await storage.createRunWithSchedule(iteration.id, 'dev-user', [], ONE_GAME)

    const refused = await storage.updateIterationConfig(iteration.id, configWithMatch())
    expect(refused).toEqual({ ok: false, conflict: 'iteration_has_runs' })

    const forced = await storage.updateIterationConfig(iteration.id, configWithMatch(), {
      force: true,
    })
    expect(forced.ok).toBe(true)
    expect(await storage.getLatestRun(iteration.id)).toBeUndefined()
  })

  it('refuses an unforced deps change with submissions, and a forced one deletes the submissions', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    await storage.createSubmission(submissionInput({ iteration_id: iteration.id }))

    const refused = await storage.updateIterationConfig(iteration.id, configWithMatch(2))
    expect(refused).toEqual({ ok: false, conflict: 'iteration_has_submissions' })

    const forced = await storage.updateIterationConfig(iteration.id, configWithMatch(2), {
      force: true,
    })
    expect(forced.ok).toBe(true)
    expect(await storage.findActiveSubmission(iteration.id, 'alice')).toBeUndefined()
  })

  // --- the three independent gates ---

  it('flips the three gates independently and opens play on an unreleased iteration', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    const play = await storage.setPlayStatus(iteration.id, 'open')
    expect(play).toMatchObject({ ok: true })
    const after = await storage.getIteration(iteration.id)
    expect(after?.play_status).toBe('open')
    expect(after?.submission_status).toBe('closed')
    expect(after?.release_status).toBe('unreleased')
    expect(await storage.getPublicPlayIteration(ENV)).toMatchObject({ id: iteration.id })
  })

  it('rejects opening a second submission window and a second play window for an environment', async () => {
    const a = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    const b = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    expect(await storage.setSubmissionStatus(a.id, 'open')).toMatchObject({ ok: true })
    expect(await storage.setSubmissionStatus(b.id, 'open')).toEqual({
      ok: false,
      conflict: 'open_iteration_exists',
    })
    expect(await storage.setPlayStatus(a.id, 'open')).toMatchObject({ ok: true })
    expect(await storage.setPlayStatus(b.id, 'open')).toEqual({
      ok: false,
      conflict: 'open_play_iteration_exists',
    })
  })

  it('stamps released_at once and leaves it stable across re-release; getReleasedIteration ignores unreleased', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    expect(await storage.getReleasedIteration(ENV)).toBeUndefined()
    const released = await storage.setReleaseStatus(iteration.id, 'released')
    expect(released.released_at).not.toBeNull()
    const stamp = released.released_at
    const reReleased = await storage.setReleaseStatus(iteration.id, 'released')
    expect(reReleased.released_at).toBe(stamp)
    expect(await storage.getReleasedIteration(ENV)).toMatchObject({ id: iteration.id })
  })

  it('listIterations hides unreleased history for public reads but shows it for admin reads', async () => {
    const released = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    await storage.setReleaseStatus(released.id, 'released')
    await storage.createIteration({ env_id: ENV, deps_version: 1 })

    const publicList = await storage.listIterations(ENV, { includeUnreleased: false })
    expect(publicList).toHaveLength(1)
    expect(publicList[0]?.id).toBe(released.id)

    const adminList = await storage.listIterations(ENV, { includeUnreleased: true })
    expect(adminList).toHaveLength(2)
  })

  // --- session iteration attribution ---

  it('records a nullable iteration_id on a session, by create input or by setSessionIteration', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    const attributed = await storage.createSession(
      sessionInput({ id: 'sess-it', iteration_id: iteration.id }),
    )
    expect(attributed.iteration_id).toBe(iteration.id)

    const orphan = await storage.createSession(sessionInput({ id: 'sess-null' }))
    expect(orphan.iteration_id).toBeNull()
    await storage.setSessionIteration('sess-null', iteration.id)
    expect((await storage.getSession('sess-null'))?.iteration_id).toBe(iteration.id)
  })

  // --- runs, games, results ---

  it('createRunWithSchedule snapshots config and roster and persists deterministic games', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 3 })
    await storage.updateIterationConfig(iteration.id, configWithMatch(3))
    const roster: AgentRef[] = [{ kind: 'submission', submission_id: 's1', user_id: 'alice' }]
    const run = await storage.createRunWithSchedule(iteration.id, 'dev-user', roster, ONE_GAME)

    expect(run.status).toBe('pending')
    expect(run.requested_by).toBe('dev-user')
    expect(decodeIterationConfig(run.config_snapshot).deps_version).toBe(3)
    expect(JSON.parse(run.submission_snapshot)).toEqual(roster)

    const games = await storage.listRunGames(run.id)
    expect(games).toHaveLength(1)
    expect(games[0]?.game_index).toBe(0)
    expect(JSON.parse(firstOf(games).slots)).toEqual(GAME_ONE.slots)
  })

  it('recordGameResult round-trips concrete agent columns and timing aggregates', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    const run = await storage.createRunWithSchedule(iteration.id, 'dev-user', [], ONE_GAME)
    const game = firstOf(await storage.listRunGames(run.id))
    await storage.recordGameResult({
      game_id: game.id,
      slot_index: 0,
      agent: { kind: 'submission', submission_id: 's1', user_id: 'alice' },
      episode_score: 42,
      agent_compute_ms_total: 120,
      acted_tick_count: 30,
      failed: false,
    })
    const [result] = await storage.listGameResultsByRun(run.id)
    expect(result).toMatchObject({
      agent_kind: 'submission',
      agent_submission_id: 's1',
      agent_user_id: 'alice',
      episode_score: 42,
      agent_compute_ms_total: 120,
      acted_tick_count: 30,
      failed: 0,
    })
  })

  it('getLatestCompletedRun returns the latest completed run and ignores a later running/failed one', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    const good = await storage.createRunWithSchedule(iteration.id, 'dev-user', [], ONE_GAME)
    await storage.setRunStatus(good.id, 'completed')
    const reRun = await storage.createRunWithSchedule(iteration.id, 'dev-user', [], ONE_GAME)
    await storage.setRunStatus(reRun.id, 'failed', 'boom')

    const latest = await storage.getLatestCompletedRun(iteration.id)
    expect(latest?.id).toBe(good.id)
    expect((await storage.getLatestRun(iteration.id))?.id).toBe(reRun.id)
  })

  it('attachRunGameRecording links a game to a recording for the board replay link', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    const run = await storage.createRunWithSchedule(iteration.id, 'dev-user', [], ONE_GAME)
    const game = firstOf(await storage.listRunGames(run.id))
    await storage.attachRunGameRecording(game.id, 'rec-1')
    expect((await storage.listRunGames(run.id))[0]?.recording_id).toBe('rec-1')
  })

  // --- placements ---

  it('replaceAutomatedPlacements rewrites rows for a re-run and supports submitted and Naive agents', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    const run1 = await storage.createRunWithSchedule(iteration.id, 'dev-user', [], ONE_GAME)
    await storage.replaceAutomatedPlacements(iteration.id, ENV, run1.id, [
      {
        rank: 1,
        agent: { kind: 'submission', submission_id: 's1', user_id: 'alice' },
        mean_score: 10,
        mean_agent_compute_ms: 5,
        failure_count: 0,
        recording_id: 'r1',
      },
      {
        rank: 2,
        agent: NAIVE,
        mean_score: 4,
        mean_agent_compute_ms: null,
        failure_count: 1,
        recording_id: null,
      },
    ])
    expect(
      await storage.listPlacementsByAgent({
        kind: 'submission',
        submission_id: 's1',
        user_id: 'alice',
      }),
    ).toHaveLength(1)
    expect(await storage.listPlacementsByAgent(NAIVE, ENV)).toHaveLength(1)

    // A re-run rewrites the snapshot rather than appending.
    const run2 = await storage.createRunWithSchedule(iteration.id, 'dev-user', [], ONE_GAME)
    await storage.replaceAutomatedPlacements(iteration.id, ENV, run2.id, [
      {
        rank: 1,
        agent: NAIVE,
        mean_score: 9,
        mean_agent_compute_ms: 2,
        failure_count: 0,
        recording_id: null,
      },
    ])
    expect(
      await storage.listPlacementsByAgent({
        kind: 'submission',
        submission_id: 's1',
        user_id: 'alice',
      }),
    ).toHaveLength(0)
    expect(await storage.listPlacementsByAgent(NAIVE, ENV)).toHaveLength(1)
  })

  // --- ratings ---

  it('upserts a 1-5 rating, overwrites on re-rate, rejects own-agent, and rates Naive', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    const aliceAgent: AgentRef = { kind: 'submission', submission_id: 's1', user_id: 'alice' }

    const first = await storage.upsertRating({
      iteration_id: iteration.id,
      env_id: ENV,
      rater_user_id: 'bob',
      agent: aliceAgent,
      score: 4,
    })
    expect(first).toMatchObject({ ok: true })
    const overwrite = await storage.upsertRating({
      iteration_id: iteration.id,
      env_id: ENV,
      rater_user_id: 'bob',
      agent: aliceAgent,
      score: 2,
    })
    expect(overwrite).toMatchObject({ ok: true })
    expect(await storage.listRatingsByIteration(iteration.id)).toHaveLength(1)
    expect((await storage.getRating(iteration.id, 'bob', aliceAgent))?.score).toBe(2)

    const own = await storage.upsertRating({
      iteration_id: iteration.id,
      env_id: ENV,
      rater_user_id: 'alice',
      agent: aliceAgent,
      score: 5,
    })
    expect(own).toEqual({ ok: false, reason: 'own_agent' })

    const badScore = await storage.upsertRating({
      iteration_id: iteration.id,
      env_id: ENV,
      rater_user_id: 'bob',
      agent: NAIVE,
      score: 9,
    })
    expect(badScore).toEqual({ ok: false, reason: 'invalid_score' })

    expect(
      await storage.upsertRating({
        iteration_id: iteration.id,
        env_id: ENV,
        rater_user_id: 'alice',
        agent: NAIVE,
        score: 4,
      }),
    ).toMatchObject({ ok: true })
    expect(
      await storage.upsertRating({
        iteration_id: iteration.id,
        env_id: ENV,
        rater_user_id: 'bob',
        agent: NAIVE,
        score: 2,
      }),
    ).toMatchObject({ ok: true })
    const agg = await storage.aggregateRatingsByAgent(iteration.id)
    const naiveAgg = agg.find((row) => row.agent.kind === 'builtin-naive')
    expect(naiveAgg).toEqual({ agent: NAIVE, mean: 3, count: 2 })
  })

  // --- rating prompts ---

  it('setIterationRatingPrompt sets and clears, and stays editable after a run exists', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    await storage.createRunWithSchedule(iteration.id, 'dev-user', [], ONE_GAME)
    await storage.setIterationRatingPrompt(iteration.id, 'Rate creativity')
    expect((await storage.getIteration(iteration.id))?.rating_prompt).toBe('Rate creativity')
    await storage.setIterationRatingPrompt(iteration.id, null)
    expect((await storage.getIteration(iteration.id))?.rating_prompt).toBeNull()
  })

  it('upsertAgentRatingPrompt inserts then overwrites per author and survives resubmission', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    await storage.upsertAgentRatingPrompt(iteration.id, 'alice', 'Judge my dodging')
    await storage.upsertAgentRatingPrompt(iteration.id, 'alice', 'Judge my new dodging')
    await storage.upsertAgentRatingPrompt(iteration.id, 'bob', 'Judge my scoring')

    // Keyed by (iteration, user), so it is independent of which submission id ratings key on.
    expect((await storage.getAgentRatingPrompt(iteration.id, 'alice'))?.prompt).toBe(
      'Judge my new dodging',
    )
    const all = await storage.listAgentRatingPromptsByIteration(iteration.id)
    expect(all).toHaveLength(2)
  })

  // --- retention protection ---

  it('listProtectedLeaderboardRecordingIds exempts current-run recordings and excludes superseded ones', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 1 })

    const run1 = await storage.createRunWithSchedule(iteration.id, 'dev-user', [], ONE_GAME)
    const game1 = firstOf(await storage.listRunGames(run1.id))
    await storage.attachRunGameRecording(game1.id, 'rec-old')
    await storage.setRunStatus(run1.id, 'completed')

    const run2 = await storage.createRunWithSchedule(iteration.id, 'dev-user', [], ONE_GAME)
    const game2 = firstOf(await storage.listRunGames(run2.id))
    await storage.attachRunGameRecording(game2.id, 'rec-new')
    await storage.setRunStatus(run2.id, 'completed')

    const protectedIds = await storage.listProtectedLeaderboardRecordingIds()
    expect(protectedIds).toContain('rec-new')
    expect(protectedIds).not.toContain('rec-old')
  })

  // --- automated board aggregation ---

  it('getAutomatedBoard aggregates per agent over the latest completed run with a deterministic order', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    const twoGames: ScheduledGameInput[] = [
      { match_index: 0, game_index: 0, seed: 1, slots: [{ kind: 'builtin-naive' }] },
      { match_index: 0, game_index: 1, seed: 2, slots: [{ kind: 'builtin-naive' }] },
    ]
    const run = await storage.createRunWithSchedule(iteration.id, 'dev-user', [], twoGames)
    const games = await storage.listRunGames(run.id)
    const [g0, g1] = [firstOf(games), defined(games[1])]
    await storage.attachRunGameRecording(g0.id, 'rec0')
    await storage.attachRunGameRecording(g1.id, 'rec1')

    const s1: AgentRef = { kind: 'submission', submission_id: 's1', user_id: 'alice' }
    const s2: AgentRef = { kind: 'submission', submission_id: 's2', user_id: 'carol' }
    // Two submitted agents tie at mean 15 (so the agent-key tie-break decides order); Naive trails at 5
    // and contributes no ticks, exercising the null mean-compute branch.
    const seats: Array<[AgentRef, string, number, number, number]> = [
      [s1, g0.id, 10, 100, 10],
      [s1, g1.id, 20, 100, 10],
      [s2, g0.id, 10, 100, 10],
      [s2, g1.id, 20, 100, 10],
      [NAIVE, g0.id, 5, 0, 0],
      [NAIVE, g1.id, 5, 0, 0],
    ]
    for (const [agent, gameId, score, compute, ticks] of seats) {
      await storage.recordGameResult({
        game_id: gameId,
        slot_index: 0,
        agent,
        episode_score: score,
        agent_compute_ms_total: compute,
        acted_tick_count: ticks,
        failed: false,
      })
    }
    await storage.setRunStatus(run.id, 'completed')

    const board = await storage.getAutomatedBoard(iteration.id)
    expect(board.map((row) => row.agent)).toEqual([s1, s2, NAIVE])
    expect(board[0]).toMatchObject({
      mean_score: 15,
      mean_agent_compute_ms: 10, // (100 + 100) / (10 + 10)
      games: 2,
      failure_count: 0,
      recording_id: 'rec1', // the agent's best game (score 20)
    })
    expect(board[2]).toMatchObject({ mean_score: 5, mean_agent_compute_ms: null })
  })

  it('getAutomatedBoard is empty until a run completes', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    await storage.createRunWithSchedule(iteration.id, 'dev-user', [], ONE_GAME)
    expect(await storage.getAutomatedBoard(iteration.id)).toEqual([])
  })

  it('a malformed forced config edit throws and deletes nothing (validate before mutate)', async () => {
    const iteration = await storage.createIteration({ env_id: ENV, deps_version: 1 })
    await storage.updateIterationConfig(iteration.id, configWithMatch())
    await storage.createRunWithSchedule(iteration.id, 'dev-user', [], ONE_GAME)
    await storage.createSubmission(submissionInput({ iteration_id: iteration.id }))

    // A bad config (negative deps_version) fails the codec; even with force the runs/submissions the
    // forced path would otherwise clear must survive, because validation precedes any deletion.
    const malformed = { deps_version: -1, matches: [] } as unknown as IterationConfig
    await expect(
      storage.updateIterationConfig(iteration.id, malformed, { force: true }),
    ).rejects.toThrow()

    expect(await storage.getLatestRun(iteration.id)).toBeDefined()
    expect(await storage.findActiveSubmission(iteration.id, 'alice')).toBeDefined()
  })
})
