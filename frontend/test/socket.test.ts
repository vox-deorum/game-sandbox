import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionSocket } from '../src/api/socket.js'

/** A minimal WebSocket double: records the URL and sends, and lets a test drive the events. */
class FakeWebSocket {
  static readonly OPEN = 1
  readyState = 0
  readonly sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null

  constructor(readonly url: string) {
    instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }

  // Test drivers:
  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  message(data: string): void {
    this.onmessage?.({ data })
  }

  drop(): void {
    this.readyState = 3
    this.onclose?.()
  }
}

let instances: FakeWebSocket[] = []

const HEADER = '{"schema_version":1,"environment":"flappy_bird","seed":7}'
const STATE = '{"schema_version":1,"tick":0,"agents":{},"timing":{"started_at":1,"duration_ms":1}}'

const deps = {
  WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  origin: 'http://localhost',
}

describe('SessionSocket', () => {
  beforeEach(() => {
    instances = []
  })

  it('routes the header then states, dispatches envelopes, and serializes sends', () => {
    const headers: RecordingHeader[] = []
    const states: StepState[] = []
    const statuses: Array<[string, string | undefined]> = []
    const socket = new SessionSocket(
      '/api/sessions/s1/ws',
      {
        onHeader: (h) => headers.push(h),
        onState: (s) => states.push(s),
        onSessionStatus: (status, reason) => statuses.push([status, reason]),
      },
      deps,
    )
    socket.connect()
    const ws = instances.at(-1)
    if (ws === undefined) {
      throw new Error('no socket opened')
    }
    // Identity now rides the same-origin session cookie, so no `user` query param is appended.
    expect(new URL(ws.url).searchParams.has('user')).toBe(false)
    expect(ws.url).toContain('/api/sessions/s1/ws')
    ws.open()
    ws.message(HEADER)
    ws.message(STATE)
    ws.message('{"kind":"session","status":"running"}')

    expect(headers).toHaveLength(1)
    expect(states).toHaveLength(1)
    expect(states[0]?.tick).toBe(0)
    expect(statuses).toEqual([['running', undefined]])

    socket.send({ kind: 'pause' })
    expect(ws.sent).toEqual(['{"kind":"pause"}'])
    socket.close()
  })

  it('reconnects after an unexpected drop', () => {
    vi.useFakeTimers()
    const socket = new SessionSocket(
      '/api/sessions/s1/ws',
      { onHeader: () => {}, onState: () => {} },
      deps,
    )
    socket.connect()
    instances.at(-1)?.open()
    instances.at(-1)?.drop()
    vi.advanceTimersByTime(300)
    expect(instances).toHaveLength(2)
    socket.close()
    vi.useRealTimers()
  })

  it('does not reconnect after the caller closes it', () => {
    vi.useFakeTimers()
    const socket = new SessionSocket(
      '/api/sessions/s1/ws',
      { onHeader: () => {}, onState: () => {} },
      deps,
    )
    socket.connect()
    instances.at(-1)?.open()
    socket.close()
    instances.at(-1)?.drop()
    vi.advanceTimersByTime(5000)
    expect(instances).toHaveLength(1)
    vi.useRealTimers()
  })

  it('does not reconnect after a terminal session frame', () => {
    vi.useFakeTimers()
    const statuses: Array<[string, string | undefined]> = []
    const socket = new SessionSocket(
      '/api/sessions/s1/ws',
      {
        onHeader: () => {},
        onState: () => {},
        onSessionStatus: (status, reason) => statuses.push([status, reason]),
      },
      deps,
    )
    socket.connect()
    const ws = instances.at(-1)
    if (ws === undefined) {
      throw new Error('no socket opened')
    }
    ws.open()
    ws.message('{"kind":"session","status":"ended","reason":"terminated"}')
    ws.drop()
    vi.advanceTimersByTime(5000)
    expect(statuses).toEqual([['ended', 'terminated']])
    expect(instances).toHaveLength(1)
    vi.useRealTimers()
  })
})

afterEach(() => {
  instances = []
})
