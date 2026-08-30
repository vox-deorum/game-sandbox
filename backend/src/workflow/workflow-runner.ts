/**
 * The Docker-backed {@link WorkflowRunner} (Stage 6.4): the background engine that takes a triggered,
 * `pending` run and executes its persisted schedule one container at a time on this host.
 *
 * It is the second caller of the Stage 3 execution driver. Where the live session is browser-attached
 * and human-paced, this is **headless run-to-completion**: each scheduled game launches one container
 * through the shared launch-config seam ({@link assembleLaunch}), the runner drains its stdout protocol
 * (the recording, tee'd live, plus the final `result` envelope) and its stderr diagnostics, waits for
 * the container to exit, then attributes each seat: the `result` envelope is the only source of final
 * scores, while the recording it produced supplies the per-tick compute timing. An envelope that does
 * not cover every resolved player forfeits the whole game rather than leaving a partial result.
 * No socket, no human timeout, no relay. The container drives itself to its episode's end and exits.
 *
 * For each game the runner: registers the produced recording (owned by the seat's natural owner) and
 * attaches its id; writes one `game_results` row per participating seat with the normalized episode
 * score plus the aggregated agent compute time and acted-tick count; and advances the game's status.
 * A single agent crash or timeout marks that game `failed`/`timed_out` and flags the seat, but never
 * aborts the remaining scheduled games. A container that never yields a readable recording header, or
 * exits cleanly without a recognized `result` envelope, is an infrastructure fault: the game is marked
 * `failed` with no invented result row. Between games the
 * runner checks a cooperative cancel flag; on cancel it stops scheduling, tears down any in-flight
 * container, and settles the run `cancelled`. Runs execute one at a time (single host), so two never
 * interleave on the box.
 *
 * Live progress is relayed to the admin WebSocket stream as {@link RunEvent}s: a game-started log line,
 * the container's diagnostic lines, a game-finished line, each game's status transition, and the run's
 * terminal verdict. The stream is live-only; persisted per-game statuses cover a late subscriber.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyOutbound,
  type ParsedRecording,
  RESULT_KIND,
  readRecording,
} from '@game-sandbox/schema'
import {
  type ParameterValue,
  resolveLayout,
  validateCompleteParameters,
} from '@game-sandbox/schema/environment'
import type { UserDirectory } from '../auth/users.js'
import type { ImagePolicy, SandboxDefaults } from '../config/config.js'
import type { ExecutionDriver, ExitInfo, ImageRef, SessionProcess } from '../driver/index.js'
import { buildSandboxProfile, sandboxResourcesForPlayers } from '../driver/sandbox.js'
import { resolveSeasonRules, type SeasonRules } from '../environments/parameters.js'
import type { EnvironmentMeta, EnvironmentRegistry } from '../environments/registry.js'
import { forfeitScore, normalizeEpisodeScore } from '../leaderboards/score.js'
import { decodeResolvedOfficialLlmPolicy, type ResolvedOfficialLlmPolicy } from '../llm/config.js'
import { type LlmModelConfig, MODEL_ALIASES, type ModelAlias } from '../llm/types.js'
import { appLog } from '../logging/log-buffer.js'
import { sessionRecordingsScopeDir, settleSessionRecording } from '../recordings/settle.js'
import { createChargeableTimer } from '../session/chargeable-timer.js'
import {
  assembleLaunch,
  type LlmKeysFileConfig,
  type SeatBinding,
} from '../session/launch-config.js'
import { ensureRecordingsDir } from '../session/live-session.js'
import { LlmLeaseHandle } from '../session/llm-lease.js'
import type { OfficialGrantIssuer, OfficialGrantLease } from '../session/official-grants.js'
import { coerceResultReason } from '../session/result-reason.js'
import { decodeSeasonConfig, type LlmUsageByModel, type Storage } from '../storage/index.js'
import type { ExecutionTelemetryStore, ExecutionUsageByModel } from '../storage/llm/index.js'
import {
  type AgentRef,
  AgentRefArraySchema,
  type SeasonRun,
  type SeasonRunGame,
} from '../storage/schema.js'
import type { SubmissionSnapshotStore } from '../submission/snapshot-store.js'
import type { SubmissionSource } from '../submission/source/index.js'
import {
  resolveSubmissionLaunchImage,
  type SessionImageSeat,
  submissionSeatPath,
} from '../submission/submission-image.js'
import { optionalField } from '../util/optional-field.js'
import {
  aggregatePlayer,
  failAllSeats,
  type PlayerResult,
  reducePlayersToSeats,
  type SeatResult,
} from './aggregate.js'
import type {
  RunEvent,
  RunEventListener,
  RunLogLevel,
  TerminalRunStatus,
  WorkflowRunner,
} from './runner.js'

/** Where the recordings volume is mounted inside every match container (lockstep with the harness). */
const CONTAINER_RECORDINGS_DIR = '/recordings'
/** Grace given to an in-flight container to stop politely before the driver hard-kills it (cancel). */
export const DEFAULT_KILL_GRACE_MS = 5_000
/** Extra wall-clock slack over the episode compute budget before a workflow game is killed. */
const DEFAULT_GAME_WATCHDOG_GRACE_MS = 5_000

