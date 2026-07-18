/**
 * Snapshot a season's automated board into persisted placement rows (Stage 6.5).
 *
 * The board is computed live on read from `game_results` ({@link Storage.getAutomatedBoard}). The one
 * thing this stage materializes is per-agent placements, so the agent profile and history can read an
 * agent's standing directly without re-aggregating every season's run. This module is the seam that
 * recomputes that snapshot when a run settles `completed`: it reads the same live board, stamps a
 * 1-based rank in board order (the board already orders by descending mean score, with the efficiency
 * column breaking exact ties), and rewrites the season's `automated_placements` rows for the run.
 *
 * Keyed to the season's latest completed run, so a re-run replaces the prior snapshot and a
 * superseded run's placements do not linger. Pure orchestration over storage; no Docker, no board math
 * of its own.
 */
import type { PlacementInput, Storage } from '../storage/index.js'

/**
 * Recompute and persist placements after a run settles `completed`. Resolves the run's season and
 * defers to {@link persistPlacementsForSeason}; a no-op if the run vanished.
 */
export async function persistPlacementsForCompletedRun(
  storage: Storage,
  runId: string,
): Promise<void> {
  const run = await storage.getRun(runId)
  if (run === undefined) {
    return
  }
  await persistPlacementsForSeason(storage, run.season_id)
}

/**
 * Backfill placement snapshots for completed runs that settled before the completion hook could
 * write them. This runs at backend startup after interrupted runs are reconciled, so a process exit
 * between `completed` and placement persistence does not leave agent history permanently stale.
 */
export async function reconcileCompletedRunPlacements(
  storage: Storage,
  log: (message: string) => void = () => {},
): Promise<number> {
  const completedRuns = await storage.listRunsByStatus('completed')
  const seasonIds = new Set(completedRuns.map((run) => run.season_id))
  let rewritten = 0

  for (const seasonId of seasonIds) {
    try {
      if (await placementSnapshotCurrent(storage, seasonId)) {
        continue
      }
      await persistPlacementsForSeason(storage, seasonId)
      rewritten += 1
    } catch (error) {
      log(`season ${seasonId}: reconciling placements failed: ${String(error)}`)
    }
  }

  if (rewritten > 0) {
    log(`reconciled placement snapshots for ${rewritten} completed season(s)`)
  }
  return rewritten
}

/**
 * Rewrite a season's placement rows from its current automated board. The board's source is the
 * latest completed run, so the persisted run id is read back from there rather than trusting a caller's
 * id, keeping the snapshot consistent with what the board aggregates. A no-op while no run has completed.
 */
export async function persistPlacementsForSeason(
  storage: Storage,
  seasonId: string,
): Promise<void> {
  const run = await storage.getLatestCompletedRun(seasonId)
  if (run === undefined) {
    return
  }
  const season = await storage.getSeason(seasonId)
  if (season === undefined) {
    return
  }
  // Aggregate the board over the run we already resolved, so the persisted rows and the `run.id` they
  // are stamped with describe the same run rather than two independent "latest completed" lookups.
  const board = await storage.getAutomatedBoard(seasonId, run)
  const rows: PlacementInput[] = board.map((row, index) => ({
    rank: index + 1,
    agent: row.agent,
    mean_score: row.mean_score,
    mean_agent_compute_ms: row.mean_agent_compute_ms,
    llm_usage_by_model: row.llm_usage_by_model,
    failure_count: row.failure_count,
    recording_id: row.recording_id,
  }))
  await storage.replaceAutomatedPlacements(seasonId, season.env_id, run.id, rows)
}

async function placementSnapshotCurrent(storage: Storage, seasonId: string): Promise<boolean> {
  const [run, season] = await Promise.all([
    storage.getLatestCompletedRun(seasonId),
    storage.getSeason(seasonId),
  ])
  if (run === undefined || season === undefined) {
    return true
  }

  // Compare the board built from the run we resolved against the persisted snapshot's run, so a
  // freshness check never straddles two different "latest completed" reads.
  const board = await storage.getAutomatedBoard(seasonId, run)
  if (board.length === 0) {
    return false
  }

  const firstRow = board[0]
  if (firstRow === undefined) {
    return false
  }
  const placements = await storage.listPlacementsByAgent(firstRow.agent, season.env_id)
  const placement = placements.find((row) => row.season_id === seasonId)
  return placement?.run_id === run.id
}
