/**
 * The Docker-backed {@link WorkflowRunner} (Stage 6.4): the background engine that takes a triggered,
 * `pending` run and executes its persisted schedule one container at a time on this host.
 *
 * It is the second caller of the Stage 3 execution driver. Where the live session is browser-attached
 * and human-paced, this is **headless run-to-completion**: each scheduled game launches one container
 * through the shared launch-config seam ({@link assembleSeats}), the runner drains its stdout protocol
 * (the recording, tee'd live, plus the final `result` envelope) and its stderr diagnostics, waits for
 * the container to exit, then reads the per-seat outcome straight out of the recording it produced.
 * No socket, no human timeout, no relay. The container drives itself to its episode's end and exits.
 *
 * For each game the runner: registers the produced recording (owned by the seat's natural owner) and
 * attaches its id; writes one `game_results` row per participating seat with the normalized episode
 * score plus the aggregated agent compute time and acted-tick count; and advances the game's status.
 * A single agent crash or timeout marks that game `failed`/`timed_out` and flags the seat, but never
 * aborts the remaining scheduled games. A container that never yields a readable recording header is
 * an infrastructure fault: the game is marked `failed` with no invented result row. Between games the
 * runner checks a cooperative cancel flag; on cancel it stops scheduling, tears down any in-flight
 * container, and settles the run `cancelled`. Runs execute one at a time (single host), so two never
 * interleave on the box.
 *
 * Live progress is relayed to the admin WebSocket stream as {@link RunEvent}s: a game-started log line,
 * the container's diagnostic lines, a game-finished line, each game's status transition, and the run's
 * terminal verdict. The stream is live-only; persisted per-game statuses cover a late subscriber.
 */
import {
  classifyOutbound,
  type ParsedRecording,
  RESULT_KIND,
  readRecording,
} from '@game-sandbox/schema'

import type { ImagePolicy, SandboxDefaults } from '../config.js'
import type {
  ExecutionDriver,
  ExitInfo,
  ImageRef,
  SandboxProfile,
  SessionProcess,
} from '../driver/index.js'
import type { EnvironmentMeta, EnvironmentRegistry } from '../environments.js'
import { normalizeEpisodeScore } from '../leaderboards/score.js'
import { assembleSeats, type SeatBinding } from '../session/launch-config.js'
import { ensureRecordingsDir } from '../session/live-session.js'
import { decodeSeasonConfig, type Storage } from '../storage/index.js'
import type { AgentRef, SeasonRun, SeasonRunGame } from '../storage/schema.js'
import type { SubmissionSource } from '../submission/source/index.js'
import { ensureSubmissionImage, submissionSlotPath } from '../submission/submission-image.js'
import { aggregateSeat } from './aggregate.js'
import type { RunEvent, RunEventListener, TerminalRunStatus, WorkflowRunner } from './runner.js'

/** Where the recordings volume is mounted inside every match container (lockstep with the harness). */
const CONTAINER_RECORDINGS_DIR = '/recordings'
/** The writable scratch tmpfs mount point. */
const CONTAINER_SCRATCH_DIR = '/tmp'
/** Grace given to an in-flight container to stop politely before the driver hard-kills it (cancel). */
const DEFAULT_KILL_GRACE_MS = 5_000
/** Extra wall-clock slack over the episode compute budget before a workflow game is killed. */
const DEFAULT_GAME_WATCHDOG_GRACE_MS = 5_000

