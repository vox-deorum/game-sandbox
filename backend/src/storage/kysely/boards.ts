/**
 * Automated-board queries: rewrite a season's persisted placement rows, read an agent's
 * placements for its profile, and aggregate the latest completed run's per-seat results into the
 * live public board (per-agent means, failure counts, and a representative replay link).
 */
import { randomUUID } from 'node:crypto'

import type { Kysely } from 'kysely'

import type { AgentRef, AutomatedBoardRow, HumanBoardRow, PlacementInput } from '../index.js'
import type { AutomatedPlacement, Database } from '../schema.js'
import { aggregateRatingsByAgent } from './ratings.js'
import { getLatestCompletedRun } from './runs.js'
import {
  type AgentColumns,
  agentColumns,
  agentKey,
  agentRefFromColumns,
  agentRefKey,
} from './shared.js'

/**
 * The minimum number of ratings an agent needs before the human board assigns it a rank. Under this
 * threshold the agent's mean and count still show, but unranked, so a single early rating cannot place
 * an agent atop the board.
 */
export const HUMAN_BOARD_MIN_RATINGS = 3

export async function replaceAutomatedPlacements(
  db: Kysely<Database>,
  seasonId: string,
  envId: string,
  runId: string,
  rows: PlacementInput[],
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('automated_placements').where('season_id', '=', seasonId).execute()
    const now = new Date().toISOString()
    for (const row of rows) {
      await trx
        .insertInto('automated_placements')
        .values({
          id: randomUUID(),
          season_id: seasonId,
          env_id: envId,
          run_id: runId,
          rank: row.rank,
          ...agentColumns(row.agent),
          mean_score: row.mean_score,
          mean_agent_compute_ms: row.mean_agent_compute_ms,
          failure_count: row.failure_count,
          recording_id: row.recording_id,
          created_at: now,
        })
        .execute()
    }
  })
}

export async function listPlacementsByAgent(
  db: Kysely<Database>,
  agent: AgentRef,
  envId?: string,
): Promise<AutomatedPlacement[]> {
  const cols = agentColumns(agent)
  let query = db
    .selectFrom('automated_placements')
    .selectAll()
    .where('agent_kind', '=', cols.agent_kind)
  query =
    cols.agent_submission_id === null
      ? query.where('agent_submission_id', 'is', null)
      : query.where('agent_submission_id', '=', cols.agent_submission_id)
  if (envId !== undefined) {
    query = query.where('env_id', '=', envId)
  }
  return await query.orderBy('created_at', 'desc').execute()
}

export async function getAutomatedBoard(
  db: Kysely<Database>,
  seasonId: string,
): Promise<AutomatedBoardRow[]> {
  const run = await getLatestCompletedRun(db, seasonId)
  if (run === undefined) {
    return []
  }
  // Aggregate the run's per-seat results per agent. Joining the game gives the per-row replay link;
  // the representative recording is the agent's best game (ties broken by lower game_index).
  const rows = await db
    .selectFrom('game_results')
    .innerJoin('season_run_games', 'season_run_games.id', 'game_results.game_id')
    .where('season_run_games.run_id', '=', run.id)
    .select([
      'game_results.agent_kind as agent_kind',
      'game_results.agent_submission_id as agent_submission_id',
      'game_results.agent_user_id as agent_user_id',
      'game_results.episode_score as episode_score',
      'game_results.agent_compute_ms_total as agent_compute_ms_total',
      'game_results.acted_tick_count as acted_tick_count',
      'game_results.failed as failed',
      'season_run_games.recording_id as recording_id',
      'season_run_games.game_index as game_index',
    ])
    .execute()

  interface Acc {
    agent: AgentColumns
    scoreSum: number
    computeSum: number
    tickSum: number
    failureCount: number
    games: number
    bestScore: number
    bestGameIndex: number
    bestRecording: string | null
  }
  const groups = new Map<string, Acc>()
  for (const row of rows) {
    const key = agentKey(row)
    let acc = groups.get(key)
    if (acc === undefined) {
      acc = {
        agent: row,
        scoreSum: 0,
        computeSum: 0,
        tickSum: 0,
        failureCount: 0,
        games: 0,
        bestScore: Number.NEGATIVE_INFINITY,
        bestGameIndex: Number.POSITIVE_INFINITY,
        bestRecording: null,
      }
      groups.set(key, acc)
    }
    acc.scoreSum += row.episode_score
    acc.computeSum += row.agent_compute_ms_total
    acc.tickSum += row.acted_tick_count
    acc.failureCount += row.failed === 1 ? 1 : 0
    acc.games += 1
    const better =
      row.episode_score > acc.bestScore ||
      (row.episode_score === acc.bestScore && row.game_index < acc.bestGameIndex)
    if (better) {
      acc.bestScore = row.episode_score
      acc.bestGameIndex = row.game_index
      acc.bestRecording = row.recording_id
    }
  }

  return (
    [...groups.values()]
      .map((acc) => ({
        agent: agentRefFromColumns(acc.agent),
        mean_score: acc.games > 0 ? acc.scoreSum / acc.games : 0,
        mean_agent_compute_ms: acc.tickSum > 0 ? acc.computeSum / acc.tickSum : null,
        failure_count: acc.failureCount,
        games: acc.games,
        recording_id: acc.bestRecording,
      }))
      // Descending by mean score. A score tie is broken by lower mean agent compute, so the faster
      // agent ranks higher. Per the Stage 6.5 decision, the efficiency column decides an exact
      // tie (a deliberate revision of leaderboard.md, where score alone otherwise orders the board).
      // An agent with no contributing ticks (null compute) sorts last on the tie; the stable agent
      // key is the final tiebreak so the order is fully deterministic.
      .sort((a, b) => {
        if (b.mean_score !== a.mean_score) {
          return b.mean_score - a.mean_score
        }
        const ca = a.mean_agent_compute_ms ?? Number.POSITIVE_INFINITY
        const cb = b.mean_agent_compute_ms ?? Number.POSITIVE_INFINITY
        if (ca !== cb) {
          return ca - cb
        }
        return agentRefKey(a.agent).localeCompare(agentRefKey(b.agent))
      })
  )
}

/**
 * The human-feedback board: aggregate the season's ratings per agent, order them by mean (then
 * count, then the stable agent key), and apply the ranking rule — agents at or above the threshold get
 * a 1-based rank, the rest follow unranked. The ordering is the same for both groups, so the unranked
 * tail reads as "next in line" below the ranked set.
 */
export async function getHumanBoard(
  db: Kysely<Database>,
  seasonId: string,
): Promise<HumanBoardRow[]> {
  const aggregates = await aggregateRatingsByAgent(db, seasonId)
  const ordered = [...aggregates].sort((a, b) => {
    if (b.mean !== a.mean) {
      return b.mean - a.mean
    }
    if (b.count !== a.count) {
      return b.count - a.count
    }
    return agentRefKey(a.agent).localeCompare(agentRefKey(b.agent))
  })
  const ranked = ordered.filter((row) => row.count >= HUMAN_BOARD_MIN_RATINGS)
  const unranked = ordered.filter((row) => row.count < HUMAN_BOARD_MIN_RATINGS)
  return [
    ...ranked.map((row, index) => ({ ...row, rank: index + 1 })),
    ...unranked.map((row) => ({ ...row, rank: null })),
  ]
}