/** Everything the Docker-backed runner needs, injected so a fake driver + `:memory:` storage drive it. */
export interface WorkflowRunnerDeps {
  driver: ExecutionDriver
  storage: Storage
  environments: EnvironmentRegistry
  /** The submission-source seam, the fallback to refetch a pre-snapshot submission when rebuilding its overlay. */
  source: SubmissionSource
  /** The snapshot store an overlay rebuild materializes the submission tree from when its image was evicted. */
  snapshots: SubmissionSnapshotStore
  /** The sandbox quotas each match container runs under, the same profile shape sessions use. */
  sandbox: SandboxDefaults
  /** The recordings volume root, mounted into each match container and read back after it exits. */
  recordingsDir: string
  /**
   * The host directory staging per-game LLM keys files, mounted read-only into matches. Defaults to
   * a process-scoped temp directory (used by tests) when a deployment does not pin it.
   */
  llmKeysDir?: string
  /** The driver's reuse-vs-rebuild policy, threaded into overlay resolution. */
  imagePolicy: ImagePolicy
  /** Internal proxy port emitted into the shared harness launch block. */
  llmInternalPort?: number
  /** Issues one temporary official key per workflow agent player. */
  officialGrantIssuer?: OfficialGrantIssuer
  /** Reads successful calls from the run-scoped execution telemetry file after grant teardown. */
  officialTelemetry?: Pick<ExecutionTelemetryStore, 'aggregateByModel'> &
    Partial<Pick<ExecutionTelemetryStore, 'deleteScope'>>
  /** Grace before a cancelled run's in-flight container is hard-killed. */
  killGraceMs?: number
  /** Extra chargeable-wall-clock slack over the effective episode timeout before a game is killed. */
  gameWatchdogGraceMs?: number
  /**
   * The display-name directory the recording-header attribution snapshots names through at launch.
   * Optional: without it (or for an id with no row) every label falls back to the stable id.
   */
  userDirectory?: UserDirectory
  /**
   * Called once a run settles to a terminal status, so step 5 can recompute the board and retention
   * can sweep. The runner awaits the hook before emitting the terminal event, so dependent snapshots
   * settle before subscribers learn the run is done.
   */
  onRunComplete?: (runId: string, status: TerminalRunStatus) => Promise<void> | void
}

/** The `result` envelope the harness emits once at episode end, as the runner reads it back. */
export interface ResultEnvelope {
  reason: string | null
  scores: Record<string, number>
  /**
   * The one seat a failure is chargeable to: the player whose agent raised, or whose own per-episode
   * budget overran. `null` for a clean episode. Container-level faults are classified from the process
   * outcome, not this potentially stale envelope field.
   */
  failedPlayer: string | null
  /** A present `failed_player` must be a string or null. Other values invalidate the envelope. */
  failedPlayerMalformed: boolean
}

/** How a finished game's container fared: a clean episode, a crashed agent, or a timed-out agent. */
export type FailureKind = 'crash' | 'timeout' | null

/**
 * Create the Docker-backed workflow runner. Runs execute sequentially through an in-process queue
 * (single host); `enqueue` returns immediately and the run advances out of band.
 */
export function createWorkflowRunner(deps: WorkflowRunnerDeps): WorkflowRunner {
  return new DockerWorkflowRunner(deps)
}

class DockerWorkflowRunner implements WorkflowRunner {
  private readonly killGraceMs: number
  private readonly gameWatchdogGraceMs: number

  /** Run ids waiting to execute; drained one at a time so two runs never share the host. */
  private readonly queue: string[] = []
  private pumpPromise: Promise<void> | null = null
  private stopping = false
  private shutdownPromise: Promise<void> | null = null
  private activeRunId: string | null = null
  /** Runs an operator asked to cancel; checked cooperatively between and during games. */
  private readonly cancelRequested = new Set<string>()
  /** The in-flight container per run, so a cancel can tear it down mid-game. */
  private readonly inFlight = new Map<string, SessionProcess>()
  private readonly inFlightLlm = new Map<string, OfficialGrantLease>()
  /** Share teardown across natural exit, cancel, and watchdog paths so Docker cleanup runs once. */
  private readonly processCleanup = new WeakMap<SessionProcess, Promise<void>>()
  /** Live event subscribers per run (the admin log stream). */
  private readonly listeners = new Map<string, Set<RunEventListener>>()

  constructor(private readonly deps: WorkflowRunnerDeps) {
    this.killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    this.gameWatchdogGraceMs = deps.gameWatchdogGraceMs ?? DEFAULT_GAME_WATCHDOG_GRACE_MS
  }

  /** The keys-file staging root; tests without an explicit dir get a process-scoped temp path. */
  private llmKeysDir(): string {
    if (this.deps.llmKeysDir !== undefined) {
      return this.deps.llmKeysDir
    }
    return join(tmpdir(), `gs-llm-keys-${process.pid}`)
  }

  /** This game's isolated recordings directory, mounted into its container and settled afterward. */
  private sessionRecordingsDir(scope: string): string {
    return sessionRecordingsScopeDir(this.deps.recordingsDir, scope)
  }

  enqueue(runId: string): void {
    if (this.stopping) throw new Error('workflow runner is shutting down')
    this.queue.push(runId)
    this.pumpPromise ??= this.pump()
  }

  cancel(runId: string): void {
    this.cancelRequested.add(runId)
    // Best-effort teardown starts as soon as either resource exists. A grant lease is registered before
    // launch, so cancellation can close admission while the driver is still resolving the process.
    const llmLease = this.inFlightLlm.get(runId)
    const process = this.inFlight.get(runId)
    if (llmLease !== undefined || process !== undefined) {
      void (async (): Promise<void> => {
        await llmLease?.revoke()
        if (process !== undefined) await this.cleanupProcess(process)
      })().catch((error) =>
        appLog('workflow', `run ${runId}: cancel teardown failed: ${String(error)}`, 'error'),
      )
    }
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownOnce()
    return this.shutdownPromise
  }

  private async shutdownOnce(): Promise<void> {
    this.stopping = true
    // Queued rows remain pending for startup reconciliation; only already-started work needs teardown.
    this.queue.length = 0
    if (this.activeRunId !== null) this.cancelRequested.add(this.activeRunId)
    await Promise.all([...this.inFlightLlm.values()].map((lease) => lease.revoke()))
    await Promise.all([...this.inFlight.values()].map((process) => this.cleanupProcess(process)))
    await this.pumpPromise
  }

