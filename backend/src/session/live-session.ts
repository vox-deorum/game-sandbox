/**
 * One live session's runtime: the relay between the container and the attached browsers, the
 * replay buffer for late attachers, the idle and wall-clock teardown timers, and the single
 * idempotent finalize that every end path converges on.
 *
 * The backend is a relay; the container is authoritative. The relay consumes the container's
 * outbound lines and broadcasts recording lines verbatim, stashing the header and the latest state
 * so a freshly attached socket can draw immediately. Inbound commands are validated for shape and
 * authority, then forwarded; `pause`/`resume` are also echoed to every socket so all spectators see
 * the paused state. The container is never trusted to be the only thing that ends a session: the
 * idle timer, the wall-clock backstop, an owner `stop`, an `oomKilled`/crash exit, and the
 * container's own `result` all route through {@link finalize}, which records the reason, tells the
 * clients, and clears the registry exactly once.
 */
import { chmod, mkdir } from 'node:fs/promises'
import {
  classifyOutbound,
  codePointLength,
  parseCommand,
  RESULT_KIND,
  serializeCommand,
  sessionEnvelope,
} from '@game-sandbox/schema'
import type { SessionProcess } from '../driver/index.js'
import { coerceResultReason } from '../result-reason.js'
import type { Storage } from '../storage/index.js'
import type { SessionMode, TerminationReason } from '../storage/schema.js'

/** The minimal browser-socket surface the relay needs, so it is framework- and test-agnostic. */
export interface ClientSocket {
  send(data: string): void
  close(): void
  /** Bytes queued but not yet flushed to the network; backs the slow-socket drop. */
  readonly bufferedAmount: number
}

/** A live attachment: the relay forwards inbound frames to {@link handleMessage} until {@link detach}. */
export interface Attachment {
  handleMessage(raw: string): void
  detach(): void
}

/** Everything a {@link LiveSession} needs beyond its own identity and process. */
export interface LiveSessionDeps {
  storage: Storage
  /** Called once teardown completes, so the registry can drop this session. */
  onEnd: (id: string) => void
  /**
   * Called after finalize has written the session and recording rows, so retention can sweep the
   * just-grown data. Fire-and-forget; the orchestrator wires it to the retention sweep.
   */
  onFinalized?: (id: string) => void
  /** Backend logger, tagged by the caller with the session id. */
  log: (message: string) => void
  idleTimeoutMs: number
  maxDurationMs: number
  killGraceMs: number
  /** Close official admission and await active-request finalizers before container teardown. */
  revokeLlm?: () => Promise<void>
  /** Remove this live scope after the barrier when no recording association was retained. */
  deleteLlmScope?: (scopeId: string) => void
}

export interface LiveSessionInit {
  id: string
  userId: string
  envId: string
  mode: SessionMode
  recordingId: string
  /** The session's start timestamp, reused as the recording's retention `created_at`. */
  createdAt: string
  process: SessionProcess
  humanSlots: readonly string[]
  /**
   * The slots whose resolved binding is actually a connected human this session, not every
   * human-capable seat (that is `humanSlots`), but the ones a human really controls. Message
   * visibility and the inbound chat gate authorize against these, so a targeted message is shown
   * live only to the client controlling one of them.
   */
  externalSlots: readonly string[]
  /** The effective messaging rules resolved once by the orchestrator (metadata AND season override). */
  messaging: { enabled: boolean; cap: number | null }
  /** Stored on the session and copied into the recording's durable telemetry association. */
  llmEnabled?: boolean
  deps: LiveSessionDeps
}

const STOP_LINE = serializeCommand({ kind: 'stop' })
/** A socket whose backlog crosses this is dropped rather than letting one slow client stall the relay. */
const BACKPRESSURE_LIMIT_BYTES = 1 << 20

export class LiveSession {
  readonly id: string
  readonly userId: string
  readonly envId: string
  readonly mode: SessionMode
  readonly recordingId: string
  private readonly createdAt: string

  private readonly process: SessionProcess
  private readonly humanSlots: ReadonlySet<string>
  private readonly externalSlots: ReadonlySet<string>
  private readonly messaging: { enabled: boolean; cap: number | null }
  private readonly llmEnabled: boolean
  private readonly deps: LiveSessionDeps

  /** Each attached socket with its audience marker, so a targeted message is filtered per attachment. */
  private readonly sockets = new Map<ClientSocket, { isOwner: boolean }>()
  private readonly outputDone: Promise<void>
  private status: 'starting' | 'running' | 'ended' = 'starting'
  private headerLine: string | null = null
  private latestState: string | null = null
  /** The container's reported episode outcome, stashed from the `result` envelope. */
  private resultReason: TerminationReason | null = null
  private finalReason: TerminationReason | null = null

