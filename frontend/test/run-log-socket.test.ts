import { beforeEach, describe, expect, it } from 'vitest'

import { type RunEvent, RunLogSocket } from '../src/api/runLogSocket.js'

/** A minimal WebSocket double: records the URL and lets a test drive incoming frames and the close. */
class FakeWebSocket {
  static readonly OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    instances.push(this)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }

  message(event: RunEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
}

let instances: FakeWebSocket[] = []

const deps = {
  WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  origin: 'http://localhost',
}

describe('RunLogSocket', () => {
  beforeEach(() => {
    instances = []
  })

  it('carries the identity as the user query parameter on the ws URL', () => {
    const socket = new RunLogSocket('/api/admin/seasons/i1/runs/r1/logs/ws', {}, deps)
    socket.connect()
    const url = new URL((instances[0] as FakeWebSocket).url)
    expect(url.protocol).toBe('ws:')
    expect(url.searchParams.get('user')).toBe('dev-user')
  })

  it('decodes log, game_status, and terminal frames to their typed callbacks', () => {
    const logs: string[] = []
    const statuses: Array<{ index: number; status: string }> = []
    let terminal: string | null = null
    let closed = false
    const socket = new RunLogSocket(
      '/api/admin/seasons/i1/runs/r1/logs/ws',
      {
        onLog: (event) => logs.push(`${event.match_index}/${event.game_index}:${event.line}`),
        onGameStatus: (event) => statuses.push({ index: event.game_index, status: event.status }),
        onTerminal: (event) => {
          terminal = event.status
        },
        onClose: () => {
          closed = true
        },
      },
      deps,
    )
    socket.connect()
    const ws = instances[0] as FakeWebSocket
    ws.message({ type: 'log', match_index: 0, game_index: 2, line: 'container started' })
    ws.message({ type: 'game_status', game_index: 2, status: 'running' })
    ws.message({ type: 'terminal', status: 'completed' })

    expect(logs).toEqual(['0/2:container started'])
    expect(statuses).toEqual([{ index: 2, status: 'running' }])
    expect(terminal).toBe('completed')

    // The backend closes the socket after the terminal event; the close callback then fires.
    ws.close()
    expect(closed).toBe(true)
  })

  it('ignores malformed frames without throwing', () => {
    let logged = false
    const socket = new RunLogSocket(
      '/api/admin/seasons/i1/runs/r1/logs/ws',
      { onLog: () => (logged = true) },
      deps,
    )
    socket.connect()
    ;(instances[0] as FakeWebSocket).onmessage?.({ data: 'not json' })
    expect(logged).toBe(false)
  })
})