  subscribe(runId: string, listener: RunEventListener): () => void {
    let set = this.listeners.get(runId)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(runId, set)
    }
    set.add(listener)
    return (): void => {
      set?.delete(listener)
    }
  }

  /** Drain the queue one run at a time. */
  private async pump(): Promise<void> {
    try {
      for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) {
        this.activeRunId = next
        // Nothing awaits the pump during normal operation, so a throw here (e.g. a storage read
        // failing before executeRun's own try) would be an unhandled rejection that kills the
        // process and drops the rest of the queue. Contain it to the one run and keep draining.
        try {
          await this.executeRun(next)
        } catch (error) {
          appLog(
            'workflow',
            `run ${next}: execution failed outside run handling: ${String(error)}`,
            'error',
          )
        }
      }
    } finally {
      this.activeRunId = null
      // The pump owns its idle transition. Clearing the marker here, in the same turn that observed
      // the empty queue, ensures a later enqueue starts a replacement pump instead of attaching work
      // to a promise whose external cleanup callback has not run yet.
      this.pumpPromise = null
    }
  }

  /** Emit one event to every current subscriber of a run. */
  private emit(runId: string, event: RunEvent): void {
    for (const listener of this.listeners.get(runId) ?? []) {
      try {
        listener(event)
      } catch {
        // A throwing subscriber must not take the run down; the socket layer owns its own errors.
      }
    }
  }

  /** Settle a run to a terminal status: persist it, run the completion hook, and emit terminal. */
  private async finishRun(runId: string, status: TerminalRunStatus, error?: string): Promise<void> {
    await this.deps.storage.setRunStatus(runId, status, error).catch((cause) => {
      appLog('workflow', `run ${runId}: setRunStatus(${status}) failed: ${String(cause)}`, 'error')
    })
    this.cancelRequested.delete(runId)
    this.inFlight.delete(runId)
    await this.cleanupUnusedRunScope(runId)
    try {
      await this.deps.onRunComplete?.(runId, status)
    } catch (cause) {
      appLog('workflow', `run ${runId}: completion hook failed: ${String(cause)}`, 'error')
    }
    this.emit(runId, { type: 'terminal', status })
  }

  private async cleanupUnusedRunScope(runId: string): Promise<void> {
    const deleteScope = this.deps.officialTelemetry?.deleteScope
    if (deleteScope === undefined) return
    try {
      const recordings = await this.deps.storage.listRecordings()
      if (!recordings.some((recording) => recording.llm_scope_id === runId)) {
        deleteScope.call(this.deps.officialTelemetry, runId)
      }
    } catch (error) {
      // Fail safe: an uncertain association leaves the scope for startup recovery.
      appLog(
        'workflow',
        `run ${runId}: deleting unused LLM scope failed: ${String(error)}`,
        'error',
      )
    }
  }

  /**
   * Execute one persisted run end to end: mark it running, drive each scheduled game in order, and
   * settle the run. A cancel between or during games stops the schedule and settles `cancelled`. An
   * unexpected throw fails the run rather than leaving it stuck running.
   */
  private async executeRun(runId: string): Promise<void> {
    const run = await this.deps.storage.getRun(runId)
    if (run === undefined) {
      appLog('workflow', `run ${runId}: vanished before execution; nothing to do`, 'warn')
      this.cancelRequested.delete(runId)
      return
    }
    if (run.status !== 'pending') {
      // Reconcile or a prior pass already settled it; do not re-run.
      appLog('workflow', `run ${runId}: not pending (${run.status}); skipping`, 'info')
      this.cancelRequested.delete(runId)
      return
    }
    if (this.cancelRequested.has(runId)) {
      await this.finishRun(runId, 'cancelled', 'cancelled by operator before execution started')
      return
    }

    try {
      const season = await this.deps.storage.getSeason(run.season_id)
      if (season === undefined) {
        await this.finishRun(runId, 'failed', 'the season was deleted before the run started')
        return
      }
      const meta = this.deps.environments.get(season.env_id)
      if (meta === undefined) {
        await this.finishRun(runId, 'failed', `unknown environment ${season.env_id}`)
        return
      }
      const config = decodeSeasonConfig(run.config_snapshot)
      const llmPolicy = decodeResolvedOfficialLlmPolicy(run.llm_policy_snapshot)
      const seasonRules = resolveSeasonRules(meta, config.overrides, llmPolicy.enabled).rules
      const resolvedParameters = validateCompleteParameters(
        meta.parameters,
        run.parameters_snapshot,
      )
      if (resolvedParameters.issues.length > 0) {
        throw new Error(
          `invalid frozen parameter snapshot: ${resolvedParameters.issues[0]?.name} ${resolvedParameters.issues[0]?.message}`,
        )
      }
      const layout = resolveLayout(meta, resolvedParameters.values)
      const games = await this.deps.storage.listRunGames(runId)
      const preparedGames: Array<{ game: SeasonRunGame; seats: AgentRef[] }> = []

      // These checks read only run-level facts: every game shares this layout, and the schedule
      // stamped one plan key across all of them. Settle them before the run is marked running and
      // before any container starts, rather than repeating the same fault on every game.
      for (const game of games) {
        const seats = parseStoredSeats(game.seats)
        if (
          game.seat_plan !== layout.planKey ||
          seats === null ||
          seats.length !== layout.seatCount
        ) {
          await this.finishRun(
            runId,
            'failed',
            `game ${game.game_index}: stored assignment does not match the resolved seat layout`,
          )
          return
        }
        preparedGames.push({ game, seats })
      }
      // Derive the watchdog once per run so every game uses the same effective bound.
      const watchdogMs = gameWatchdogMs(
        seasonRules.episode_timeout_ms,
        layout.playerCount,
        this.gameWatchdogGraceMs,
      )

      await this.deps.storage.setRunStatus(runId, 'running')
      await ensureRecordingsDir(this.deps.recordingsDir)

      for (const { game, seats } of preparedGames) {
        if (this.cancelRequested.has(runId)) {
          await this.markGameCancelled(runId, game)
          continue
        }
        await this.runGame(
          run,
          meta,
          config.deps_version,
          seasonRules,
          resolvedParameters.values,
          layout,
          llmPolicy,
          watchdogMs,
          game,
          seats,
        )
      }

      if (this.cancelRequested.has(runId)) {
        await this.finishRun(runId, 'cancelled', 'cancelled by operator')
        return
      }
      await this.finishRun(runId, 'completed')
    } catch (error) {
      appLog('workflow', `run ${runId}: unexpected failure: ${String(error)}`, 'error')
      await this.finishRun(runId, 'failed', `run failed: ${errorText(error)}`)
    }
  }

  /** Mark a not-yet-started game cancelled when the run was cancelled before it ran. */
  private async markGameCancelled(runId: string, game: SeasonRunGame): Promise<void> {
    await this.deps.storage.setRunGameStatus(game.id, 'cancelled')
    this.emit(runId, { type: 'game_status', game_index: game.game_index, status: 'cancelled' })
  }

  /**
   * Run one scheduled game: resolve its image, launch the headless container, capture its recording
   * stream and diagnostics, wait for exit, then attribute the outcome. Infrastructure faults mark the
   * game `failed` with no result row; an attributable agent crash/timeout flags the seat and game.
   */
  private async runGame(
    run: SeasonRun,
    meta: EnvironmentMeta,
    depsVersion: number,
    seasonRules: SeasonRules,
    parameters: Record<string, ParameterValue>,
    layout: ReturnType<typeof resolveLayout>,
    llmPolicy: ResolvedOfficialLlmPolicy,
    watchdogMs: number,
    game: SeasonRunGame,
    seats: readonly AgentRef[],
  ): Promise<void> {
    const runId = run.id
    const envId = meta.env_id
    await this.deps.storage.setRunGameStatus(game.id, 'running')
    this.emit(runId, { type: 'game_status', game_index: game.game_index, status: 'running' })
    this.gameLog(
      runId,
      game,
      `game ${game.game_index} started: seed ${game.seed}, ${describeSeats(seats)}`,
    )

    // Resolve the launch image: the one submission seat's overlay, or the base image for an all-built-in
    // game. An image-resolution failure is an infrastructure fault, not an agent fault.
    let image: ImageRef
    try {
      image = await this.resolveImage(seats, layout, depsVersion)
    } catch (error) {
      await this.infraFault(runId, game, `image resolution failed: ${errorText(error)}`)
      return
    }
    if (this.cancelRequested.has(runId)) {
      // A composed session-overlay image is single-use; a cancel landing in the window after the
      // build completed but before launch must not silently leak it. Release it here because the
      // try/finally below (the normal release point) never runs on this path. The driver no-ops on
      // base and per-submission refs, so this is safe for every image kind.
      await this.deps.driver
        .releaseSessionOverlay(image.ref)
        .catch((error) =>
          appLog(
            'workflow',
            `run ${runId} game ${game.id}: releasing composed image failed: ${String(error)}`,
            'error',
          ),
        )
      await this.markGameCancelled(runId, game)
      return
    }

    const recordingId = `${envId}-${game.id}`
    let process: SessionProcess | undefined
    // The lease and its staged keys file are one unit, torn down in a single teardown call: the
    // finally below (and every cancel/error path) can never strand a grant or a key file separately.
    const llmHandle = new LlmLeaseHandle()
    try {
      if (llmPolicy.enabled) {
        // A missing issuer or port is a deployment-wide misconfiguration: fail the run, not one
        // game after another. A grant-issuance throw, by contrast, is a per-scope storage fault
        // (a locked or corrupt telemetry file) and is classified like every other infra fault: the
        // game fails, the rest of the schedule continues.
        if (
          this.deps.officialGrantIssuer === undefined ||
          this.deps.llmInternalPort === undefined ||
          this.deps.officialTelemetry === undefined
        ) {
          throw new Error(
            'official workflow LLM grants, telemetry, and internal proxy port are not configured',
          )
        }
        try {
          const lease = await llmHandle.stage(
            this.deps.officialGrantIssuer,
            {
              sessionId: game.id,
              scopeId: runId,
              agentPlayers: layout.seats.flatMap((seat) => seat.players),
              models: policyModels(llmPolicy),
              limits: policyLimits(llmPolicy),
            },
            this.llmKeysDir(),
            game.id,
          )
          this.inFlightLlm.set(runId, lease)
        } catch (error) {
          await llmHandle.teardown()
          await this.infraFault(runId, game, `LLM grant issuance failed: ${errorText(error)}`)
          return
        }
        if (this.cancelRequested.has(runId)) {
          await llmHandle.teardown()
          await this.markGameCancelled(runId, game)
          return
        }
      }
      const llmBlock = llmHandle.block(this.deps.llmInternalPort as number)
      const sessionConfig = await this.sessionConfig(
        meta,
        game.seed,
        seats,
        recordingId,
        seasonRules,
        parameters,
        layout,
        llmBlock,
      )
      if (this.cancelRequested.has(runId)) {
        await llmHandle.teardown()
        await this.markGameCancelled(runId, game)
        return
      }

      try {
        // Each game mounts only its own recordings directory (see settle.ts), so one game's
        // container cannot read or overwrite another's; the recording is promoted into the shared
        // flat store after the game exits (settled below).
        await ensureRecordingsDir(this.sessionRecordingsDir(game.id))
        process = await this.deps.driver.launch({
          image,
          argv: [JSON.stringify(sessionConfig)],
          sandbox: buildSandboxProfile(
            sandboxResourcesForPlayers(this.deps.sandbox, layout.playerCount),
            llmHandle.withKeysMount([
              {
                hostPath: this.sessionRecordingsDir(game.id),
                containerPath: CONTAINER_RECORDINGS_DIR,
                readOnly: false,
              },
            ]),
            llmPolicy.enabled ? 'llm' : 'none',
          ),
          sessionId: game.id,
        })
      } catch (error) {
        // Covers both a rejected sandbox quota (derived above) and a driver that could not start the
        // container, so the message names the launch rather than the container specifically.
        await this.infraFault(runId, game, `container launch failed: ${errorText(error)}`)
        return
      }
      this.inFlight.set(runId, process)
      // A cancel that landed before `inFlight.set` found no process to kill, so re-check and kill
      // here. Deliberately no early return: execution continues into the shared drain/exit path
      // below, and the post-exit cancel check records the game `cancelled`. Revoke and cleanup are
      // memoized, so the repeated calls on that path are no-ops.
      if (this.cancelRequested.has(runId)) {
        await llmHandle.teardown()
        await this.cleanupProcess(process)
      }
      const watchdog = this.startGameWatchdog(runId, game, process, watchdogMs, llmHandle.lease)

      // Drain stderr as live log lines, and stdout for the recording stream and the final result
      // envelope. Both must finish before the recording is read so no line is missed.
      const diagnostics = (async (): Promise<void> => {
        try {
          for await (const line of process.diagnostics) {
            this.gameLog(runId, game, line)
          }
        } catch {
          // Diagnostics ending early is harmless; the game's fate is decided by stdout and exit.
        }
      })()
      const recordingLines: string[] = []
      // A holder (not a bare `let`) so reading it back after the await keeps its declared type. TS does
      // not narrow a closure-mutated local and would otherwise see it as forever-null here.
      const captured: { result: ResultEnvelope | null } = { result: null }
      const stdout = (async (): Promise<void> => {
        try {
          for await (const raw of process.output) {
            const line = classifyOutbound(raw)
            if (line.type === 'recording') {
              recordingLines.push(line.raw)
            } else if (line.type === 'envelope' && line.kind === RESULT_KIND) {
              captured.result = parseResultEnvelope(line.value)
            }
          }
        } catch (error) {
          appLog(
            'workflow',
            `run ${runId} game ${game.game_index}: output stream error: ${String(error)}`,
            'error',
          )
        }
      })()

      const exit = await process.exited
      watchdog.stop()
      await stdout
      await diagnostics
      await llmHandle.teardown()
      // Natural exit only reports termination for an LLM container. Revoke and drain before this
      // explicit cleanup disconnects the relay and removes the two per-session networks.
      await this.cleanupProcess(process)
      this.inFlight.delete(runId)
      this.inFlightLlm.delete(runId)

      // A cancel that killed this container mid-game: record the cancellation, not a failure or result.
      if (this.cancelRequested.has(runId)) {
        await this.deps.storage.setRunGameStatus(game.id, 'cancelled')
        this.emit(runId, { type: 'game_status', game_index: game.game_index, status: 'cancelled' })
        this.gameLog(runId, game, `game ${game.game_index} cancelled`, 'warning')
        return
      }

      // No readable recording header means an infrastructure fault. No invented result row.
      let parsed: ParsedRecording
      try {
        parsed = readRecording(recordingLines)
      } catch {
        await this.infraFault(
          runId,
          game,
          `game produced no readable recording (container exit code ${exit.code})`,
        )
        return
      }

      // A container that exits cleanly yet never emits a recognized `result` envelope reason violated its
      // output contract: the envelope is authoritative for the final scores, so without it there is
      // nothing trustworthy to attribute. Treat it as an infrastructure fault rather than inventing a
      // `terminated` ending and a standings card built from stale recording scores. A non-clean exit
      // (crash, OOM, or watchdog kill) is classified below from the exit itself and needs no envelope.
      const resolvedPlayerIds = layout.seats.flatMap((seat) => seat.players)
      const attribution = resolveFailureAttribution(
        exit,
        captured.result,
        watchdog.timedOut(),
        resolvedPlayerIds,
      )
      const status = attribution.status

      // The revocation barrier above closed admission and awaited every request finalizer. Read every
      // seat from the shared run scope before writing any per-seat result, so all results describe the
      // same settled telemetry state and no delayed successful write can land after aggregation.
      const llmUsageByPlayer = new Map<string, LlmUsageByModel | null>()
      if (llmPolicy.enabled) {
        const telemetry = this.deps.officialTelemetry
        if (telemetry === undefined) {
          throw new Error('official workflow LLM telemetry is not configured')
        }
        for (const playerId of resolvedPlayerIds) {
          llmUsageByPlayer.set(
            playerId,
            storedLlmUsage(
              telemetry.aggregateByModel(runId, { sessionId: game.id, player: playerId }),
            ),
          )
        }
      }

      // Register the produced recording (owned by the seat's natural owner) and link it to the game.
      // An automated run has no producing session, so the recording carries its own termination reason
      // for the replay viewer's game-over card. Only a cleanly completed game gets one, taken from its
      // recognized result-envelope reason (a clean exit lacking one was already faulted above, so we
      // never invent a reason); a crashed or timed-out game stays reasonless so its replay shows no final
      // standings, mirroring a live session that ended badly.
      const owner = recordingOwner(seats, run.requested_by)
      // Publish the game association before its recording row. Retention can then recognize the
      // active workflow in the first instant the row exists, including for non-LLM recordings that
      // have no execution-scope id of their own.
      await this.deps.storage.attachRunGameRecording(game.id, recordingId)
      await this.deps.storage
        .createRecording({
          id: recordingId,
          user_id: owner,
          env_id: envId,
          created_at: new Date().toISOString(),
          termination_reason:
            status === 'completed' ? coerceResultReason(captured.result?.reason) : null,
          llm_scope_id: llmPolicy.enabled ? runId : null,
          llm_session_id: llmPolicy.enabled ? game.id : null,
        })
        .catch((error) =>
          appLog('workflow', `run ${runId}: createRecording failed: ${String(error)}`, 'error'),
        )

      const pricedModels = policyModels(llmPolicy)
      const playerResults: PlayerResult[] = resolvedPlayerIds.map((playerId) => {
        const aggregate = aggregatePlayer(parsed.states, playerId)
        const usage = llmUsageByPlayer.get(playerId) ?? null
        const culprit = attribution.scope === 'attributed' ? attribution.culprit : null
        const failed = culprit?.playerId === playerId
        return {
          playerId,
          // Zero under `all-failed`: every seat takes the forfeit floor below, so the value is unused.
          episodeScore:
            attribution.scope === 'attributed' ? (attribution.scores[playerId] ?? 0) : 0,
          agentComputeMsTotal: aggregate.agentComputeMsTotal,
          actedTickCount: aggregate.actedTickCount,
          llmUsageByModel: usage,
          llmWeightedCost: weightedCostOf(usage, pricedModels),
          failed,
          failureReason: failed ? (culprit?.reason ?? null) : null,
        }
      })
      const reduced = reducePlayersToSeats(layout, playerResults)
      const seatResults =
        attribution.scope === 'attributed' ? reduced : failAllSeats(reduced, attribution.gameReason)
      for (let seatIndex = 0; seatIndex < seatResults.length; seatIndex++) {
        const result = seatResults[seatIndex] as SeatResult
        const agent = seats[seatIndex] as AgentRef
        const episodeScore = result.failed
          ? forfeitScore(envId)
          : normalizeEpisodeScore(envId, result.episodeScore)
        await this.deps.storage.recordGameResult({
          game_id: game.id,
          seat_index: seatIndex,
          agent,
          episode_score: episodeScore,
          agent_compute_ms_total: result.agentComputeMsTotal,
          acted_tick_count: result.actedTickCount,
          llm_usage_by_model: result.llmUsageByModel,
          llm_weighted_cost: result.llmWeightedCost,
          failed: result.failed,
          failure_reason: result.failureReason,
        })
      }

      await this.deps.storage.setRunGameStatus(game.id, status, attribution.gameReason ?? undefined)
      this.emit(runId, { type: 'game_status', game_index: game.game_index, status })
      const level: RunLogLevel =
        status === 'completed' ? 'success' : status === 'timed_out' ? 'warning' : 'error'
      this.gameLog(
        runId,
        game,
        `game ${game.game_index} finished: ${status}${
          attribution.gameReason === null ? '' : ` (${attribution.gameReason})`
        }`,
        level,
      )
    } finally {
      try {
        await llmHandle.teardown()
      } finally {
        if (process !== undefined) await this.cleanupProcess(process)
        this.inFlight.delete(runId)
        this.inFlightLlm.delete(runId)
      }
      // Promote the game's recording out of its isolated session directory into the shared flat
      // store on every exit path (natural, cancelled, or error), then drop the empty session dir.
      await settleSessionRecording(this.deps.recordingsDir, game.id, recordingId).catch((error) =>
        appLog(
          'workflow',
          `run ${runId} game ${game.id}: settling recording failed: ${String(error)}`,
          'error',
        ),
      )
      // The container is gone, so a composed session-overlay image has served its single purpose.
      // Release it best-effort (the driver no-ops on base and per-submission refs; the eviction
      // sweep remains the backstop if this fails or never runs).
      await this.deps.driver
        .releaseSessionOverlay(image.ref)
        .catch((error) =>
          appLog(
            'workflow',
            `run ${runId} game ${game.id}: releasing composed image failed: ${String(error)}`,
            'error',
          ),
        )
    }
  }

  /** Kill a game container if it exceeds its bounded chargeable-wall-clock allowance. */
  private startGameWatchdog(
    runId: string,
    game: SeasonRunGame,
    process: SessionProcess,
    timeoutMs: number,
    llmLease?: OfficialGrantLease,
  ): { timedOut: () => boolean; stop: () => void } {
    return createChargeableTimer({
      budgetMs: timeoutMs,
      inFlightMs: llmLease?.blockingInFlightMs,
      source: 'workflow',
      context: `run ${runId} game ${game.game_index}`,
      onExpire: () => {
        this.gameLog(
          runId,
          game,
          `game ${game.game_index} exceeded chargeable-wall-clock watchdog (${timeoutMs} ms); killing container`,
          'warning',
        )
        void (async (): Promise<void> => {
          await llmLease?.revoke()
          await this.cleanupProcess(process)
        })().catch((error) => {
          appLog(
            'workflow',
            `run ${runId} game ${game.game_index}: watchdog teardown failed: ${String(error)}`,
            'error',
          )
        })
      },
    })
  }

  private cleanupProcess(process: SessionProcess): Promise<void> {
    let cleanup = this.processCleanup.get(process)
    if (cleanup === undefined) {
      cleanup = process.kill(this.killGraceMs)
      this.processCleanup.set(process, cleanup)
    }
    return cleanup
  }

  /**
   * Resolve the launch image: the season-pinned base image when no player is a submission, or, through
   * the shared resolver, a single submission's warm overlay or a composed multi-submission session
   * image. Sharing the single-versus-composed decision with the live orchestrator is what keeps a
   * multi-submission matchup game (the Hearts scheduler's ordered seatings) from baking only the first
   * seat's overlay, which would leave the other submitted seats with no code to load.
   */
  private async resolveImage(
    seats: readonly AgentRef[],
    layout: ReturnType<typeof resolveLayout>,
    depsVersion: number,
  ): Promise<ImageRef> {
    const composed: SessionImageSeat[] = []
    for (let i = 0; i < seats.length; i++) {
      const agent = seats[i] as AgentRef
      if (agent.kind === 'submission') {
        const submission = await this.deps.storage.getSubmission(agent.submission_id)
        if (submission === undefined) {
          throw new Error(`submission ${agent.submission_id} no longer exists`)
        }
        const seat = layout.seats[i]
        if (seat === undefined) throw new Error(`missing resolved seat ${i}`)
        composed.push({ seatId: seat.seatId, submission })
      }
    }
    if (composed.length === 0) {
      return this.deps.driver.ensureImage({ kind: 'session-base', depsVersion })
    }
    return resolveSubmissionLaunchImage(
      {
        driver: this.deps.driver,
        snapshots: this.deps.snapshots,
        source: this.deps.source,
        imagePolicy: this.deps.imagePolicy,
      },
      composed,
      depsVersion,
    )
  }

  /** Build the headless session config: every player an agent, no human source, recording to the volume. */
  private async sessionConfig(
    meta: EnvironmentMeta,
    seed: number,
    assignedSeats: readonly AgentRef[],
    recordingId: string,
    seasonRules: SeasonRules,
    parameters: Record<string, ParameterValue>,
    layout: ReturnType<typeof resolveLayout>,
    llmBlock: LlmKeysFileConfig | Record<string, never>,
  ): Promise<Record<string, unknown>> {
    // Snapshot each submission owner's display name for the recording header at launch time, one
    // batched lookup. Names are cosmetic — the label falls back to the stable id — so a directory
    // failure degrades to ids rather than aborting the game.
    const names = await this.snapshotNames(assignedSeats)
    const seats = new Map<string, SeatBinding>()
    for (let i = 0; i < assignedSeats.length; i++) {
      const agent = assignedSeats[i] as AgentRef
      const resolvedSeat = layout.seats[i]
      if (resolvedSeat === undefined) throw new Error(`missing resolved seat ${i}`)
      if (agent.kind === 'submission') {
        seats.set(resolvedSeat.seatId, {
          driver: 'submission',
          submissionId: agent.submission_id,
          userId: agent.user_id,
          path: submissionSeatPath(resolvedSeat.seatId),
          ...optionalField('ownerName', names.get(agent.user_id)),
        })
      } else {
        const builtin = meta.builtin_agents.find((candidate) => candidate.name === agent.name)
        if (builtin === undefined) {
          throw new Error(`environment ${meta.env_id} does not declare built-in ${agent.name}`)
        }
        seats.set(resolvedSeat.seatId, {
          driver: 'builtin',
          name: builtin.name,
          label: builtin.label,
        })
      }
    }
    const { playerBindings, players } = assembleLaunch(seats, layout)
    return {
      env_id: meta.env_id,
      seed,
      player_bindings: playerBindings,
      // No human players in a workflow match, so there is no human-player timeout to resolve.
      ...optionalField('human_timeout_ms', meta.stepping === 'simultaneous' ? undefined : null),
      recording_dir: CONTAINER_RECORDINGS_DIR,
      recording_id: recordingId,
      parameters,
      headless: true,
      players,
      ...llmBlock,
      step_timeout_ms: seasonRules.step_timeout_ms,
      episode_timeout_ms: seasonRules.episode_timeout_ms,
      messaging_enabled: seasonRules.messaging_enabled,
      message_cap: seasonRules.message_cap,
    }
  }

  /**
   * Batch the submission owners' display names for the recording header at launch. A missing directory,
   * or a lookup that throws, degrades to no names so a headless game is never failed over a cosmetic
   * name resolution; the labels fall back to the stable ids.
   */
  private async snapshotNames(seats: readonly AgentRef[]): Promise<Map<string, string>> {
    if (this.deps.userDirectory === undefined) {
      return new Map()
    }
    try {
      return await this.deps.userDirectory.namesFor(
        seats.flatMap((agent) => (agent.kind === 'submission' ? [agent.user_id] : [])),
      )
    } catch (error) {
      appLog(
        'workflow',
        `workflow-runner: resolving display names failed, falling back to ids: ${String(error)}`,
        'warn',
      )
      return new Map()
    }
  }

  /** Mark a game an infrastructure fault: `failed` with an error, no `game_results` row written. */
  private async infraFault(runId: string, game: SeasonRunGame, reason: string): Promise<void> {
    this.inFlight.delete(runId)
    await this.deps.storage.setRunGameStatus(game.id, 'failed', reason)
    this.emit(runId, { type: 'game_status', game_index: game.game_index, status: 'failed' })
    this.gameLog(runId, game, `game ${game.game_index} failed (infrastructure): ${reason}`, 'error')
  }

  /**
   * Emit one log event for a game, carrying its schedule and match indices, a wall-clock timestamp, and
   * the line's severity for the admin stream. `level` defaults to `info` — the level used for the raw
   * container diagnostics the runner forwards verbatim.
   */
  private gameLog(
    runId: string,
    game: SeasonRunGame,
    line: string,
    level: RunLogLevel = 'info',
  ): void {
    this.emit(runId, {
      type: 'log',
      game_index: game.game_index,
      match_index: game.match_index,
      ts: Date.now(),
      level,
      line,
    })
  }
}