  private finalizePromise: Promise<void> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly maxTimer: ReturnType<typeof setTimeout>

  constructor(init: LiveSessionInit) {
    this.id = init.id
    this.userId = init.userId
    this.envId = init.envId
    this.mode = init.mode
    this.recordingId = init.recordingId
    this.createdAt = init.createdAt
    this.process = init.process
    this.humanSlots = new Set(init.humanSlots)
    this.externalSlots = new Set(init.externalSlots)
    this.messaging = init.messaging
    this.llmEnabled = init.llmEnabled ?? false
    this.deps = init.deps

    this.maxTimer = setTimeout(() => {
      void this.finalize('time_limit')
    }, this.deps.maxDurationMs)
    this.armIdle()

    this.outputDone = this.consumeOutput()
    void this.consumeDiagnostics()
    this.process.exited.then(
      async (info) => {
        await this.outputDone
        return this.finalize(this.deriveReason(info.oomKilled, info.code))
      },
      (error) => {
        this.deps.log(`session ${this.id}: exit wait failed: ${String(error)}`)
        void this.finalize('error')
      },
    )
  }

  // --- relay: container → browsers ---

  private async consumeOutput(): Promise<void> {
    try {
      for await (const raw of this.process.output) {
        this.onOutputLine(raw)
      }
    } catch (error) {
      this.deps.log(`session ${this.id}: output stream error: ${String(error)}`)
    }
  }

  private async consumeDiagnostics(): Promise<void> {
    try {
      for await (const line of this.process.diagnostics) {
        this.deps.log(`session ${this.id} [container]: ${line}`)
      }
    } catch {
      // Diagnostics ending early is harmless; the session's fate is decided by output and exit.
    }
  }

  private onOutputLine(raw: string): void {
    const line = classifyOutbound(raw)
    if (line.type === 'malformed') {
      this.deps.log(`session ${this.id}: dropping malformed container line: ${raw}`)
      return
    }
    if (line.type === 'recording') {
      if (this.headerLine === null) {
        this.headerLine = raw
        this.markRunning()
        this.broadcast(raw) // the header carries no messages; send it verbatim to everyone
      } else {
        this.latestState = raw
        this.broadcastState(raw, line.value)
      }
      return
    }
    // Event envelope: stash the result reason for the row, then relay it like any other envelope.
    if (line.kind === RESULT_KIND) {
      const coerced = coerceResultReason(line.value.reason)
      if (coerced !== null) {
        this.resultReason = coerced
      }
    }
    this.broadcast(raw)
  }

  private markRunning(): void {
    if (this.status !== 'starting') {
      return
    }
    this.status = 'running'
    this.deps.storage
      .markRunning(this.id)
      .catch((error) => this.deps.log(`session ${this.id}: markRunning failed: ${String(error)}`))
    this.broadcast(sessionEnvelope('running'))
  }

  private broadcast(data: string): void {
    for (const socket of [...this.sockets.keys()]) {
      if (this.dropIfSlow(socket)) {
        continue
      }
      try {
        socket.send(data)
      } catch {
        this.sockets.delete(socket)
      }
    }
  }

  /**
   * Broadcast a recording state line, re-serialized per audience when it carries targeted messages.
   * A line with no `messages` (the common case) is sent verbatim to everyone, so the hot path costs
   * nothing; only a line with messages is filtered, and even then a socket whose visible set equals
   * the original still receives the byte-identical `raw`.
   */
  private broadcastState(raw: string, value: Record<string, unknown>): void {
    if (!Array.isArray(value.messages)) {
      this.broadcast(raw)
      return
    }
    for (const [socket, meta] of [...this.sockets]) {
      if (this.dropIfSlow(socket)) {
        continue
      }
      try {
        socket.send(this.filterStateForAudience(raw, value, meta.isOwner))
      } catch {
        this.sockets.delete(socket)
      }
    }
  }

  /** Drop a socket whose backlog crossed the backpressure limit; returns whether it was dropped. */
  private dropIfSlow(socket: ClientSocket): boolean {
    if (socket.bufferedAmount > BACKPRESSURE_LIMIT_BYTES) {
      this.sockets.delete(socket)
      this.safeClose(socket)
      this.deps.log(`session ${this.id}: dropped a slow socket (backpressure)`)
      return true
    }
    return false
  }

