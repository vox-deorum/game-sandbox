/**
 * The admin run-log WebSocket client (Stage 6.7): it owns the socket to the step-3 log-stream
 * endpoint, decodes each {@link RunEvent} frame, and hands it to typed callbacks. It reuses the
 * session socket's conventions — identity rides the `user` query parameter (a browser cannot set a
 * header on the upgrade), and the page origin and `WebSocket` impl are injectable for tests.
 *
 * The stream is live-only by the step-3 contract: a console attaching mid-run renders progress from
 * the persisted per-game statuses (read over HTTP), then tails the live log lines from here. So this
 * client does not reconnect — a dropped socket means the live tail ended, not that history was lost,
 * and the backend sends a terminal event then closes when the run settles.
 */
import { withIdentityParam } from '../identity.js'

/** A run-level terminal status: the three states a run settles into once it stops executing. */
export type TerminalRunStatus = 'completed' | 'failed' | 'cancelled'

/** One scheduled match's lifecycle state, mirrored from the backend. */
export type GameStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled'

/** A log line's severity, set by the backend runner and shown in the stream's level column. */
export type RunLogLevel = 'info' | 'success' | 'warning' | 'error'

/** One per-match container log line, as the running workflow emits it. */
export interface RunLogEvent {
  type: 'log'
  game_index: number
  match_index: number
  /** Epoch-ms emission time, stamped by the backend runner. */
  ts: number
  /** The line's severity. */
  level: RunLogLevel
  line: string
}

/** A scheduled game's status transition, relayed live. */
export interface RunGameStatusEvent {
  type: 'game_status'
  game_index: number
  status: GameStatus
}

/** The final event the stream emits before the socket closes. */
export interface RunTerminalEvent {
  type: 'terminal'
  status: TerminalRunStatus
}

/** One event on a run's live stream. */
export type RunEvent = RunLogEvent | RunGameStatusEvent | RunTerminalEvent

/** Callbacks for the typed frames a run stream emits; all optional. */
export interface RunLogSocketHandlers {
  onLog?(event: RunLogEvent): void
  onGameStatus?(event: RunGameStatusEvent): void
  onTerminal?(event: RunTerminalEvent): void
  /** Fires when the socket closes for any reason (terminal, error, or caller close). */
  onClose?(): void
}

/** Build the absolute ws(s) URL for a run-log path, carrying the identity as the `user` parameter. */
export function runLogSocketUrl(wsPath: string, origin: string): string {
  const url = new URL(wsPath, origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return withIdentityParam(url).toString()
}

export class RunLogSocket {
  private socket: WebSocket | null = null
  private closedByCaller = false

  constructor(
    private readonly wsPath: string,
    private readonly handlers: RunLogSocketHandlers,
    /** Injectable for tests; defaults to the global WebSocket and the page origin. */
    private readonly deps: { WebSocketImpl?: typeof WebSocket; origin?: string } = {},
  ) {}

  /** Open the socket. Safe to call once; use {@link close} to tear it down. */
  connect(): void {
    const Impl = this.deps.WebSocketImpl ?? WebSocket
    const origin = this.deps.origin ?? window.location.origin
    const socket = new Impl(runLogSocketUrl(this.wsPath, origin))
    this.socket = socket
    socket.onmessage = (event: MessageEvent): void => {
      this.onFrame(typeof event.data === 'string' ? event.data : String(event.data))
    }
    socket.onclose = (): void => {
      this.socket = null
      this.handlers.onClose?.()
    }
    socket.onerror = (): void => {
      // The close handler reports the end; errors only ever precede a close.
    }
  }

  private onFrame(raw: string): void {
    let event: RunEvent
    try {
      event = JSON.parse(raw) as RunEvent
    } catch {
      return
    }
    switch (event.type) {
      case 'log':
        this.handlers.onLog?.(event)
        break
      case 'game_status':
        this.handlers.onGameStatus?.(event)
        break
      case 'terminal':
        this.handlers.onTerminal?.(event)
        break
      default:
        break
    }
  }

  /** Close the socket for good. */
  close(): void {
    this.closedByCaller = true
    this.socket?.close()
    this.socket = null
  }

  /** Whether the caller has explicitly closed this socket. */
  get isClosed(): boolean {
    return this.closedByCaller
  }
}
