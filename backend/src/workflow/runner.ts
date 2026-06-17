/**
 * The workflow-runner seam: the interface the admin trigger/cancel routes enqueue onto and the
 * WebSocket log stream subscribes to, plus the startup reconcile.
 *
 * Triggering a run must never block the HTTP request on Docker, just as Stage 5's submit route does
 * not block on the validation pipeline. The route persists the resolved schedule with a `pending`
 * run row and hands the run id to a {@link WorkflowRunner}; the runner drives the persisted games to
 * a terminal state out of band, emitting the {@link RunEvent}s the WebSocket route relays. This module
 * owns only the *seam* — the interface, its event shapes, and the reconcile. Stage 6.4 provides the
 * real Docker-backed implementation; Stage 6.3 ships a {@link createPlaceholderRunner} so the process
 * wires cleanly and a stub in tests, so the routes, gating, and streaming are proven Docker-free.
 */
import type { Storage } from '../storage/index.js'
import type { GameStatus, RunStatus } from '../storage/schema.js'

/** A run-level terminal status: the three states a run settles into once it stops executing. */
export type TerminalRunStatus = Extract<RunStatus, 'completed' | 'failed' | 'cancelled'>

/** One per-match container log line, as it is emitted by the running workflow. */
export interface RunLogEvent {
  type: 'log'
  /** The deterministic schedule index of the game that produced the line. */
  game_index: number
  /** Which `config_snapshot.matches` entry the game came from. */
  match_index: number
  line: string
}

/** A scheduled game's status transition (pending → running → terminal), relayed live. */
export interface RunGameStatusEvent {
  type: 'game_status'
  game_index: number
  status: GameStatus
}

/** The final event a run's stream emits before the socket closes. */
export interface RunTerminalEvent {
  type: 'terminal'
  status: TerminalRunStatus
}

/** One event on a run's live stream: a container log line, a game-status transition, or the terminal. */
export type RunEvent = RunLogEvent | RunGameStatusEvent | RunTerminalEvent

/** A subscriber to a run's live event stream. */
export type RunEventListener = (event: RunEvent) => void

/**
 * The execution seam between the admin API and the background workflow. The trigger route enqueues a
 * persisted, `pending` run; the cancel route requests a cooperative stop; the log-stream route
 * subscribes for live events. The runner owns advancing run/game statuses, writing results, and
 * emitting events — none of which the routes touch. It is intentionally I/O-free at this layer so a
 * stub can stand in for the suite.
 */
export interface WorkflowRunner {
  /**
   * Begin executing a persisted, `pending` run. Non-blocking: it returns immediately and the run
   * advances out of band. Called once per trigger/re-run, after the schedule is already persisted.
   */
  enqueue(runId: string): void
  /**
   * Request cancellation of an in-progress run. The runner stops scheduling further games and marks
   * the run `cancelled` (it owns the cooperative stop). A no-op for an unknown or already-terminal run.
   */
  cancel(runId: string): void
  /**
   * Subscribe to a run's live event stream, returning an unsubscribe. Live-only: a late subscriber
   * misses lines emitted before it attached (the buffered backlog-on-attach is deferred polish). The
   * runner emits {@link RunTerminalEvent} when the run settles; the caller closes the socket on it.
   */
  subscribe(runId: string, listener: RunEventListener): () => void
}

/**
 * Fail every run a prior process death left non-terminal. Run once at startup: a `running` or
 * `pending` run cannot have a live runner behind it after a restart, and a partial leaderboard run is
 * never silently resumed (the operator re-runs). This mirrors Stage 5's startup recovery but chooses
 * fail-closed for the heavier workflow. Returns how many runs were failed.
 */
export async function reconcileInterruptedRuns(
  storage: Storage,
  log: (message: string) => void = () => {},
): Promise<number> {
  const stranded = [
    ...(await storage.listRunsByStatus('running')),
    ...(await storage.listRunsByStatus('pending')),
  ]
  for (const run of stranded) {
    await storage.setRunStatus(
      run.id,
      'failed',
      'reconciled: backend restarted while the run was in progress',
    )
  }
  if (stranded.length > 0) {
    log(`reconciled ${stranded.length} interrupted workflow run(s) to failed`)
  }
  return stranded.length
}

/**
 * The Stage 6.3 placeholder runner wired into the live process until Stage 6.4 lands the Docker-backed
 * one. It accepts enqueues (the run stays `pending` — nothing executes yet), marks a cancel request
 * `cancelled` so the gate is real, and emits no live events. Every admin route works end to end against
 * it; only the actual container execution is absent.
 */
export function createPlaceholderRunner(
  storage: Storage,
  log: (message: string) => void = () => {},
): WorkflowRunner {
  return {
    enqueue(runId: string): void {
      log(
        `workflow runner not yet implemented (Stage 6.4): run ${runId} persisted and left pending; no containers launched`,
      )
    },
    cancel(runId: string): void {
      void storage
        .setRunStatus(runId, 'cancelled', 'cancelled by operator')
        .catch((error) => log(`run ${runId}: cancel failed: ${String(error)}`))
    },
    subscribe(): () => void {
      return () => {}
    },
  }
}
