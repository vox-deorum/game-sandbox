import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, watch } from 'vue'
import type { SessionSocketHandlers } from '../src/api/socket.js'
import type { RenderOptions } from '../src/renderers/types.js'

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

/**
 * Mount the composable over a fake renderer. When `deferred` is set, `onState` hands back a promise
 * the test finishes by hand, which is how these tests tell the cadence floor apart from the
 * renderer's actual transition completion.
 */
function mountSessionSocket(deferred = false) {
  let session!: ReturnType<typeof useSessionSocket>
  const drawn: Array<{ state: StepState; options?: RenderOptions }> = []
  const drawnAt: number[] = []
  const finish: Array<() => void> = []
  const wrapper = mount(
    defineComponent({
      setup() {
        session = useSessionSocket('s1', {
          onHeader: () => {},
          onState: (state, options) => {
            drawn.push({ state, options })
            drawnAt.push(Date.now())
            if (!deferred) return
            return new Promise<void>((resolve) => finish.push(resolve))
          },
        })
        return () => h('div')
      },
    }),
  )
  return {
    drawn,
    drawnAt,
    session,
    wrapper,
    /** Complete every transition handed out so far. */
    finishTransitions: () => {
      for (const resolve of finish.splice(0)) resolve()
    },
  }
}

/** The scale a paced host passes for a cadence, relative to the renderer's natural one-second beat. */
function scale(cadenceMs: number): RenderOptions {
  return { transitionScale: cadenceMs / 1000 }
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

/** A state whose single agent spent `decisionMs` thinking, and whose step cost the same wall clock. */
function slowState(tick: number, decisionMs: number): StepState {
  return {
    schema_version: 1,
    tick,
    agents: { player_0: { reward: 0, score: 0, timing: { decision_ms: decisionMs } } },
    timing: { started_at: 0, duration_ms: decisionMs },
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

  // --- who holds the controls ---
  //
  // The container spends a human's move budget only while it believes someone holds the controls, so
  // these transitions are what keep a person from being charged for animations they were only watching.

  describe('reporting who holds the controls', () => {
    /** Connect and open the socket, since nothing is sent over one that is not open yet. */
    function openSession(
      options: Parameters<ReturnType<typeof mountSessionSocket>['session']['connect']>[0] = {},
    ) {
      const mounted = mountSessionSocket()
      mounted.session.connect(options)
      socketDouble.handlers[0]?.onConnectionChange?.('open')
      socketDouble.sent.length = 0
      return mounted
    }

    it('reports a player taking and then releasing the controls', () => {
      const { session, wrapper } = openSession()

      session.setControlHeld('player_0')
      expect(socketDouble.sent).toEqual([{ kind: 'clock', player: 'player_0', running: true }])

      session.setControlHeld(null)
      expect(socketDouble.sent).toEqual([
        { kind: 'clock', player: 'player_0', running: true },
        { kind: 'clock', player: 'player_0', running: false },
      ])
      wrapper.unmount()
    })

    it('closes the previous player before opening the next', () => {
      const { session, wrapper } = openSession()

      session.setControlHeld('player_0')
      socketDouble.sent.length = 0
      session.setControlHeld('player_3')
      expect(socketDouble.sent).toEqual([
        { kind: 'clock', player: 'player_0', running: false },
        { kind: 'clock', player: 'player_3', running: true },
      ])
      wrapper.unmount()
    })

    it('says nothing when the renderer repeats itself or holds nobody', () => {
      const { session, wrapper } = openSession()

      session.setControlHeld(null)
      expect(socketDouble.sent).toEqual([])

      session.setControlHeld('player_0')
      socketDouble.sent.length = 0
      session.setControlHeld('player_0')
      session.setControlHeld('player_0')
      expect(socketDouble.sent).toEqual([])
      wrapper.unmount()
    })

    it('releases the controls on a playback pause and takes them back on resume', () => {
      const { session, wrapper } = openSession({ liveMs: 50 })

      session.setControlHeld('player_0')
      socketDouble.sent.length = 0

      session.togglePause()
      expect(socketDouble.sent).toEqual([{ kind: 'clock', player: 'player_0', running: false }])

      session.togglePause()
      expect(socketDouble.sent).toEqual([
        { kind: 'clock', player: 'player_0', running: false },
        { kind: 'clock', player: 'player_0', running: true },
      ])
      wrapper.unmount()
    })

    it('releases the controls on a session pause too, when its echo lands', () => {
      // A session pause freezes the container's own clock as well, so this is redundant there. Sending
      // it anyway keeps one rule for every environment.
      const { session, wrapper } = openSession({ sessionPause: true })

      session.setControlHeld('player_0')
      socketDouble.sent.length = 0

      socketDouble.handlers[0]?.onPause?.()
      expect(socketDouble.sent).toEqual([{ kind: 'clock', player: 'player_0', running: false }])

      socketDouble.handlers[0]?.onResume?.()
      expect(socketDouble.sent).toEqual([
        { kind: 'clock', player: 'player_0', running: false },
        { kind: 'clock', player: 'player_0', running: true },
      ])
      wrapper.unmount()
    })

    it('re-asserts the open controls after a reconnect', () => {
      // The backend releases the controls when the last owner socket goes away, so a page that comes
      // back has to say again that its person is still holding them.
      const { session, wrapper } = openSession()

      session.setControlHeld('player_0')
      socketDouble.sent.length = 0

      socketDouble.handlers[0]?.onConnectionChange?.('reconnecting')
      expect(socketDouble.sent).toEqual([])

      socketDouble.handlers[0]?.onConnectionChange?.('open')
      expect(socketDouble.sent).toEqual([{ kind: 'clock', player: 'player_0', running: true }])
      wrapper.unmount()
    })

    it('sends nothing over a socket that is not open yet', () => {
      const { session, wrapper } = mountSessionSocket()
      session.connect()
      socketDouble.sent.length = 0

      session.setControlHeld('player_0')
      expect(socketDouble.sent).toEqual([])
      wrapper.unmount()
    })
  })

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
    await vi.advanceTimersByTimeAsync(200)

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

    // Once the lead has passed, playout begins with the frame at the head of the buffer.
    await vi.advanceTimersByTimeAsync(149)
    expect(drawn).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(drawn).toEqual([{ state: state(0), options: scale(100) }])
    await vi.advanceTimersByTimeAsync(100)
    expect(drawn).toHaveLength(2)
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

    // The leading edge is the owner's own move, drawn on arrival at its natural duration.
    expect(drawn).toEqual([{ state: state(0), options: undefined }])
    await vi.advanceTimersByTimeAsync(50)
    expect(drawn).toEqual([
      { state: state(0), options: undefined },
      { state: state(1), options: scale(50) },
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

    await vi.advanceTimersByTimeAsync(150)
    expect(drawn).toEqual([{ state: state(0), options: scale(100) }])
    wrapper.unmount()
  })

  it('holds a paced result until the last frame has met its cadence', async () => {
    vi.useFakeTimers()
    const { drawn, session, wrapper } = mountSessionSocket()

    session.connect({ pace: true, paceMs: 100 })
    const handlers = socketDouble.handlers[0]
    handlers?.onState(state(0))
    handlers?.onState(state(1))
    handlers?.onResult?.({ scores: { player_0: 7 }, ticks: 2, reason: 'terminated' })
    handlers?.onSessionStatus?.('ended', 'terminated')

    await vi.advanceTimersByTimeAsync(0)
    expect(drawn).toHaveLength(1)
    expect(session.status.value).toBe('starting')

    await vi.advanceTimersByTimeAsync(100)
    expect(drawn).toHaveLength(2)
    // Both frames are drawn, but the last one still owes its cadence before game over may show.
    expect(session.status.value).toBe('starting')
    expect(session.finalResult.value).toBeNull()

    await vi.advanceTimersByTimeAsync(100)
    expect(session.status.value).toBe('ended')
    expect(session.finalResult.value?.scores).toEqual({ player_0: 7 })
    wrapper.unmount()
  })

  it('holds a paced end until the final transition finishes, however long it runs', async () => {
    vi.useFakeTimers()
    const { drawn, session, wrapper, finishTransitions } = mountSessionSocket(true)

    session.connect({ pace: true, paceMs: 100 })
    const handlers = socketDouble.handlers[0]
    handlers?.onState(state(0))
    handlers?.onState(state(1))
    handlers?.onResult?.({ scores: { player_0: 7 }, ticks: 2, reason: 'terminated' })
    handlers?.onSessionStatus?.('ended', 'terminated')

    await vi.advanceTimersByTimeAsync(0)
    expect(drawn).toHaveLength(1)

    // The cadence passes repeatedly, but the first frame is still animating, so the second waits.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(drawn).toHaveLength(1)
    expect(session.status.value).toBe('starting')

    finishTransitions()
    await vi.advanceTimersByTimeAsync(0)
    expect(drawn).toHaveLength(2)
    // The last frame's own animation still holds the result back.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(session.status.value).toBe('starting')

    finishTransitions()
    await vi.advanceTimersByTimeAsync(0)
    expect(session.status.value).toBe('ended')
    expect(session.finalResult.value?.scores).toEqual({ player_0: 7 })
    wrapper.unmount()
  })

  it('reveals an end that arrives once the last paced frame has already settled', async () => {
    vi.useFakeTimers()
    const { drawn, session, wrapper } = mountSessionSocket()

    session.connect({ pace: true, paceMs: 100 })
    const handlers = socketDouble.handlers[0]
    handlers?.onState(state(0))
    handlers?.onState(state(1))
    // The 150 ms lead, then one cadence for each frame.
    await vi.advanceTimersByTimeAsync(350)
    expect(drawn).toHaveLength(2)

    handlers?.onResult?.({ scores: { player_0: 7 }, ticks: 2, reason: 'terminated' })
    handlers?.onSessionStatus?.('ended', 'terminated')
    await vi.advanceTimersByTimeAsync(0)
    expect(session.status.value).toBe('ended')
    wrapper.unmount()
  })

  it('keeps every queued frame, in order, however bursty the arrivals', async () => {
    vi.useFakeTimers()
    const { drawn, session, wrapper } = mountSessionSocket()

    session.connect({ pace: true, paceMs: 50 })
    const handlers = socketDouble.handlers[0]
    for (let tick = 0; tick < 6; tick++) handlers?.onState(state(tick))
    await vi.advanceTimersByTimeAsync(500)

    expect(drawn.map((entry) => entry.state.tick)).toEqual([0, 1, 2, 3, 4, 5])
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
    handlers?.onState(state(2))
    await vi.advanceTimersByTimeAsync(150)
    expect(drawn).toHaveLength(1)

    session.togglePause()
    expect(socketDouble.sent).toEqual([])
    expect(session.paused.value).toBe(true)

    // A frame that arrives while paused still queues, and the pump stops at its next step, so the
    // queue holds exactly where it is.
    handlers?.onState(state(3))
    await vi.advanceTimersByTimeAsync(150)
    expect(drawn).toHaveLength(1)

    session.togglePause()
    expect(socketDouble.sent).toEqual([])
    expect(session.paused.value).toBe(false)
    // Resuming starts a fresh lead before the backlog plays.
    await vi.advanceTimersByTimeAsync(150)
    expect(drawn).toHaveLength(2)
    // Nothing was dropped while paused: the whole backlog still plays out in order.
    await vi.advanceTimersByTimeAsync(100)
    expect(drawn.map((entry) => entry.state.tick)).toEqual([0, 1, 2, 3])

    wrapper.unmount()
  })

  // --- the watch jitter buffer ---
  //
  // Frames reach a watch viewer unevenly. Playout runs a fixed 150 ms behind the stream, so a frame up to
  // that late still lands on its slot, and the waiting indicator appears only when the network has
  // really gone quiet. These record when each frame is drawn, since a visible pause is a gap in time.

  describe('the watch jitter buffer', () => {
    const CADENCE = 250

    /** A watch session whose `buffering` flag is watched synchronously, so even a flash is caught. */
    function watchSession() {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      const mounted = mountSessionSocket()
      mounted.session.connect({ pace: true, paceMs: CADENCE })
      const handlers = socketDouble.handlers[0]
      const bufferingSeen: number[] = []
      watch(
        mounted.session.buffering,
        (value) => {
          if (value) bufferingSeen.push(Date.now())
        },
        { flush: 'sync' },
      )
      /** Advance fake time to `at`, then deliver the frame for `tick`. */
      async function arrive(at: number, tick: number) {
        await vi.advanceTimersByTimeAsync(at - Date.now())
        handlers?.onState(state(tick))
      }
      /** Advance fake time to `at`. */
      async function until(at: number) {
        await vi.advanceTimersByTimeAsync(at - Date.now())
      }
      return { ...mounted, handlers, bufferingSeen, arrive, until }
    }

    /** The time between consecutive draws. */
    function gaps(times: number[]): number[] {
      return times.slice(1).map((time, index) => time - (times[index] as number))
    }

    /** A small deterministic generator, so the jitter is varied but every run sees the same values. */
    function seededLateness(count: number, low: number, high: number): number[] {
      let seed = 7
      return Array.from({ length: count }, () => {
        seed = (seed * 1103515245 + 12345) % 2147483648
        return low + (seed % (high - low + 1))
      })
    }

    it('keeps an exact cadence while every frame is at most 140 ms late', async () => {
      const { drawn, drawnAt, handlers, bufferingSeen, arrive, until, wrapper } = watchSession()
      const lateness = seededLateness(20, 0, 140)

      for (const [tick, late] of lateness.entries()) await arrive(tick * CADENCE + late, tick)
      handlers?.onSessionStatus?.('ended', 'terminated')
      await until(20 * CADENCE + 1_000)

      expect(drawn.map((entry) => entry.state.tick)).toEqual([...Array(20).keys()])
      expect(gaps(drawnAt)).toEqual(Array(19).fill(CADENCE))
      expect(bufferingSeen).toEqual([])
      wrapper.unmount()
    })

    it('pauses once for a frame beyond the lead, then holds the cadence behind it', async () => {
      const { drawnAt, handlers, bufferingSeen, arrive, until, wrapper } = watchSession()
      // Frame 3 is 300 ms late, and every frame after it is also late by 100 to 300 ms.
      const lateness = [0, 90, 140, 300, ...seededLateness(8, 100, 300)]

      for (const [tick, late] of lateness.entries()) await arrive(tick * CADENCE + late, tick)
      handlers?.onSessionStatus?.('ended', 'terminated')
      await until(lateness.length * CADENCE + 1_000)

      // The one visible pause is 250 + 300 ms: the part of the lateness past the lead, plus a fresh lead.
      expect(gaps(drawnAt)).toEqual([CADENCE, CADENCE, 550, ...Array(8).fill(CADENCE)])
      expect(bufferingSeen).toEqual([])
      wrapper.unmount()
    })

    it('does not flash the indicator when a frame refills the buffer during its lead', async () => {
      const { drawnAt, bufferingSeen, arrive, until, wrapper } = watchSession()

      await arrive(0, 0)
      // Drawn at 150, and the buffer runs dry at 400 once that frame has served its cadence.
      await arrive(700, 1)
      await until(1_000)

      expect(drawnAt).toEqual([150, 850])
      expect(bufferingSeen).toEqual([])
      wrapper.unmount()
    })

    it('shows the indicator after 400 ms of silence and clears it on the next frame', async () => {
      const { session, drawnAt, arrive, until, wrapper } = watchSession()

      await arrive(0, 0)
      await until(799)
      expect(session.buffering.value).toBe(false)
      await until(800)
      expect(session.buffering.value).toBe(true)

      await arrive(1_400, 1)
      expect(session.buffering.value).toBe(false)
      await until(1_550)
      expect(drawnAt).toEqual([150, 1_550])
      wrapper.unmount()
    })

    it('clears the indicator on pause, and plays after a fresh lead on resume', async () => {
      const { session, drawnAt, arrive, until, wrapper } = watchSession()

      await arrive(0, 0)
      await until(800)
      expect(session.buffering.value).toBe(true)

      session.togglePause()
      expect(session.buffering.value).toBe(false)
      await arrive(1_000, 1)
      await until(1_400)
      expect(drawnAt).toEqual([150])
      expect(session.buffering.value).toBe(false)

      session.togglePause()
      await until(1_549)
      expect(drawnAt).toEqual([150])
      await until(1_550)
      expect(drawnAt).toEqual([150, 1_550])
      wrapper.unmount()
    })

    // Frame 0 is drawn at 150 and holds its cadence until 400. The pause and resume both fall inside it,
    // and frame 1 waits for whichever ends later: that cadence, or the fresh lead from the resume.
    it.each([
      { resumeAt: 300, expected: [150, 450, 700] },
      { resumeAt: 170, expected: [150, 400, 650] },
    ])('after a resume at $resumeAt, waits for both the current frame and a fresh lead', async ({
      resumeAt,
      expected,
    }) => {
      const { session, drawnAt, arrive, until, wrapper } = watchSession()

      await arrive(0, 0)
      await arrive(10, 1)
      await arrive(20, 2)
      await until(160)
      session.togglePause()
      await until(resumeAt)
      session.togglePause()
      await until(1_000)

      expect(drawnAt).toEqual(expected)
      wrapper.unmount()
    })
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
    // A pause holds the end in every mode, so nothing is revealed even once several cadences pass:
    // the pump stops while paused, so the queue is never touched either.
    await vi.advanceTimersByTimeAsync(500)
    expect(session.status.value).toBe('starting')
    expect(session.finalResult.value).toBeNull()

    session.togglePause()
    // Playing out the three queued frames takes a cadence each; only once the last has met its own
    // cadence does the held end surface.
    await vi.advanceTimersByTimeAsync(0)
    expect(session.status.value).toBe('starting')
    await vi.advanceTimersByTimeAsync(50)
    expect(session.status.value).toBe('starting')
    await vi.advanceTimersByTimeAsync(50)
    expect(session.status.value).toBe('starting')
    await vi.advanceTimersByTimeAsync(50)
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

  it('pauses locally, not over the wire, once a session-pause run has already ended', async () => {
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
    await vi.advanceTimersByTimeAsync(900)
    expect(drawn).toHaveLength(1) // the queued move stays frozen behind the pause

    session.togglePause()
    expect(socketDouble.sent).toEqual([])
    // The leading edge already served its cadence before the pause, so the queued move plays at once.
    await vi.advanceTimersByTimeAsync(0)
    expect(drawn).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(900)
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

  it('waits for the retained initial pause before starting and drops pre-start input', () => {
    const { session, wrapper } = mountSessionSocket()
    session.connect({ sessionPause: true })
    socketDouble.handlers[0]?.onConnectionChange?.('open')
    socketDouble.sent.length = 0
    const handlers = socketDouble.handlers[0]

    handlers?.onSessionStatus?.('running', undefined, true)
    expect(session.awaitingStart.value).toBe(true)
    expect(session.canStart.value).toBe(false)
    session.send({ kind: 'input', player: 'player_0', action: 1 })
    session.send({ kind: 'chat', player: 'player_0', to: null, text: 'ready' })
    expect(socketDouble.sent).toEqual([])

    handlers?.onPause?.()
    expect(session.paused.value).toBe(true)
    expect(session.canStart.value).toBe(true)
    session.togglePause()
    expect(socketDouble.sent).toEqual([])
    session.start()
    expect(session.startPending.value).toBe(true)
    expect(socketDouble.sent).toEqual([{ kind: 'resume' }])

    handlers?.onResume?.()
    expect(session.awaitingStart.value).toBe(false)
    expect(session.startPending.value).toBe(false)
    expect(session.paused.value).toBe(false)
    wrapper.unmount()
  })

  it('recovers a lost initial resume from a false running replay without lifting a later playback pause', () => {
    const { session, wrapper } = mountSessionSocket()
    session.connect()
    socketDouble.handlers[0]?.onConnectionChange?.('open')
    socketDouble.sent.length = 0
    const handlers = socketDouble.handlers[0]

    handlers?.onSessionStatus?.('running', undefined, true)
    handlers?.onPause?.()
    session.start()
    expect(session.startPending.value).toBe(true)

    handlers?.onConnectionChange?.('reconnecting')
    handlers?.onConnectionChange?.('open')
    handlers?.onSessionStatus?.('running', undefined, false)
    expect(session.awaitingStart.value).toBe(false)
    expect(session.startPending.value).toBe(false)
    expect(session.paused.value).toBe(false)

    session.togglePause()
    expect(session.paused.value).toBe(true)
    handlers?.onSessionStatus?.('running', undefined, false)
    expect(session.paused.value).toBe(true)
    wrapper.unmount()
  })

  it('keeps the retained gate pause through a still-gated running replay after reconnect', () => {
    const { session, wrapper } = mountSessionSocket()
    session.connect({ sessionPause: true })
    socketDouble.handlers[0]?.onConnectionChange?.('open')
    const handlers = socketDouble.handlers[0]

    handlers?.onSessionStatus?.('running', undefined, true)
    handlers?.onPause?.()
    expect(session.canStart.value).toBe(true)

    // The transport reconnects on its own; the relay replays the still-open gate. The retained
    // pause must survive the running frame, and readiness returns only with the new pause echo.
    handlers?.onConnectionChange?.('reconnecting')
    expect(session.canStart.value).toBe(false)
    handlers?.onConnectionChange?.('open')
    handlers?.onSessionStatus?.('running', undefined, true)
    expect(session.paused.value).toBe(true)
    expect(session.awaitingStart.value).toBe(true)
    expect(session.canStart.value).toBe(false)
    handlers?.onPause?.()
    expect(session.canStart.value).toBe(true)
    wrapper.unmount()
  })

  // --- why the picture is standing still ---
  //
  // A stalled session and a dropped connection look identical on screen, so the page has to name which
  // one it is. These cover the composable's half: sampling the timing every state already carries, and
  // staying quiet whenever some other part of the chrome already explains the stillness.

  describe('reporting session health', () => {
    /** Connect, open, and run the session so the health gate is not held shut by `starting`. */
    function runningSession() {
      const mounted = mountSessionSocket()
      mounted.session.connect({ stepIntervalMs: 250 })
      const handlers = socketDouble.handlers[0]
      handlers?.onConnectionChange?.('open')
      handlers?.onHeader(header(false))
      handlers?.onSessionStatus?.('running')
      return { ...mounted, handlers }
    }

    /** Deliver enough slow ticks for the smoothing to settle on them. */
    function feedSlowTicks(handlers: SessionSocketHandlers | undefined, decisionMs: number) {
      for (let tick = 0; tick < 12; tick += 1) {
        vi.advanceTimersByTime(decisionMs)
        handlers?.onState?.(slowState(tick, decisionMs))
      }
    }

    beforeEach(() => vi.useFakeTimers())

    it('stays quiet while a session keeps up with its cadence', () => {
      const { session, handlers, wrapper } = runningSession()

      for (let tick = 0; tick < 12; tick += 1) {
        vi.advanceTimersByTime(250)
        handlers?.onState?.(slowState(tick, 40))
      }

      expect(session.health.value).toBeNull()
      wrapper.unmount()
    })

    it('names the agent behind a slow tick, from the timing the state already carries', () => {
      const { session, handlers, wrapper } = runningSession()

      feedSlowTicks(handlers, 2100)

      expect(session.health.value).toEqual({ label: 'P0 2.1s', tone: 'warning' })
      wrapper.unmount()
    })

    it('calls out silence once frames stop arriving, without waiting for one to explain it', () => {
      const { session, handlers, wrapper } = runningSession()

      vi.advanceTimersByTime(250)
      handlers?.onState?.(slowState(0, 40))
      expect(session.health.value).toBeNull()
      // Nothing more arrives. The interval keeps the verdict moving on its own.
      vi.advanceTimersByTime(8000)

      expect(session.health.value).toEqual({ label: 'No signal', tone: 'danger' })
      wrapper.unmount()
    })

    it('starts fresh after a long session pause', () => {
      const { session, handlers, wrapper } = runningSession()
      feedSlowTicks(handlers, 2100)

      handlers?.onPause?.()
      expect(session.health.value).toBeNull()
      vi.advanceTimersByTime(30_000)

      handlers?.onResume?.()
      expect(session.health.value).toBeNull()
      vi.advanceTimersByTime(250)
      handlers?.onState(slowState(12, 40))
      expect(session.health.value).toBeNull()
      wrapper.unmount()
    })

    it('does not count time spent at Start as delivery delay', () => {
      const { session, handlers, wrapper } = runningSession()
      handlers?.onState(state(0))
      handlers?.onSessionStatus?.('running', undefined, true)
      handlers?.onPause?.()
      vi.advanceTimersByTime(30_000)
      handlers?.onResume?.()
      expect(session.health.value).toBeNull()
      handlers?.onState(slowState(1, 40))
      expect(session.health.value).toBeNull()
      wrapper.unmount()
    })

    it('resets health after a browser playback pause', () => {
      const { session, handlers, wrapper } = runningSession()
      handlers?.onState(slowState(0, 40))
      session.togglePause()
      vi.advanceTimersByTime(30_000)
      // The live producer can still send frames while this browser has paused playback.
      handlers?.onState(slowState(1, 40))
      session.togglePause()
      expect(session.health.value).toBeNull()
      handlers?.onState(slowState(2, 40))
      expect(session.health.value).toBeNull()
      wrapper.unmount()
    })

    it('says nothing once the session has ended, leaving the outcome to the status badge', () => {
      const { session, handlers, wrapper } = runningSession()
      feedSlowTicks(handlers, 2100)

      handlers?.onSessionStatus?.('ended', 'completed')

      expect(session.health.value).toBeNull()
      // The measuring interval is retired with the run, so silence cannot resurrect a verdict.
      vi.advanceTimersByTime(30_000)
      expect(session.health.value).toBeNull()
      wrapper.unmount()
    })

    it('does not carry a verdict or outage time across an automatic reconnect', () => {
      const { session, handlers, wrapper } = runningSession()
      feedSlowTicks(handlers, 2100)
      expect(session.health.value).not.toBeNull()

      handlers?.onConnectionChange?.('reconnecting')
      vi.advanceTimersByTime(30_000)
      handlers?.onConnectionChange?.('open')
      handlers?.onHeader(header(false))
      // Attach replays the current state on the same handlers, before running status.
      handlers?.onState(slowState(20, 40))
      handlers?.onSessionStatus?.('running')

      expect(session.health.value).toBeNull()
      vi.advanceTimersByTime(4000)
      expect(session.health.value?.label).toBe('No signal')
      wrapper.unmount()
    })

    it('retires health when a terminal stream still has buffered playback', async () => {
      const { session, wrapper, drawn } = mountSessionSocket()
      session.connect({ pace: true, paceMs: 3000 })
      const handlers = socketDouble.handlers[0]
      handlers?.onConnectionChange?.('open')
      handlers?.onHeader(header(false))
      handlers?.onSessionStatus?.('running')
      for (let tick = 0; tick < 10; tick += 1) handlers?.onState(slowState(tick, 40))
      handlers?.onSessionStatus?.('ended', 'completed')
      handlers?.onConnectionChange?.('closed')

      await vi.advanceTimersByTimeAsync(8000)
      expect(session.status.value).toBe('running')
      expect(drawn.length).toBeGreaterThan(1)
      expect(drawn.length).toBeLessThan(10)
      expect(session.health.value).toBeNull()

      await vi.advanceTimersByTimeAsync(30_000)
      expect(session.status.value).toBe('ended')
      expect(session.health.value).toBeNull()
      wrapper.unmount()
    })

    it('allows unpaced human deliberation and still reports slow agent hooks', () => {
      const { session, wrapper } = mountSessionSocket()
      session.connect({ paceMs: 3000, stepIntervalMs: null })
      const handlers = socketDouble.handlers[0]
      handlers?.onConnectionChange?.('open')
      handlers?.onHeader(header(true))
      handlers?.onState(state(0))
      handlers?.onSessionStatus?.('running')

      vi.advanceTimersByTime(30_000)
      expect(session.health.value).toBeNull()
      handlers?.onState({
        ...state(1),
        agents: { player_0: { reward: 0, score: 0, action: 1 } },
        timing: { started_at: 0, duration_ms: 30_000 },
      })
      expect(session.health.value).toBeNull()
      for (let tick = 2; tick < 14; tick += 1) {
        vi.advanceTimersByTime(2400)
        handlers?.onState({
          ...slowState(tick, 2400),
          agents: { player_1: { reward: 0, score: 0, timing: { decision_ms: 2400 } } },
        })
      }
      expect(session.health.value).toEqual({ label: 'P1 2.4s', tone: 'warning' })
      wrapper.unmount()
    })

    it('keeps silence detection for paced sessions with a human player', () => {
      const { session, handlers, wrapper } = runningSession()
      handlers?.onHeader(header(true))
      handlers?.onState(state(0))
      vi.advanceTimersByTime(8000)
      expect(session.health.value?.label).toBe('No signal')
      wrapper.unmount()
    })

    it('measures arrival at the transport, so a watch buffer is never mistaken for a slow link', () => {
      // Paced playout holds frames back deliberately. Sampling on arrival rather than on draw is what
      // keeps that deliberate delay from reading as a carrier problem.
      const mounted = mountSessionSocket()
      mounted.session.connect({ pace: true, paceMs: 250, stepIntervalMs: 250 })
      const handlers = socketDouble.handlers[0]
      handlers?.onConnectionChange?.('open')
      handlers?.onHeader(header(false))
      handlers?.onSessionStatus?.('running')

      for (let tick = 0; tick < 12; tick += 1) {
        vi.advanceTimersByTime(250)
        handlers?.onState?.(slowState(tick, 40))
      }

      expect(mounted.session.health.value).toBeNull()
      mounted.wrapper.unmount()
    })
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