/** Everything the Docker-backed runner needs, injected so a fake driver + `:memory:` storage drive it. */
export interface WorkflowRunnerDeps {
  driver: ExecutionDriver
  storage: Storage
  environments: EnvironmentRegistry
  /** The submission-source seam, needed to rebuild a submission overlay when its cached image was evicted. */
  source: SubmissionSource
  /** The sandbox quotas each match container runs under, the same profile shape sessions use. */
  sandbox: SandboxDefaults
  /** The recordings volume root, mounted into each match container and read back after it exits. */
  recordingsDir: string
  /** The driver's reuse-vs-rebuild policy, threaded into overlay resolution. */
  imagePolicy: ImagePolicy
  /** Grace before a cancelled run's in-flight container is hard-killed. */
  killGraceMs?: number
  /** Extra wall-clock slack over the effective episode timeout before a game container is killed. */
  gameWatchdogGraceMs?: number
  log?: (message: string) => void
  /**
   * Called once a run settles to a terminal status, so step 5 can recompute the board and retention
   * can sweep. The runner awaits the hook before emitting the terminal event, so dependent snapshots
   * settle before subscribers learn the run is done.
   */
  onRunComplete?: (runId: string, status: TerminalRunStatus) => Promise<void> | void
}

/** The `result` envelope the harness emits once at episode end, as the runner reads it back. */
interface ResultEnvelope {
  reason: string | null
  scores: Record<string, number>
}

/** How a finished game's container fared: a clean episode, a crashed agent, or a timed-out agent. */
type FailureKind = 'crash' | 'timeout' | null

/**
 * Create the Docker-backed workflow runner. Runs execute sequentially through an in-process queue
 * (single host); `enqueue` returns immediately and the run advances out of band.
 */
export function createWorkflowRunner(deps: WorkflowRunnerDeps): WorkflowRunner {
  return new DockerWorkflowRunner(deps)
}

class DockerWorkflowRunner implements WorkflowRunner {
  private readonly log: (message: string) => void
  private readonly killGraceMs: number
  private readonly gameWatchdogGraceMs: number

  /** Run ids waiting to execute; drained one at a time so two runs never share the host. */
  private readonly queue: string[] = []
  private running = false
  /** Runs an operator asked to cancel; checked cooperatively between and during games. */
  private readonly cancelRequested = new Set<string>()
  /** The in-flight container per run, so a cancel can tear it down mid-game. */
  private readonly inFlight = new Map<string, SessionProcess>()
  /** Live event subscribers per run (the admin log stream). */
  private readonly listeners = new Map<string, Set<RunEventListener>>()

  constructor(private readonly deps: WorkflowRunnerDeps) {
    this.log = deps.log ?? ((): void => {})
    this.killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    this.gameWatchdogGraceMs = deps.gameWatchdogGraceMs ?? DEFAULT_GAME_WATCHDOG_GRACE_MS
  }

  enqueue(runId: string): void {
    this.queue.push(runId)
    void this.pump()
  }