/** Convert the telemetry store's internal camel-case totals into the persisted/public JSON shape. */
function storedLlmUsage(usage: ExecutionUsageByModel): LlmUsageByModel | null {
  for (const model of Object.keys(usage)) {
    if (!MODEL_ALIASES.some((alias) => alias === model)) {
      throw new Error(`execution telemetry contains unsupported model alias ${model}`)
    }
  }
  const stored: LlmUsageByModel = {}
  for (const model of MODEL_ALIASES) {
    const totals = usage[model]
    if (totals === undefined) continue
    stored[model] = {
      calls: totals.calls,
      estimated_calls: totals.estimatedCalls,
      input_tokens: totals.inputTokens,
      reasoning_tokens: totals.reasoningTokens,
      output_tokens: totals.outputTokens,
      latency_ms: totals.latencyMs,
    }
  }
  return Object.keys(stored).length === 0 ? null : stored
}

/** The owner-visible text for a thrown value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Convert frozen snapshot metadata into the generic runtime model configuration. */
function policyModels(
  policy: ResolvedOfficialLlmPolicy,
): Partial<Record<ModelAlias, LlmModelConfig>> {
  const models: Partial<Record<ModelAlias, LlmModelConfig>> = {}
  for (const alias of MODEL_ALIASES) {
    const snapshot = policy.models[alias]
    if (snapshot !== undefined) {
      models[alias] = { upstream: snapshot.model, costWeight: snapshot.cost_weight }
    }
  }
  return models
}

