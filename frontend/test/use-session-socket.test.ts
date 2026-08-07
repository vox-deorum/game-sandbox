import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import type { SessionSocketHandlers } from '../src/api/socket.js'

const socketDouble = vi.hoisted(() => ({
  handlers: [] as SessionSocketHandlers[],
  connect: vi.fn(),
  close: vi.fn(),
  sent: [] as unknown[],
}))

vi.mock('../src/api/socket.js', () => ({
  SessionSocket: class {
    constructor(_path: string, handlers: SessionSocketHandlers) {
      socketDouble.handlers.push(handlers)
    }
    connect(): void {
      socketDouble.connect()
    }
    close(): void {
      socketDouble.close()
    }
    send(command: unknown): void {
      socketDouble.sent.push(command)
    }
  },
}))

import { useSessionSocket } from '../src/composables/useSessionSocket.js'

function mountSessionSocket() {
  let session!: ReturnType<typeof useSessionSocket>
  const drawn: Array<{ state: StepState; options?: { transitionMs?: number } }> = []
  const wrapper = mount(
    defineComponent({
      setup() {
        session = useSessionSocket('s1', {
          onHeader: () => {},
          onState: (state, options) => drawn.push({ state, options }),
        })
        return () => h('div')
      },
    }),
  )
  return { drawn, session, wrapper }
}

function header(human: boolean): RecordingHeader {
  return {
    schema_version: 1,
    environment: 'skirmish_crane',
    seed: 0,
    parameters: {},
    players: {
      player_0: human
        ? { kind: 'human', label: 'You', user: 'you' }
        : { kind: 'agent', builtin_name: 'naive', label: 'Naive' },
    },
    seats: { seat_0: ['player_0'] },
    seat_plan: 'skirmish',
  }
}

function state(tick: number): StepState {
  return {
    schema_version: 1,
    tick,
    agents: {},
    timing: { started_at: 0, duration_ms: 0 },
  }
}

