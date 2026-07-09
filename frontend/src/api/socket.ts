/**
 * The session WebSocket client: it owns the socket to `/api/sessions/:id/ws`, classifies every
 * incoming frame with the shared protocol rule, exposes the frames as typed callbacks, and sends
 * validated `Command` envelopes.
 *
 * Recording lines (the header, then the per-step states) are relayed verbatim by the backend; the
 * server is authoritative and already shapes them, so the client parses the JSON and hands it to the
 * renderer without re-validating against Ajv (which is Node-only). Envelopes (`session`, `pause`,
 * `resume`, `result`) are interpreted. Reconnection is the client's job: on an unexpected drop it
 * reattaches, and the backend's attach behavior (buffered header, latest state, current status)
 * makes resumption stateless, so a reconnect simply re-delivers the header and the latest state.
 */

import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import { type Command, classifyOutbound, serializeCommand } from '@game-sandbox/schema/protocol'

/** The socket's connection lifecycle, surfaced so a host page can show a reconnecting banner. */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed'

/** Callbacks for the typed frames a session emits; all but the recording ones are optional. */
export interface SessionSocketHandlers {
  onHeader(header: RecordingHeader): void
  onState(state: StepState): void
  onSessionStatus?(status: 'running' | 'ended', reason?: string): void
  onPause?(): void
  onResume?(): void
  onResult?(value: Record<string, unknown>): void
  onConnectionChange?(state: ConnectionState): void
}

const MAX_BACKOFF_MS = 5_000

/**
 * Build the absolute ws(s) URL for a session path. The browser sends the Better Auth session cookie
 * on a same-origin upgrade, so identity rides the cookie and no `user` query parameter is appended.
 */
export function sessionSocketUrl(wsPath: string, origin: string): string {
  const url = new URL(wsPath, origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export class SessionSocket {
  private socket: WebSocket | null = null
  private closedByCaller = false
  private headerSeen = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly wsPath: string,
    private readonly handlers: SessionSocketHandlers,
    /** Injectable for tests; defaults to the global WebSocket and the page origin. */
    private readonly deps: {
      WebSocketImpl?: typeof WebSocket
      origin?: string
    } = {},
  ) {}

  /** Open the socket. Safe to call once; use {@link close} to tear it down. */
  connect(): void {
    this.closedByCaller = false
    this.open('connecting')
  }

  private open(state: ConnectionState): void {
    const Impl = this.deps.WebSocketImpl ?? WebSocket
    const origin = this.deps.origin ?? window.location.origin
    this.headerSeen = false
    this.handlers.onConnectionChange?.(state)
    const socket = new Impl(sessionSocketUrl(this.wsPath, origin))
    this.socket = socket
    socket.onopen = (): void => {
      this.reconnectAttempts = 0
      this.handlers.onConnectionChange?.('open')
    }
    socket.onmessage = (event: MessageEvent): void => {
      this.onFrame(typeof event.data === 'string' ? event.data : String(event.data))
    }
    socket.onclose = (): void => {
      this.socket = null
      if (this.closedByCaller) {
        this.handlers.onConnectionChange?.('closed')
        return
      }
      this.scheduleReconnect()
    }
    socket.onerror = (): void => {
      // The close handler drives reconnect; errors only ever precede a close.
    }
  }

  private onFrame(raw: string): void {
    const line = classifyOutbound(raw)
    if (line.type === 'malformed') {
      return
    }
    if (line.type === 'recording') {
      if (!this.headerSeen) {
        this.headerSeen = true
        this.handlers.onHeader(JSON.parse(line.raw) as RecordingHeader)
      } else {
        this.handlers.onState(JSON.parse(line.raw) as StepState)
      }
      return
    }
    switch (line.kind) {
      case 'session': {
        const status = line.value.status
        if (status === 'running' || status === 'ended') {
          const reason = typeof line.value.reason === 'string' ? line.value.reason : undefined
          this.handlers.onSessionStatus?.(status, reason)
          if (status === 'ended') {
            // The server closes terminal sessions after this frame; mark it intentional first.
            this.close()
          }
        }
        break
      }
      case 'pause':
        this.handlers.onPause?.()
        break
      case 'resume':
        this.handlers.onResume?.()
        break
      case 'result':
        this.handlers.onResult?.(line.value)
        break
      default:
        break
    }
  }

  private scheduleReconnect(): void {
    this.handlers.onConnectionChange?.('reconnecting')
    const backoff = Math.min(MAX_BACKOFF_MS, 250 * 2 ** this.reconnectAttempts)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      if (!this.closedByCaller) {
        this.open('reconnecting')
      }
    }, backoff)
  }

  /** Send a validated command. A no-op when the socket is not open (the caller may retry on resume). */
  send(command: Command): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(serializeCommand(command))
    }
  }

  /** Close the socket for good; no reconnect follows. */
  close(): void {
    this.closedByCaller = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.socket?.close()
    this.socket = null
  }
}
