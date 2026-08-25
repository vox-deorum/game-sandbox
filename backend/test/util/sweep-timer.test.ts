import { afterEach, describe, expect, it, vi } from 'vitest'

import { SweepTimer } from '../../src/util/sweep-timer.js'

describe('SweepTimer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sweeps immediately and on its interval until stopped', () => {
    vi.useFakeTimers()
    const sweep = vi.fn()
    const timer = new SweepTimer(sweep, 10)

    timer.start()
    expect(sweep).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(10)
    expect(sweep).toHaveBeenCalledTimes(2)

    timer.stop()
    expect(() => timer?.stop()).not.toThrow()
    vi.advanceTimersByTime(20)

    expect(sweep).toHaveBeenCalledTimes(2)
  })
})