/** Price one settled telemetry aggregate with the same frozen weights used by admission. */
function weightedCostOf(
  usage: LlmUsageByModel | null,
  models: Partial<Record<ModelAlias, LlmModelConfig>>,
): number | null {
  if (usage === null) return null
  let cost = 0
  for (const [alias, modelUsage] of Object.entries(usage) as Array<
    [ModelAlias, NonNullable<LlmUsageByModel[ModelAlias]>]
  >) {
    const model = models[alias]
    if (model === undefined) {
      // Unlike the meter's committed-usage read, which prices a retired alias at the scope's highest
      // weight to keep admission available, a persisted cost is never guessed: the handler only
      // serves aliases granted from this same frozen snapshot, so a mismatch here means the run's
      // records cannot be trusted and the run-level catch fails the whole run.
      throw new Error(`frozen LLM policy has no cost weight for model ${alias}`)
    }
    cost += model.costWeight * (modelUsage.input_tokens + modelUsage.output_tokens)
  }
  if (!Number.isFinite(cost) || cost < 0) {
    throw new Error('workflow LLM weighted cost must be finite and non-negative')
  }
  return cost
}

/** Convert the frozen snapshot's wire spelling into the generic meter limit shape. */
function policyLimits(policy: ResolvedOfficialLlmPolicy): {
  tokenBudget: number
  requestsPerMinute: number
} {
  return {
    tokenBudget: policy.session.token_budget,
    requestsPerMinute: policy.session.rate_limit_rpm,
  }
}

