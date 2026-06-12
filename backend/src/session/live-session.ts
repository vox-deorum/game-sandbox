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
import { mkdir } from 'node:fs/promises'
import {
  classifyOutbound,
  parseCommand,
  RESULT_KIND,
  serializeCommand,
  sessionEnvelope,
} from '@game-sandbox/schema'
import type { SessionProcess } from '../driver/index.js'
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
  /** Backend logger, tagged by the caller with the session id. */
  log: (message: string) => void
  idleTimeoutMs: number
  maxDurationMs: number
  killGraceMs: number
}

export interface LiveSessionInit {
  id: string
  userId: string
  envId: string
  mode: SessionMode
  recordingId: string
  process: SessionProcess
  humanSlots: readonly string[]
  deps: LiveSessionDeps
}

/** The container-side `result` reasons; an `oomKilled`/crash exit maps to a reason in {@link finalize}. */
const RESULT_REASONS: ReadonlySet<string> = new Set([
  'terminated',
  'truncated',
  'episode_limit',
  'stopped',
])

const STOP_LINE = serializeCommand({ kind: 'stop' })
/** A socket whose backlog crosses this is dropped rather than letting one slow client stall the relay. */
const BACKPRESSURE_LIMIT_BYTES = 1 << 20

export class LiveSession {
  readonly id: string
  readonly userId: string
  readonly envId: string
  readonly mode: SessionMode
  readonly recordingId: string

  private readonly process: SessionProcess
  private readonly humanSlots: ReadonlySet<string>
  private readonly deps: LiveSessionDeps

  private readonly sockets = new Set<ClientSocket>()
  private readonly outputDone: Promise<void>
  private status: 'starting' | 'running' | 'ended' = 'starting'
  private headerLine: string | null = null
  private latestState: string | null = null
  /** The container's reported episode outcome, stashed from the `result` envelope. */
  private resultReason: TerminationReason | null = null
  private finalReason: TerminationReason | null = null

  private finalized = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly maxTimer: ReturnType<typeof setTimeout>

  constructor(init: LiveSessionInit) {
    this.id = init.id
    this.userId = init.userId
    this.envId = init.envId
    this.mode = init.mode
    this.recordingId = init.recordingId
    this.process = init.process
    this.humanSlots = new Set(init.humanSlots)
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
      } else {
        this.latestState = raw
      }
      this.broadcast(raw)
      return
    }
    // Event envelope: stash the result reason for the row, then relay it like any other envelope.
    if (line.kind === RESULT_KIND) {
      const reason = line.value.reason
      if (typeof reason === 'string' && RESULT_REASONS.has(reason)) {
        this.resultReason = reason as TerminationReason
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
    for (const socket of [...this.sockets]) {
      if (socket.bufferedAmount > BACKPRESSURE_LIMIT_BYTES) {
        this.sockets.delete(socket)
        this.safeClose(socket)
        this.deps.log(`session ${this.id}: dropped a slow socket (backpressure)`)
        continue
      }
      try {
        socket.send(data)
      } catch {
        this.sockets.delete(socket)
      }
    }
  }

  // --- attach / inbound commands: browsers → container ---

  /**
   * Attach a socket. It immediately receives the buffered header, the latest state, and the
   * current status so a renderer can draw without waiting for the next step. Only the owner's
   * commands are honored, and `input` only in human mode for a slot the session exposes.
   */
  attach(socket: ClientSocket, isOwner: boolean): Attachment {
    this.sockets.add(socket)
    if (this.headerLine !== null) {
      this.trySend(socket, this.headerLine)
    }
    if (this.latestState !== null) {
      this.trySend(socket, this.latestState)
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
  async finalize(reason: TerminationReason): Promise<void> {
    if (this.finalized) {
      return
    }
    this.finalized = true
    this.finalReason = reason
    this.clearIdle()
    clearTimeout(this.maxTimer)

    // Ask politely (the container flushes its recording and exits), then force the teardown.
    this.process.send(STOP_LINE)
    try {
      await this.process.kill(this.deps.killGraceMs)
    } catch (error) {
      this.deps.log(`session ${this.id}: kill failed: ${String(error)}`)
    }

    this.status = 'ended'
    try {
      await this.deps.storage.markEnded(this.id, reason, new Date().toISOString())
    } catch (error) {
      this.deps.log(`session ${this.id}: markEnded failed: ${String(error)}`)
    }

    this.broadcast(sessionEnvelope('ended', reason))
    for (const socket of this.sockets) {
      this.safeClose(socket)
    }
    this.sockets.clear()
    this.deps.onEnd(this.id)
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

/** Ensure the recordings root exists before a container binds it (the bind mount needs the dir). */
export async function ensureRecordingsDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}
