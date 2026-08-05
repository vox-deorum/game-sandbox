import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import type { SessionSocketHandlers } from '../src/api/socket.js'

const socketDouble = vi.hoisted(() => ({
  handlers: [] as SessionSocketHandlers[],
  connect: vi.fn(),
  close: vi.fn(),
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
    send(): void {}
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
})