/** A human-readable seat summary for the started-game log line. */
function describeSeats(seats: readonly AgentRef[]): string {
  const labels = seats.map((agent) =>
    agent.kind === 'submission' ? `submission ${agent.submission_id}` : `builtin ${agent.name}`,
  )
  return labels.join(' vs ')
}

/**
 * Decode one stored assignment at the run boundary, rejecting malformed or foreign agent shapes.
 * Unlike `seasons/views.ts`'s `decodeAgentRefs` (the same `z.array(AgentRefSchema)` check over the same
 * kind of stored column), this returns null on failure instead of throwing. That difference is
 * deliberate: `seasons/views.ts` reads trusted storage state a caller already committed to serving, so
 * a decode failure there is a bug worth throwing over; this reads a run's schedule before execution,
 * so a bad column here is funneled into one clean run-level failure (see the caller) rather than an
 * unhandled throw. Do not unify the two policies.
 */
function parseStoredSeats(value: string): AgentRef[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  const result = AgentRefArraySchema.safeParse(parsed)
  return result.success ? result.data : null
}

/** The recording's natural owner: the (single) submission seat's owner, else the run's operator. */
function recordingOwner(seats: readonly AgentRef[], requestedBy: string): string {
  for (const agent of seats) {
    if (agent.kind === 'submission') {
      return agent.user_id
    }
  }
  return requestedBy
}

