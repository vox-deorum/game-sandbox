import type { StepState } from '@game-sandbox/schema'
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
  const drawn: StepState[] = []
  const wrapper = mount(
    defineComponent({
      setup() {
        session = useSessionSocket('s1', {
          onHeader: () => {},
          onState: (state) => drawn.push(state),
        })
        return () => h('div')
      },
    }),
  )
  return { drawn, session, wrapper }
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

    expect(drawn.map((entry) => entry.tick)).toEqual([4])
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