  /**
   * Return the state line one audience may see. The **controller** (the owner of a human-mode
   * session) sees broadcasts plus targeted messages where `to` or `from` is a human-bound slot. The
   * `from` case is the deliberate sender reflection, letting the panel render the owner's own sends
   * from the recorded line with no local echo. Every other attachment (a spectator, including the
   * owner of a scripted run) sees broadcasts only. A line whose visible set equals the original is
   * returned as the byte-identical `raw`.
   */
  private filterStateForAudience(
    raw: string,
    value: Record<string, unknown>,
    isOwner: boolean,
  ): string {
    const messages = value.messages
    if (!Array.isArray(messages)) {
      return raw
    }
    const isController = isOwner && this.mode === 'human'
    const kept = messages.filter((message) => this.messageVisible(message, isController))
    if (kept.length === messages.length) {
      return raw
    }
    const clone: Record<string, unknown> = { ...value }
    if (kept.length === 0) {
      delete clone.messages
    } else {
      clone.messages = kept
    }
    return JSON.stringify(clone)
  }

  /** Whether one recorded message is visible live to a controller (`true`) or spectator audience. */
  private messageVisible(message: unknown, isController: boolean): boolean {
    if (typeof message !== 'object' || message === null) {
      return true // an unexpected shape is left in place; the harness never emits one
    }
    const { to, from } = message as { to?: unknown; from?: unknown }
    if (to === null || to === undefined) {
      return true // a broadcast is visible to everyone
    }
    if (!isController) {
      return false // spectators never see a targeted message live
    }
    return (
      (typeof to === 'string' && this.externalSlots.has(to)) ||
      (typeof from === 'string' && this.externalSlots.has(from))
    )
  }

  /** Derive the line a freshly attached socket receives from the stashed raw state (audience-filtered). */
  private stateForAttach(raw: string, isOwner: boolean): string {
    let value: Record<string, unknown>
    try {
      value = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return raw
    }
    return this.filterStateForAudience(raw, value, isOwner)
  }

  // --- attach / inbound commands: browsers → container ---

  /**
   * Attach a socket. It immediately receives the buffered header, the latest state, and the
   * current status so a renderer can draw without waiting for the next step. Only the owner's
   * commands are honored, and `input` only in human mode for a slot the session exposes.
   */
  attach(socket: ClientSocket, isOwner: boolean): Attachment {
    this.sockets.set(socket, { isOwner })
    if (this.headerLine !== null) {
      this.trySend(socket, this.headerLine)
    }
    if (this.latestState !== null) {
      // Derive the audience variant of the stashed line at catch-up time, so a late-attaching
      // spectator can never receive a targeted message through the replay path.
      this.trySend(socket, this.stateForAttach(this.latestState, isOwner))
    }
    if (this.status === 'running') {
      this.trySend(socket, sessionEnvelope('running'))
    } else if (this.status === 'ended') {
      this.trySend(socket, sessionEnvelope('ended', this.finalReason ?? undefined))
    }
    this.refreshIdleOnAttach()

    return {
      handleMessage: (raw: string): void => this.handleClientMessage(raw, isOwner),
      detach: (): void => {
        this.sockets.delete(socket)
        this.refreshIdleOnDetach()
      },
    }
  }

  private handleClientMessage(raw: string, isOwner: boolean): void {
    const parsed = parseCommand(raw)
    if (!parsed.ok) {
      this.deps.log(`session ${this.id}: ignoring command (${parsed.reason})`)
      return
    }
    // Only the owner drives a session; a spectator's commands are ignored.
    if (!isOwner) {
      return
    }
    const command = parsed.command
    if (command.kind === 'input') {
      if (this.mode !== 'human' || !this.humanSlots.has(command.slot)) {
        return
      }
    }
    if (command.kind === 'chat') {
      // Forward a human chat only from the controller of a human-mode session, for a slot it actually
      // controls, when messaging is effectively enabled, and within the effective cap counted in code
      // points. The pre-gate keeps junk off container stdin; the harness stays authoritative and
      // validates again. A dropped frame is logged like every other rejection.
      if (
        this.mode !== 'human' ||
        !this.externalSlots.has(command.slot) ||
        !this.messaging.enabled
      ) {
        return
      }
      if (this.messaging.cap !== null && codePointLength(command.text) > this.messaging.cap) {
        this.deps.log(`session ${this.id}: dropping over-cap chat from ${command.slot}`)
        return
      }
    }
    this.process.send(serializeCommand(command))
    if (command.kind === 'pause' || command.kind === 'resume') {
      this.broadcast(serializeCommand(command))
    }
    if (this.mode === 'human') {
      this.refreshIdleOnCommand()
    }
  }

  // --- idle and wall-clock teardown timers ---

