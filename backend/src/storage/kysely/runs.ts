/**
 * Season-run, scheduled-game, and per-seat-result queries: snapshot a run with its games,
 * advance run/game statuses, attach replays, and record/read results for the board aggregation.
 * Also owns {@link deleteRunsForSeason}, the cascade the forced config-edit path reuses.
 */
import { randomUUID } from 'node:crypto'

import type { Kysely, SelectQueryBuilder } from 'kysely'
import { sql } from 'kysely'
import {
  encodeResolvedOfficialLlmPolicy,
  type ResolvedOfficialLlmPolicy,
} from '../../llm/config.js'
import type { AgentRef, RecordGameResultInput, ScheduledGameInput } from '../index.js'
import type {
  Database,
  GameResult,
  GameStatus,
  RunStatus,
  SeasonRun,
  SeasonRunGame,
} from '../schema.js'
import { decodeSeasonConfig, type SeasonConfig } from '../season-config.js'
import {
  agentColumns,
  decodeLlmUsageByModel,
  encodeLlmUsageByModel,
  encodeLlmWeightedCost,
} from './shared.js'

function decodeGameResult(
  row: Omit<GameResult, 'llm_usage_by_model'> & {
    llm_usage_by_model: string | null
  },
): GameResult {
  return { ...row, llm_usage_by_model: decodeLlmUsageByModel(row.llm_usage_by_model) }
}

/** Run-status values that close a run (stamping `ended_at`). */
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled'])

/** Game-status values that close a game (stamping `ended_at`). */
const TERMINAL_GAME_STATUSES: ReadonlySet<GameStatus> = new Set([
  'completed',
  'failed',
  'timed_out',
  'cancelled',
])

/**
 * Delete a season's runs and everything that hangs off them (scheduled games, per-seat results,
 * placements). Takes an executor so it composes inside a larger transaction (the forced config edit)
 * as well as on its own; `Transaction<Database>` is assignable to `Kysely<Database>`.
 */
export async function deleteRunsForSeason(db: Kysely<Database>, seasonId: string): Promise<void> {
  const runs = await db
    .selectFrom('season_runs')
    .select('id')
    .where('season_id', '=', seasonId)
    .execute()
  const runIds = runs.map((row) => row.id)
  if (runIds.length > 0) {
    const games = await db
      .selectFrom('season_run_games')
      .select('id')
      .where('run_id', 'in', runIds)
      .execute()
    const gameIds = games.map((row) => row.id)
    if (gameIds.length > 0) {
      await db.deleteFrom('game_results').where('game_id', 'in', gameIds).execute()
    }
    await db.deleteFrom('season_run_games').where('run_id', 'in', runIds).execute()
    await db.deleteFrom('season_runs').where('id', 'in', runIds).execute()
  }
  await db.deleteFrom('automated_placements').where('season_id', '=', seasonId).execute()
}