/** Validate the harness `result` envelope into the fields used for score and fault attribution. */
export function parseResultEnvelope(value: Record<string, unknown>): ResultEnvelope {
  const reason = typeof value.reason === 'string' ? value.reason : null
  const rawFailedPlayer = value.failed_player
  const failedPlayer = typeof rawFailedPlayer === 'string' ? rawFailedPlayer : null
  const failedPlayerMalformed =
    Object.hasOwn(value, 'failed_player') &&
    rawFailedPlayer !== null &&
    typeof rawFailedPlayer !== 'string'
  const scores: Record<string, number> = {}
  const raw = value.scores
  if (typeof raw === 'object' && raw !== null) {
    for (const [playerId, score] of Object.entries(raw)) {
      if (typeof score === 'number') {
        scores[playerId] = score
      }
    }
  }
  return { reason, scores, failedPlayer, failedPlayerMalformed }
}

/**
 * How a finished game's outcome is charged. Either the envelope is trustworthy and the fault (if any)
 * belongs to one named player, or there is no per-player attribution worth keeping and every seat
 * forfeits under one reason.
 */
export type FailureAttribution = {
  /** The game row's terminal status. */
  status: 'completed' | 'failed' | 'timed_out'
  /** The reason stamped on the game row; null only for a clean completion. */
  gameReason: string | null
} & (
  | {
      scope: 'attributed'
      /** One finite score per resolved player, already checked against the layout. */
      scores: Readonly<Record<string, number>>
      /** The one player charged for the fault, or null when the game finished clean. */
      culprit: { playerId: string; reason: string } | null
    }
  | { scope: 'all-failed'; gameReason: string }
)