  cancel(runId: string): void {
    this.cancelRequested.add(runId)
    // Best-effort mid-game teardown: kill the in-flight container so the current game does not run to
    // its natural end. The run loop sees the flag and settles the run `cancelled`.
    const process = this.inFlight.get(runId)
    if (process !== undefined) {
      void process.kill(this.killGraceMs).catch((error) => {
        this.log(`run ${runId}: cancel kill failed: ${String(error)}`)
      })
    }
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
    if (this.running) {
      return
    }
    this.running = true
    try {
      for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) {
        await this.executeRun(next)
      }
    } finally {
      this.running = false
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
      this.log(`run ${runId}: setRunStatus(${status}) failed: ${String(cause)}`)
    })
    this.cancelRequested.delete(runId)
    this.inFlight.delete(runId)
    try {
      await this.deps.onRunComplete?.(runId, status)
    } catch (cause) {
      this.log(`run ${runId}: completion hook failed: ${String(cause)}`)
    }
    this.emit(runId, { type: 'terminal', status })
  }

  /**
   * Execute one persisted run end to end: mark it running, drive each scheduled game in order, and
   * settle the run. A cancel between or during games stops the schedule and settles `cancelled`. An
   * unexpected throw fails the run rather than leaving it stuck running.
   */
  private async executeRun(runId: string): Promise<void> {
    const run = await this.deps.storage.getRun(runId)
    if (run === undefined) {
      this.log(`run ${runId}: vanished before execution; nothing to do`)
      this.cancelRequested.delete(runId)
      return
    }
    if (run.status !== 'pending') {
      // Reconcile or a prior pass already settled it; do not re-run.
      this.log(`run ${runId}: not pending (${run.status}); skipping`)
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
      await this.deps.storage.setRunStatus(runId, 'running')
      await ensureRecordingsDir(this.deps.recordingsDir)

      const games = await this.deps.storage.listRunGames(runId)
      for (const game of games) {
        if (this.cancelRequested.has(runId)) {
          await this.markGameCancelled(runId, game)
          continue
        }
        await this.runGame(run, meta, config.deps_version, config.overrides, game)
      }

      if (this.cancelRequested.has(runId)) {
        await this.finishRun(runId, 'cancelled', 'cancelled by operator')
        return
      }
      await this.finishRun(runId, 'completed')
    } catch (error) {
      this.log(`run ${runId}: unexpected failure: ${String(error)}`)
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
    overrides: ReturnType<typeof decodeSeasonConfig>['overrides'],
    game: SeasonRunGame,
  ): Promise<void> {
    const runId = run.id
    const envId = meta.env_id
    const slots = JSON.parse(game.slots) as AgentRef[]
    await this.deps.storage.setRunGameStatus(game.id, 'running')
    this.emit(runId, { type: 'game_status', game_index: game.game_index, status: 'running' })
    this.gameLog(
      runId,
      game,
      `game ${game.game_index} started: seed ${game.seed}, ${describeSlots(slots)}`,
    )

    // Resolve the launch image: the one submission seat's overlay, or the base image for an all-Naive
    // game. An image-resolution failure is an infrastructure fault, not an agent fault.
    let image: ImageRef
    try {
      image = await this.resolveImage(slots, depsVersion)
    } catch (error) {
      await this.infraFault(runId, game, `image resolution failed: ${errorText(error)}`)
      return
    }

    const recordingId = `${envId}-${game.id}`
    const sessionConfig = this.sessionConfig(envId, game.seed, slots, recordingId, overrides)

    let process: SessionProcess
    try {
      process = await this.deps.driver.launch({
        image,
        argv: [JSON.stringify(sessionConfig)],
        sandbox: this.sandboxProfile(),
        sessionId: game.id,
      })
    } catch (error) {
      await this.infraFault(runId, game, `container failed to start: ${errorText(error)}`)
      return
    }
    this.inFlight.set(runId, process)
    const watchdog = this.startGameWatchdog(
      runId,
      game,
      process,
      gameWatchdogMs(meta, overrides, this.gameWatchdogGraceMs),
    )

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
        this.log(`run ${runId} game ${game.game_index}: output stream error: ${String(error)}`)
      }
    })()

    const exit = await process.exited
    watchdog.stop()
    await stdout
    await diagnostics
    this.inFlight.delete(runId)

    // A cancel that killed this container mid-game: record the cancellation, not a failure or result.
    if (this.cancelRequested.has(runId)) {
      await this.deps.storage.setRunGameStatus(game.id, 'cancelled')
      this.emit(runId, { type: 'game_status', game_index: game.game_index, status: 'cancelled' })
      this.gameLog(runId, game, `game ${game.game_index} cancelled`)
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

    // Register the produced recording (owned by the seat's natural owner) and link it to the game.
    const owner = recordingOwner(slots, run.requested_by)
    await this.deps.storage
      .createRecording({
        id: recordingId,
        user_id: owner,
        env_id: envId,
        created_at: new Date().toISOString(),
      })
      .catch((error) => this.log(`run ${runId}: createRecording failed: ${String(error)}`))
    await this.deps.storage.attachRunGameRecording(game.id, recordingId)

    const failure = classifyFailure(exit, captured.result, watchdog.timedOut())
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
      const agent = slots[slotIndex] as AgentRef
      const slotId = `player_${slotIndex}`
      const aggregate = aggregateSeat(parsed.states, slotId)
      // The recording the harness produced is authoritative for episode score (Stage 6's "final
      // `score` for episode score"). The result envelope's self-reported score is only a fallback
      // for a recording that never reported this seat's score.
      const envelopeScore = captured.result?.scores[slotId]
      const rawScore =
        aggregate.finalScore ?? (typeof envelopeScore === 'number' ? envelopeScore : 0)
      await this.deps.storage.recordGameResult({
        game_id: game.id,
        slot_index: slotIndex,
        agent,
        episode_score: normalizeEpisodeScore(envId, rawScore),
        agent_compute_ms_total: aggregate.agentComputeMsTotal,
        acted_tick_count: aggregate.actedTickCount,
        failed: failure.kind !== null,
        failure_reason: failure.reason,
      })
    }

    const status =
      failure.kind === 'timeout' ? 'timed_out' : failure.kind === 'crash' ? 'failed' : 'completed'
    await this.deps.storage.setRunGameStatus(game.id, status, failure.reason ?? undefined)
    this.emit(runId, { type: 'game_status', game_index: game.game_index, status })
    this.gameLog(
      runId,
      game,
      `game ${game.game_index} finished: ${status}${failure.reason ? ` (${failure.reason})` : ''}`,
    )
  }

  /** Kill a game container if it exceeds its bounded wall-clock allowance. */
  private startGameWatchdog(
    runId: string,
    game: SeasonRunGame,
    process: SessionProcess,
    timeoutMs: number,
  ): { timedOut: () => boolean; stop: () => void } {
    let fired = false
    const timer = setTimeout(() => {
      fired = true
      this.gameLog(
        runId,
        game,
        `game ${game.game_index} exceeded wall-clock watchdog (${timeoutMs} ms); killing container`,
      )
      void process.kill(this.killGraceMs).catch((error) => {
        this.log(`run ${runId} game ${game.game_index}: watchdog kill failed: ${String(error)}`)
      })
    }, timeoutMs)
    return {
      timedOut: () => fired,
      stop: () => clearTimeout(timer),
    }
  }

  /** Resolve the launch image: the single submission seat's overlay, or the base image otherwise. */
  private async resolveImage(slots: readonly AgentRef[], depsVersion: number): Promise<ImageRef> {
    for (let i = 0; i < slots.length; i++) {
      const agent = slots[i] as AgentRef
      if (agent.kind === 'submission') {
        const submission = await this.deps.storage.getSubmission(agent.submission_id)
        if (submission === undefined) {
          throw new Error(`submission ${agent.submission_id} no longer exists`)
        }
        return ensureSubmissionImage(
          {
            driver: this.deps.driver,
            source: this.deps.source,
            imagePolicy: this.deps.imagePolicy,
          },
          submission,
          depsVersion,
          `player_${i}`,
        )
      }
    }
    return this.deps.driver.ensureImage({ kind: 'session-base', depsVersion })
  }

  /** Build the headless session config: every slot an agent, no human source, recording to the volume. */
  private sessionConfig(
    envId: string,
    seed: number,
    slots: readonly AgentRef[],
    recordingId: string,
    overrides: ReturnType<typeof decodeSeasonConfig>['overrides'],
  ): Record<string, unknown> {
    const seats = new Map<string, SeatBinding>()
    for (let i = 0; i < slots.length; i++) {
      const agent = slots[i] as AgentRef
      const slotId = `player_${i}`
      if (agent.kind === 'submission') {
        seats.set(slotId, {
          driver: 'submission',
          submissionId: agent.submission_id,
          userId: agent.user_id,
          path: submissionSlotPath(slotId),
        })
      } else {
        seats.set(slotId, { driver: 'naive' })
      }
    }
    const { slots: slotConfig, players } = assembleSeats(seats)
    return {
      env_id: envId,
      seed,
      slots: slotConfig,
      // No human seats in a workflow match, so there is no human-slot timeout to resolve.
      human_timeout_ms: null,
      recording_dir: CONTAINER_RECORDINGS_DIR,
      recording_id: recordingId,
      headless: true,
      players,
      // Per-step/per-episode overrides take effect this stage; absent keys fall back to env defaults.
      ...(overrides?.step_timeout_ms !== undefined
        ? { step_timeout_ms: overrides.step_timeout_ms }
        : {}),
      ...(overrides?.episode_timeout_ms !== undefined
        ? { episode_timeout_ms: overrides.episode_timeout_ms }
        : {}),
    }
  }

  private sandboxProfile(): SandboxProfile {
    return {
      cpus: this.deps.sandbox.cpus,
      memoryMb: this.deps.sandbox.memoryMb,
      readOnlyRoot: true,
      scratch: { containerPath: CONTAINER_SCRATCH_DIR, sizeMb: this.deps.sandbox.scratchMb },
      network: 'none',
      mounts: [
        {
          hostPath: this.deps.recordingsDir,
          containerPath: CONTAINER_RECORDINGS_DIR,
          readOnly: false,
        },
      ],
    }
  }

  /** Mark a game an infrastructure fault: `failed` with an error, no `game_results` row written. */
  private async infraFault(runId: string, game: SeasonRunGame, reason: string): Promise<void> {
    this.inFlight.delete(runId)
    await this.deps.storage.setRunGameStatus(game.id, 'failed', reason)
    this.emit(runId, { type: 'game_status', game_index: game.game_index, status: 'failed' })
    this.gameLog(runId, game, `game ${game.game_index} failed (infrastructure): ${reason}`)
  }

  /** Emit one log event for a game, carrying its schedule and match indices for the admin stream. */
  private gameLog(runId: string, game: SeasonRunGame, line: string): void {
    this.emit(runId, {
      type: 'log',
      game_index: game.game_index,
      match_index: game.match_index,
      line,
    })
  }
}

