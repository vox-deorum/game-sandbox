/**
 * Snapshot an iteration's automated board into persisted placement rows (Stage 6.5).
 *
 * The board is computed live on read from `game_results` ({@link Storage.getAutomatedBoard}). The one
 * thing this stage materializes is per-agent placements, so the agent profile and history can read an
 * agent's standing directly without re-aggregating every iteration's run. This module is the seam that
 * recomputes that snapshot when a run settles `completed`: it reads the same live board, stamps a
 * 1-based rank in board order (the board already orders by descending mean score, with the efficiency
 * column breaking exact ties), and rewrites the iteration's `automated_placements` rows for the run.
 *
 * Keyed to the iteration's latest completed run, so a re-run replaces the prior snapshot and a
 * superseded run's placements do not linger. Pure orchestration over storage; no Docker, no board math
 * of its own.
 */
import type { PlacementInput, Storage } from '../storage/index.js'

/**
 * Recompute and persist placements after a run settles `completed`. Resolves the run's iteration and
 * defers to {@link persistPlacementsForIteration}; a no-op if the run vanished.
 */
export async function persistPlacementsForCompletedRun(
  storage: Storage,
  runId: string,
): Promise<void> {
  const run = await storage.getRun(runId)
  if (run === undefined) {
    return
  }
  await persistPlacementsForIteration(storage, run.iteration_id)
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
  const iterationIds = new Set(completedRuns.map((run) => run.iteration_id))
  let rewritten = 0

  for (const iterationId of iterationIds) {
    try {
      if (await placementSnapshotCurrent(storage, iterationId)) {
        continue
      }
      await persistPlacementsForIteration(storage, iterationId)
      rewritten += 1
    } catch (error) {
      log(`iteration ${iterationId}: reconciling placements failed: ${String(error)}`)
    }
  }

  if (rewritten > 0) {
    log(`reconciled placement snapshots for ${rewritten} completed iteration(s)`)
  }
  return rewritten
}

/**
 * Rewrite an iteration's placement rows from its current automated board. The board's source is the
 * latest completed run, so the persisted run id is read back from there rather than trusting a caller's
 * id, keeping the snapshot consistent with what the board aggregates. A no-op while no run has completed.
 */
export async function persistPlacementsForIteration(
  storage: Storage,
  iterationId: string,
): Promise<void> {
  const run = await storage.getLatestCompletedRun(iterationId)
  if (run === undefined) {
    return
  }
  const iteration = await storage.getIteration(iterationId)
  if (iteration === undefined) {
    return
  }
  const board = await storage.getAutomatedBoard(iterationId)
  const rows: PlacementInput[] = board.map((row, index) => ({
    rank: index + 1,
    agent: row.agent,
    mean_score: row.mean_score,
    mean_agent_compute_ms: row.mean_agent_compute_ms,
    failure_count: row.failure_count,
    recording_id: row.recording_id,
  }))
  await storage.replaceAutomatedPlacements(iterationId, iteration.env_id, run.id, rows)
}

async function placementSnapshotCurrent(storage: Storage, iterationId: string): Promise<boolean> {
  const [run, iteration] = await Promise.all([
    storage.getLatestCompletedRun(iterationId),
    storage.getIteration(iterationId),
  ])
  if (run === undefined || iteration === undefined) {
    return true
  }

  const board = await storage.getAutomatedBoard(iterationId)
  if (board.length === 0) {
    return false
  }

  const firstRow = board[0]
  if (firstRow === undefined) {
    return false
  }
  const placements = await storage.listPlacementsByAgent(firstRow.agent, iteration.env_id)
  const placement = placements.find((row) => row.iteration_id === iterationId)
  return placement?.run_id === run.id
}