  private armIdle(): void {
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      void this.finalize('idle_timeout')
    }, this.deps.idleTimeoutMs)
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private refreshIdleOnAttach(): void {
    // A watched scripted run is never idle; a human session's window resets on every new attach.
    if (this.mode === 'scripted') {
      this.clearIdle()
    } else {
      this.armIdle()
    }
  }

  private refreshIdleOnDetach(): void {
    if (this.sockets.size === 0) {
      this.armIdle()
    }
  }

  private refreshIdleOnCommand(): void {
    this.armIdle()
  }

  // --- teardown ---

  /** The owner-initiated graceful stop (DELETE). */
  requestStop(): Promise<void> {
    return this.finalize('stopped')
  }

  /**
   * Converge to ended exactly once: stop the timers, ask the container to end and then kill it as a
   * backstop, record the reason, notify and close the sockets, and drop from the registry. The
   * first caller's reason wins, so an orchestrator-initiated reason (idle, time limit) is not
   * overwritten by the container's own `result` arriving during the grace window.
   */
  finalize(reason: TerminationReason): Promise<void> {
    this.finalizePromise ??= this.finalizeOnce(reason)
    return this.finalizePromise
  }

  private async finalizeOnce(reason: TerminationReason): Promise<void> {
    this.finalReason = reason
    this.clearIdle()
    clearTimeout(this.maxTimer)

    // Close admission and settle authenticated work before the process disappears with its network.
    try {
      await this.deps.revokeLlm?.()
    } catch (error) {
      this.deps.log(`session ${this.id}: LLM revocation failed: ${String(error)}`)
    }

    // Ask politely (the container flushes its recording and exits), then force the teardown.
    this.process.send(STOP_LINE)
    let killFailed = false
    try {
      await this.process.kill(this.deps.killGraceMs)
    } catch (error) {
      killFailed = true
      this.deps.log(`session ${this.id}: kill failed: ${String(error)}`)
    }

    // The process can flush its first recording lines while handling STOP or during the forced-kill
    // grace period. Drain that buffered output before deciding whether a recording exists and before
    // reclaiming an apparently unassociated telemetry scope. A failed kill leaves process and stream
    // termination uncertain, so bound that drain and let durable startup recovery reclaim its scope.
    if (killFailed) {
      await boundedOutputDrain(this.outputDone, this.deps.killGraceMs)
    } else {
      await this.outputDone
    }

    this.status = 'ended'
    try {
      await this.deps.storage.markEnded(this.id, reason, new Date().toISOString())
    } catch (error) {
      this.deps.log(`session ${this.id}: markEnded failed: ${String(error)}`)
    }

    // Register only a recording that produced a readable header. A container that failed before its
    // first recording line has no replay to retain, so its settled LLM scope is reclaimed below.
    if (this.headerLine !== null) {
      try {
        await this.deps.storage.createRecording({
          id: this.recordingId,
          user_id: this.userId,
          env_id: this.envId,
          created_at: this.createdAt,
          llm_scope_id: this.llmEnabled ? this.id : null,
          llm_session_id: this.llmEnabled ? this.id : null,
        })
      } catch (error) {
        this.deps.log(`session ${this.id}: createRecording failed: ${String(error)}`)
      }
    }

    if (this.llmEnabled && this.deps.deleteLlmScope !== undefined && !killFailed) {
      try {
        const retained = await this.deps.storage.getRecording(this.recordingId)
        if (retained?.llm_scope_id !== this.id) {
          this.deps.deleteLlmScope(this.id)
        }
      } catch (error) {
        // Fail safe: an uncertain association keeps the scope for startup recovery.
        this.deps.log(`session ${this.id}: LLM scope cleanup failed: ${String(error)}`)
      }
    }

    this.broadcast(sessionEnvelope('ended', reason))
    for (const socket of this.sockets.keys()) {
      this.safeClose(socket)
    }
    this.sockets.clear()
    this.deps.onEnd(this.id)
    // Retention sweeps the just-grown data (the only moment a recording row is added).
    this.deps.onFinalized?.(this.id)
  }

  /** Map an exit with no orchestrator-chosen reason onto a termination reason. */
  private deriveReason(oomKilled: boolean, code: number): TerminationReason {
    if (oomKilled) {
      return 'oom_killed'
    }
    if (this.resultReason !== null) {
      return this.resultReason
    }
    return code === 0 ? 'stopped' : 'error'
  }

  private trySend(socket: ClientSocket, data: string): void {
    try {
      socket.send(data)
    } catch {
      this.sockets.delete(socket)
    }
  }

  private safeClose(socket: ClientSocket): void {
    try {
      socket.close()
    } catch {
      // Already closing; nothing to do.
    }
  }
}

/** Give a failed process teardown one short chance to flush output without pinning Node's event loop. */
async function boundedOutputDrain(outputDone: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(1, timeoutMs))
    timer.unref?.()
  })
  try {
    await Promise.race([outputDone, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Ensure the recordings root exists before a container binds it (the bind mount needs the dir). */
export async function ensureRecordingsDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  // Session containers run with all capabilities dropped. On Linux a host temp directory created
  // as 0700 is not writable by capless root inside the bind mount, so make the shared recording
  // volume intentionally world-writable before Docker attaches it.
  await chmod(path, 0o777)
}