/** The owner-visible text for a thrown value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A human-readable seat summary for the started-game log line. */
function describeSlots(slots: readonly AgentRef[]): string {
  const labels = slots.map((agent) =>
    agent.kind === 'submission' ? `submission ${agent.submission_id}` : 'Naive baseline',
  )
  return labels.join(' vs ')
}

/** The recording's natural owner: the (single) submission seat's owner, else the run's operator. */
function recordingOwner(slots: readonly AgentRef[], requestedBy: string): string {
  for (const agent of slots) {
    if (agent.kind === 'submission') {
      return agent.user_id
    }
  }
  return requestedBy
}

/** Validate the harness `result` envelope into the two fields the runner reads. */
function parseResultEnvelope(value: Record<string, unknown>): ResultEnvelope {
  const reason = typeof value.reason === 'string' ? value.reason : null
  const scores: Record<string, number> = {}
  const raw = value.scores
  if (typeof raw === 'object' && raw !== null) {
    for (const [slotId, score] of Object.entries(raw)) {
      if (typeof score === 'number') {
        scores[slotId] = score
      }
    }
  }
  return { reason, scores }
}

/** The wall-clock watchdog bound for one game, derived from the same effective episode timeout. */
function gameWatchdogMs(
  meta: EnvironmentMeta,
  overrides: ReturnType<typeof decodeSeasonConfig>['overrides'],
  graceMs: number,
): number {
  return (overrides?.episode_timeout_ms ?? meta.episode_limit_ms) + graceMs
}

/**
 * Decide how a finished game's container fared. A non-zero exit or an OOM kill is an attributable
 * agent crash; a clean exit whose recorded reason is `episode_limit` is a timed-out agent (it
 * exhausted its episode compute budget). Anything else is a clean completion.
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