describe('useSessionSocket', () => {
  beforeEach(() => {
    socketDouble.handlers.length = 0
    socketDouble.connect.mockClear()
    socketDouble.close.mockClear()
    socketDouble.sent.length = 0
  })

  afterEach(() => vi.useRealTimers())

  it('accepts the first result from each explicit connection', () => {
    const { session, wrapper } = mountSessionSocket()

    session.connect()
    socketDouble.handlers[0]?.onResult?.({ scores: { player_0: 1 } })
    socketDouble.handlers[0]?.onResult?.({ scores: { player_0: 99 } })
    expect(session.finalResult.value?.scores).toEqual({ player_0: 1 })

    session.connect()
    socketDouble.handlers[1]?.onResult?.({ scores: { player_0: 2 } })

    expect(socketDouble.connect).toHaveBeenCalledTimes(2)
    expect(session.finalResult.value?.scores).toEqual({ player_0: 2 })
    wrapper.unmount()
  })

  it('ignores a retired connection result so the new connection keeps its own first result', () => {
    const { session, wrapper } = mountSessionSocket()

    session.connect()
    const first = socketDouble.handlers[0]
    session.connect()
    const second = socketDouble.handlers[1]
    first?.onResult?.({ scores: { player_0: 99 } })
    second?.onResult?.({ scores: { player_0: 2 } })

    expect(socketDouble.close).toHaveBeenCalledTimes(1)
    expect(session.finalResult.value?.scores).toEqual({ player_0: 2 })
    wrapper.unmount()
  })

  it('clears paced frames from a retired connection', async () => {
    vi.useFakeTimers()
    const { drawn, session, wrapper } = mountSessionSocket()

    session.connect({ pace: true, paceMs: 50 })
    const first = socketDouble.handlers[0]
    first?.onState(state(0))
    first?.onState(state(1))
    first?.onState(state(2))

    session.connect()
    const second = socketDouble.handlers[1]
    first?.onState(state(3))
    first?.onSessionStatus?.('ended', 'terminated')
    second?.onState(state(4))
    await nextTick()
    vi.advanceTimersByTime(200)
    await nextTick()

    expect(drawn.map((entry) => entry.state.tick)).toEqual([4])
    wrapper.unmount()
  })

  it('uses watch pacing after an all-agent header arrives', async () => {
    vi.useFakeTimers()
    const { drawn, session, wrapper } = mountSessionSocket()

    session.connect({ paceWhenSpectating: true, paceMs: 100, liveMs: 50 })
    const handlers = socketDouble.handlers[0]
    handlers?.onHeader(header(false))
    handlers?.onState(state(0))
    handlers?.onState(state(1))

    expect(drawn).toEqual([])
    vi.advanceTimersByTime(100)
    await nextTick()
    expect(drawn).toEqual([{ state: state(0), options: { transitionMs: 100 } }])
    wrapper.unmount()
  })

  it('keeps a human-attributed session on the live throttle after its header arrives', async () => {
    vi.useFakeTimers()
    const { drawn, session, wrapper } = mountSessionSocket()

    session.connect({ paceWhenSpectating: true, paceMs: 100, liveMs: 50 })
    const handlers = socketDouble.handlers[0]
    handlers?.onHeader(header(true))
    handlers?.onState(state(0))
    handlers?.onState(state(1))

    expect(drawn).toEqual([{ state: state(0), options: undefined }])
    vi.advanceTimersByTime(50)
    await nextTick()
    expect(drawn).toEqual([
      { state: state(0), options: undefined },
      { state: state(1), options: { transitionMs: 50 } },
    ])
    wrapper.unmount()
  })

  it('keeps explicit watch pacing when its header attributes a human', async () => {
    vi.useFakeTimers()
    const { drawn, session, wrapper } = mountSessionSocket()

    session.connect({ pace: true, paceWhenSpectating: true, paceMs: 100, liveMs: 50 })
    const handlers = socketDouble.handlers[0]
    handlers?.onHeader(header(true))
    handlers?.onState(state(0))
    handlers?.onState(state(1))

    vi.advanceTimersByTime(100)
    await nextTick()
    expect(drawn).toEqual([{ state: state(0), options: { transitionMs: 100 } }])
    wrapper.unmount()
  })

  it('holds a paced result through the cadence after its last frame draws', async () => {
    vi.useFakeTimers()
    const { drawn, session, wrapper } = mountSessionSocket()

    session.connect({ pace: true, paceMs: 100 })
    const handlers = socketDouble.handlers[0]
    handlers?.onState(state(0))
    handlers?.onState(state(1))
    handlers?.onResult?.({ scores: { player_0: 7 }, ticks: 2, reason: 'terminated' })
    handlers?.onSessionStatus?.('ended', 'terminated')

    vi.advanceTimersByTime(100)
    await nextTick()
    expect(drawn).toHaveLength(1)
    expect(session.status.value).toBe('starting')

    vi.advanceTimersByTime(100)
    await nextTick()
    expect(drawn).toHaveLength(2)
    expect(session.status.value).toBe('starting')
    expect(session.finalResult.value).toBeNull()

    vi.advanceTimersByTime(100)
    await nextTick()
    expect(session.status.value).toBe('ended')
    expect(session.finalResult.value?.scores).toEqual({ player_0: 7 })
    wrapper.unmount()
  })

  it('holds an end that arrives after the last paced frame has begun', async () => {
    vi.useFakeTimers()
    const { drawn, session, wrapper } = mountSessionSocket()

    session.connect({ pace: true, paceMs: 100 })
    const handlers = socketDouble.handlers[0]
    handlers?.onState(state(0))
    handlers?.onState(state(1))
    vi.advanceTimersByTime(200)
    await nextTick()
    expect(drawn).toHaveLength(2)

    handlers?.onResult?.({ scores: { player_0: 7 }, ticks: 2, reason: 'terminated' })
    handlers?.onSessionStatus?.('ended', 'terminated')
    expect(session.status.value).toBe('starting')
    vi.advanceTimersByTime(100)
    await nextTick()
    expect(session.status.value).toBe('ended')
    wrapper.unmount()
  })

  it('marks the transport closed when the caller closes it', () => {
    const { session, wrapper } = mountSessionSocket()

    session.connect()
    socketDouble.handlers[0]?.onConnectionChange?.('open')
    session.close()

    expect(session.connection.value).toBe('closed')
    expect(socketDouble.close).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('pauses a watch (paced) session locally with no wire command, freezing the buffer until resume', async () => {
    // `sessionPause: true` proves pacing wins regardless: a watch run's container is usually already
    // gone, so it always pauses playout locally and never sends a command, no matter what the
    // environment's human_pause metadata would otherwise ask for.
    vi.useFakeTimers()
    const { drawn, session, wrapper } = mountSessionSocket()

    session.connect({ pace: true, paceMs: 50, sessionPause: true })
    const handlers = socketDouble.handlers[0]
    handlers?.onState(state(0))
    handlers?.onState(state(1))
    handlers?.onState(state(2)) // fills the lead (150 ms / 50 ms cadence = 3 frames)
    vi.advanceTimersByTime(50)
    await nextTick()
    expect(drawn).toHaveLength(1)

    session.togglePause()
    expect(socketDouble.sent).toEqual([])
    expect(session.paused.value).toBe(true)

    // A frame that arrives while paused still queues, but nothing new draws while paused: the cadence
    // timer keeps running (drainOne no-ops), so the queue holds where it is.
    handlers?.onState(state(3))
    vi.advanceTimersByTime(150)
    await nextTick()
    expect(drawn).toHaveLength(1)

    session.togglePause()
    expect(socketDouble.sent).toEqual([])
    expect(session.paused.value).toBe(false)
    vi.advanceTimersByTime(50)
    await nextTick()
    expect(drawn).toHaveLength(2)

    wrapper.unmount()
  })

  it("holds a watch session's end while paused, revealing it only once resumed and the buffer drains", async () => {
    vi.useFakeTimers()
    const { session, wrapper } = mountSessionSocket()

    session.connect({ pace: true, paceMs: 50 })
    const handlers = socketDouble.handlers[0]
    handlers?.onState(state(0))
    handlers?.onState(state(1))
    handlers?.onState(state(2))
    session.togglePause()

    handlers?.onResult?.({ scores: { player_0: 5 }, ticks: 3, reason: 'terminated' })
    handlers?.onSessionStatus?.('ended', 'terminated')
    // A pause holds the end in every mode, so nothing is revealed even once several cadence ticks pass:
    // drainOne returns immediately while paused, so the queue is never touched either.
    vi.advanceTimersByTime(500)
    await nextTick()
    expect(session.status.value).toBe('starting')
    expect(session.finalResult.value).toBeNull()

    session.togglePause()
    // Draining the three queued frames takes three ticks; the fourth reveals the held end (the last
    // frame's own cadence tick only starts its transition, matching the paced watch behaviour above).
    vi.advanceTimersByTime(50)
    await nextTick()
    expect(session.status.value).toBe('starting')
    vi.advanceTimersByTime(50)
    await nextTick()
    expect(session.status.value).toBe('starting')
    vi.advanceTimersByTime(50)
    await nextTick()
    expect(session.status.value).toBe('starting')
    vi.advanceTimersByTime(50)
    await nextTick()
    expect(session.status.value).toBe('ended')
    expect(session.finalResult.value?.scores).toEqual({ player_0: 5 })

    wrapper.unmount()
  })

  it('reveals an already-held end immediately on stop, sending no command', async () => {
    vi.useFakeTimers()
    const { session, wrapper } = mountSessionSocket()

    session.connect({ pace: true, paceMs: 50 })
    const handlers = socketDouble.handlers[0]
    handlers?.onState(state(0))
    handlers?.onState(state(1))
    handlers?.onState(state(2))
    handlers?.onResult?.({ scores: { player_0: 5 }, ticks: 3, reason: 'terminated' })
    handlers?.onSessionStatus?.('ended', 'terminated')
    // The end is held because frames are still queued (the socket has not drawn anything yet).
    expect(session.status.value).toBe('starting')

    session.stop()
    expect(session.status.value).toBe('ended')
    expect(session.finalResult.value?.scores).toEqual({ player_0: 5 })
    expect(socketDouble.sent).toEqual([])

    wrapper.unmount()
  })

  it('pauses locally, not over the wire, once a session-pause run has already ended', () => {
    // Hearts: the game is over but the last burst is still animating, so the relay has closed the
    // socket along with its `ended` envelope. A Pause click here has to hold the animation locally
    // rather than send a command that nothing is left to receive.
    vi.useFakeTimers()
    const { drawn, session, wrapper } = mountSessionSocket()

    session.connect({ sessionPause: true, liveMs: 900 })
    const handlers = socketDouble.handlers[0]
    handlers?.onState(state(0)) // the leading edge draws at once and opens the throttle window
    handlers?.onState(state(1)) // queued behind it
    handlers?.onSessionStatus?.('ended', 'terminated')
    expect(session.status.value).not.toBe('ended') // held while the burst still has a move to play

    session.togglePause()
    expect(session.paused.value).toBe(true)
    expect(socketDouble.sent).toEqual([])
    vi.advanceTimersByTime(900)
    expect(drawn).toHaveLength(1) // the queued move stays frozen behind the pause

    session.togglePause()
    expect(socketDouble.sent).toEqual([])
    vi.advanceTimersByTime(900)
    expect(drawn).toHaveLength(2)
    vi.advanceTimersByTime(900)
    expect(session.status.value).toBe('ended')

    wrapper.unmount()
  })

  it("clears a stranded session pause when a reconnect's running envelope arrives with no pause echo", () => {
    // The owner clicked Resume; the backend processed it, but the socket dropped before the echo came
    // back. Auto-reconnect never sees a `pause` envelope (the container is not paused), only `running`,
    // so that must be enough on its own to lift a session pause instead of freezing the picture forever.
    const { drawn, session, wrapper } = mountSessionSocket()

    session.connect({ sessionPause: true })
    const handlers = socketDouble.handlers[0]
    handlers?.onState(state(0))
    expect(drawn).toHaveLength(1)

    session.togglePause()
    expect(socketDouble.sent).toEqual([{ kind: 'pause' }])
    handlers?.onPause?.()
    expect(session.paused.value).toBe(true)

    // The game kept running server-side and this frame queued behind the (stranded) local pause flag.
    handlers?.onState(state(1))

    handlers?.onSessionStatus?.('running')
    expect(session.paused.value).toBe(false)
    expect(drawn).toHaveLength(2) // the queued frame plays out once playout resumes
    wrapper.unmount()
  })

  it('leaves the session paused when the reconnect running envelope is followed by a pause echo', () => {
    // The container really is still paused, so the relay's attach replay sends `running` and then its
    // retained `pause` right after — the two-envelope sequence the running-clears-pause fix must not
    // misread as a stranded pause.
    const { session, wrapper } = mountSessionSocket()

    session.connect({ sessionPause: true })
    const handlers = socketDouble.handlers[0]
    session.togglePause()
    handlers?.onPause?.()
    expect(session.paused.value).toBe(true)

    handlers?.onSessionStatus?.('running')
    handlers?.onPause?.()
    expect(session.paused.value).toBe(true)
    wrapper.unmount()
  })

  it('does not clear a playback pause on a running envelope, since it never reached the container', () => {
    const { drawn, session, wrapper } = mountSessionSocket()

    session.connect() // sessionPause defaults to false: a playback-pause environment
    const handlers = socketDouble.handlers[0]
    session.togglePause() // flips locally; there is no container to ask
    expect(socketDouble.sent).toEqual([])
    expect(session.paused.value).toBe(true)

    handlers?.onState(state(0)) // queues behind the local pause
    handlers?.onSessionStatus?.('running')

    expect(session.paused.value).toBe(true)
    expect(drawn).toEqual([]) // still queued: a running envelope never touches a playback pause
    wrapper.unmount()
  })

  it('does not clear pause on a running envelope for a watch (paced) session, even with sessionPause set', async () => {
    // `sessionPause: true` proves pacing still wins here too: a watch run's local pause is never the
    // container's to clear, no matter what the environment's human_pause metadata would otherwise ask.
    vi.useFakeTimers()
    const { drawn, session, wrapper } = mountSessionSocket()

    session.connect({ pace: true, paceMs: 50, sessionPause: true })
    const handlers = socketDouble.handlers[0]
    handlers?.onState(state(0))
    handlers?.onState(state(1))
    handlers?.onState(state(2)) // fills the lead
    session.togglePause()
    expect(socketDouble.sent).toEqual([])
    expect(session.paused.value).toBe(true)

    handlers?.onSessionStatus?.('running')
    expect(session.paused.value).toBe(true)

    vi.advanceTimersByTime(200)
    await nextTick()
    expect(drawn).toEqual([]) // still frozen
    wrapper.unmount()
  })

  it('ignores togglePause before connect(), leaving paused false and sending nothing', () => {
    // SessionPage's owner controls can render before connect() runs (the row resolves after one await,
    // connect after two more). A click in that window must not flip `paused` locally only to have the
    // next connect()'s retireConnection() silently erase it moments later.
    const { session, wrapper } = mountSessionSocket()

    session.togglePause()
    expect(session.paused.value).toBe(false)
    expect(socketDouble.sent).toEqual([])
    expect(socketDouble.handlers).toHaveLength(0) // connect() never ran, so no socket was ever built
    wrapper.unmount()
  })
})