export async function createRunWithSchedule(
  db: Kysely<Database>,
  seasonId: string,
  requestedBy: string,
  submissionSnapshot: AgentRef[],
  scheduledGames: ScheduledGameInput[],
  resolveLlmPolicy: (config: SeasonConfig) => ResolvedOfficialLlmPolicy,
): Promise<SeasonRun> {
  return await db.transaction().execute(async (trx) => {
    // Freeze the season's already-validated config (incl. deps) and the eligible roster onto the
    // run, then persist the concrete games. The runner reads these, not the mutable source rows.
    // The LLM policy is resolved from the same in-transaction config read that becomes
    // `config_snapshot`, so a concurrent config edit can never leave the two snapshots disagreeing.
    const season = await trx
      .selectFrom('seasons')
      .select('config')
      .where('id', '=', seasonId)
      .executeTakeFirstOrThrow()
    const llmPolicy = resolveLlmPolicy(decodeSeasonConfig(season.config))
    const runId = randomUUID()
    const now = new Date().toISOString()
    const run = await trx
      .insertInto('season_runs')
      .values({
        id: runId,
        season_id: seasonId,
        requested_by: requestedBy,
        config_snapshot: season.config,
        llm_policy_snapshot: encodeResolvedOfficialLlmPolicy(llmPolicy),
        submission_snapshot: JSON.stringify(submissionSnapshot),
        status: 'pending',
        started_at: now,
        ended_at: null,
        error: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    for (const game of scheduledGames) {
      await trx
        .insertInto('season_run_games')
        .values({
          id: randomUUID(),
          run_id: runId,
          match_index: game.match_index,
          game_index: game.game_index,
          seed: game.seed,
          slots: JSON.stringify(game.slots),
          status: 'pending',
          recording_id: null,
          started_at: null,
          ended_at: null,
          error: null,
        })
        .execute()
    }
    return run
  })
}

export async function setRunStatus(
  db: Kysely<Database>,
  id: string,
  status: RunStatus,
  error?: string,
): Promise<void> {
  await db
    .updateTable('season_runs')
    .set({
      status,
      error: error ?? null,
      ended_at: TERMINAL_RUN_STATUSES.has(status) ? new Date().toISOString() : null,
    })
    .where('id', '=', id)
    .execute()
}

export async function getRun(db: Kysely<Database>, id: string): Promise<SeasonRun | undefined> {
  return await db.selectFrom('season_runs').selectAll().where('id', '=', id).executeTakeFirst()
}

export async function listRunsByStatus(
  db: Kysely<Database>,
  status: RunStatus,
): Promise<SeasonRun[]> {
  return await db
    .selectFrom('season_runs')
    .selectAll()
    .where('status', '=', status)
    .orderBy('started_at', 'asc')
    .orderBy(sql`rowid`, 'asc')
    .execute()
}

/**
 * Apply the canonical "newest run first" ordering to a `season_runs` query: most recent `started_at`
 * first, with insertion order (`rowid`) breaking ties when two runs share a millisecond timestamp, so
 * "the latest run" is deterministic and a failed re-run never blanks a good board. Every latest-run
 * read funnels through here — {@link getLatestRun}, {@link getLatestCompletedRun},
 * {@link listRunsBySeason}, and the season-list `game_count` subquery — so they cannot disagree on
 * which run is "the latest" if the tie-break ever changes. The one deliberate exception is
 * `claimRecordingCleanup` in ./retention.ts, which re-derives this ordering in raw SQL so its
 * protection recheck stays inside a single atomic statement; keep that copy in lockstep.
 */
export function orderByNewestRun<O>(
  query: SelectQueryBuilder<Database, 'season_runs', O>,
): SelectQueryBuilder<Database, 'season_runs', O> {
  return query.orderBy('started_at', 'desc').orderBy(sql`rowid`, 'desc')
}

export async function getLatestRun(
  db: Kysely<Database>,
  seasonId: string,
): Promise<SeasonRun | undefined> {
  return await orderByNewestRun(
    db.selectFrom('season_runs').selectAll().where('season_id', '=', seasonId),
  ).executeTakeFirst()
}

export async function getLatestCompletedRun(
  db: Kysely<Database>,
  seasonId: string,
): Promise<SeasonRun | undefined> {
  // The board reads the latest *completed* run, so a later running/failed re-run never blanks a good
  // board; `orderByNewestRun` supplies the deterministic newest-first ordering and its tie-break.
  return await orderByNewestRun(
    db
      .selectFrom('season_runs')
      .selectAll()
      .where('season_id', '=', seasonId)
      .where('status', '=', 'completed'),
  ).executeTakeFirst()
}

export async function listRunsBySeason(
  db: Kysely<Database>,
  seasonId: string,
): Promise<SeasonRun[]> {
  // Newest first (the shared `orderByNewestRun` rule), so the first row is always "the latest run".
  return await orderByNewestRun(
    db.selectFrom('season_runs').selectAll().where('season_id', '=', seasonId),
  ).execute()
}

/** Game count per run for a season, keyed by run id, for the runs-list summaries (one grouped scan). */
export async function countRunGamesBySeason(
  db: Kysely<Database>,
  seasonId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom('season_run_games')
    .innerJoin('season_runs', 'season_runs.id', 'season_run_games.run_id')
    .where('season_runs.season_id', '=', seasonId)
    .select('season_run_games.run_id as run_id')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .groupBy('season_run_games.run_id')
    .execute()
  return new Map(rows.map((row) => [row.run_id, Number(row.count)]))
}

export async function listRunGames(db: Kysely<Database>, runId: string): Promise<SeasonRunGame[]> {
  return await db
    .selectFrom('season_run_games')
    .selectAll()
    .where('run_id', '=', runId)
    .orderBy('game_index', 'asc')
    .execute()
}

export async function setRunGameStatus(
  db: Kysely<Database>,
  id: string,
  status: GameStatus,
  error?: string,
): Promise<void> {
  const now = new Date().toISOString()
  await db
    .updateTable('season_run_games')
    .set({
      status,
      error: error ?? null,
      ...(status === 'running' ? { started_at: now } : {}),
      ...(TERMINAL_GAME_STATUSES.has(status) ? { ended_at: now } : {}),
    })
    .where('id', '=', id)
    .execute()
}

export async function attachRunGameRecording(
  db: Kysely<Database>,
  gameId: string,
  recordingId: string,
): Promise<void> {
  await db
    .updateTable('season_run_games')
    .set({ recording_id: recordingId })
    .where('id', '=', gameId)
    .execute()
}

export async function recordGameResult(
  db: Kysely<Database>,
  input: RecordGameResultInput,
): Promise<GameResult> {
  const row = await db
    .insertInto('game_results')
    .values({
      id: randomUUID(),
      game_id: input.game_id,
      slot_index: input.slot_index,
      ...agentColumns(input.agent),
      episode_score: input.episode_score,
      agent_compute_ms_total: input.agent_compute_ms_total,
      acted_tick_count: input.acted_tick_count,
      llm_usage_by_model: encodeLlmUsageByModel(input.llm_usage_by_model),
      llm_weighted_cost: encodeLlmWeightedCost(input.llm_weighted_cost, input.llm_usage_by_model),
      failed: input.failed ? 1 : 0,
      failure_reason: input.failure_reason ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  return decodeGameResult(row)
}

export async function listGameResultsByRun(
  db: Kysely<Database>,
  runId: string,
): Promise<GameResult[]> {
  const rows = await db
    .selectFrom('game_results')
    .innerJoin('season_run_games', 'season_run_games.id', 'game_results.game_id')
    .where('season_run_games.run_id', '=', runId)
    .selectAll('game_results')
    .execute()
  return rows.map(decodeGameResult)
}
