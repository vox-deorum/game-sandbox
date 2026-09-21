/**
 * The attached-socket keepalive.
 *
 * A socket that dies without a clean close never fires `close`, and everything that must happen when a
 * viewer goes away hangs off that event: releasing the human's controls so their move budget stops
 * draining, and re-arming the idle timer. These cover the ping that turns such a socket into an
 * ordinary disconnect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type KeepaliveSocket, startKeepalive } from '../../src/session/routes.js'

const INTERVAL_MS = 1000

/** A socket that records what the keepalive did to it and can answer a ping on demand. */
function fakeSocket() {
  let pong: (() => void) | undefined
  const socket = {
    pings: 0,
    terminated: 0,
    ping(): void {
      socket.pings += 1
    },
    terminate(): void {
      socket.terminated += 1
    },
    on(_event: 'pong', listener: () => void): unknown {
      pong = listener
      return socket
    },
    /** Answer the outstanding ping, the way a live browser does in its protocol layer. */
    answer(): void {
      pong?.()
    },
  }
  return socket
}

describe('startKeepalive', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps pinging a socket that answers, and never ends it', () => {
    const socket = fakeSocket()
    startKeepalive(socket as KeepaliveSocket, INTERVAL_MS)

    for (let round = 0; round < 5; round += 1) {
      vi.advanceTimersByTime(INTERVAL_MS)
      socket.answer()
    }

    expect(socket.pings).toBe(5)
    expect(socket.terminated).toBe(0)
  })

  it('ends a socket that stops answering, so the ordinary detach path runs', () => {
    const socket = fakeSocket()
    startKeepalive(socket as KeepaliveSocket, INTERVAL_MS)

    // One ping goes out and is never answered, which is exactly what a sleeping laptop looks like.
    vi.advanceTimersByTime(INTERVAL_MS)
    expect(socket.pings).toBe(1)
    expect(socket.terminated).toBe(0)

    vi.advanceTimersByTime(INTERVAL_MS)
    expect(socket.terminated).toBe(1)
  })

  it('forgives a single missed answer once the peer catches up', () => {
    // A late pong still counts: the peer is alive, so a momentarily slow answer must not end the socket.
    const socket = fakeSocket()
    startKeepalive(socket as KeepaliveSocket, INTERVAL_MS)

    vi.advanceTimersByTime(INTERVAL_MS)
    socket.answer()
    vi.advanceTimersByTime(INTERVAL_MS)
    socket.answer()

    expect(socket.terminated).toBe(0)
    expect(socket.pings).toBe(2)
  })

  it('stops on request, so a closed socket leaves no timer behind', () => {
    const socket = fakeSocket()
    const stop = startKeepalive(socket as KeepaliveSocket, INTERVAL_MS)

    stop()
    vi.advanceTimersByTime(INTERVAL_MS * 10)

    expect(socket.pings).toBe(0)
    expect(socket.terminated).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