/**
 * Resolve the scope of a finished game's fault. OOM and watchdog outcomes come from the container, so
 * a result envelope cannot attribute them to a single player. A malformed `failed_player`, an
 * unknown one, or a score map that does not cover every resolved player likewise leaves nothing
 * trustworthy to charge, so the whole game forfeits rather than keeping a partial result.
 *
 * A player is charged only when the process outcome agrees that something failed. An envelope that
 * names a `failed_player` after a clean, recognized ending describes no fault this runner can act on.
 */
export function resolveFailureAttribution(
  exit: ExitInfo,
  result: ResultEnvelope | null,
  watchdogTimedOut: boolean,
  resolvedPlayerIds: readonly string[],
): FailureAttribution {
  const failure = classifyFailure(exit, result, watchdogTimedOut)
  const cleanExit = !watchdogTimedOut && !exit.oomKilled && exit.code === 0
  const reportedScores = result?.scores ?? {}
  // `parseResultEnvelope` already dropped every nonfinite value, so equal key sets is the whole check.
  const validScores =
    resolvedPlayerIds.every((playerId) => Number.isFinite(reportedScores[playerId])) &&
    Object.keys(reportedScores).every((playerId) => resolvedPlayerIds.includes(playerId))
  const reportedFailure = result?.failedPlayer ?? null
  const resultReason = coerceResultReason(result?.reason)
  const containerFault = watchdogTimedOut || exit.oomKilled
  const gameReason = containerFault
    ? failure.reason
    : cleanExit && resultReason === null
      ? `game exited without a valid result envelope (container exit code ${exit.code})`
      : result?.failedPlayerMalformed === true
        ? 'harness result failed_player must be a string or null'
        : failure.kind !== null && reportedFailure === null
          ? failure.reason
          : !validScores
            ? 'harness result did not report one finite score for every resolved player'
            : reportedFailure !== null && !resolvedPlayerIds.includes(reportedFailure)
              ? `harness reported unknown failed player ${reportedFailure}`
              : null
  if (gameReason !== null) {
    return {
      scope: 'all-failed',
      status: failure.kind === 'timeout' ? 'timed_out' : 'failed',
      gameReason,
    }
  }
  // Past this point the envelope covers every resolved player and any named culprit is one of them.
  const culprit =
    failure.kind !== null && reportedFailure !== null
      ? { playerId: reportedFailure, reason: failure.reason ?? 'failed' }
      : null
  return {
    scope: 'attributed',
    status: culprit === null ? 'completed' : failure.kind === 'timeout' ? 'timed_out' : 'failed',
    gameReason: culprit === null ? null : failure.reason,
    scores: reportedScores,
    culprit,
  }
}

/** The chargeable-wall-clock watchdog bound for one game, derived from the effective episode timeout. */
export function gameWatchdogMs(
  episodeTimeoutMs: number,
  playerCount: number,
  graceMs: number,
): number {
  return episodeTimeoutMs * playerCount + graceMs
}

/**
 * Decide how a finished game's container fared. A non-zero exit is an agent crash if a valid envelope
 * identifies the player. OOM and watchdog outcomes remain container-level faults during attribution.
 * A clean exit whose recorded reason is `episode_limit` is a timed-out agent. Anything else is clean.
 */
function classifyFailure(
  exit: ExitInfo,
  result: ResultEnvelope | null,
  watchdogTimedOut: boolean,
): { kind: FailureKind; reason: string | null } {
  if (watchdogTimedOut) {
    return { kind: 'timeout', reason: 'agent exceeded its per-game wall-clock watchdog' }
  }
  if (exit.oomKilled) {
    return { kind: 'crash', reason: 'agent exceeded its memory quota (oom_killed)' }
  }
  if (exit.code !== 0) {
    return { kind: 'crash', reason: `agent container exited with code ${exit.code}` }
  }
  if (result?.reason === 'episode_limit') {
    return { kind: 'timeout', reason: 'agent exceeded its per-episode time budget' }
  }
  return { kind: null, reason: null }
}
