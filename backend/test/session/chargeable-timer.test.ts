import { afterEach, describe, expect, it, vi } from 'vitest'

import { createChargeableTimer } from '../../src/session/chargeable-timer.js'

describe('chargeable timer', () => {
  afterEach(() => vi.useRealTimers())

  it('expires at the wall-clock budget without an LLM counter', async () => {
    vi.useFakeTimers()
    const onExpire = vi.fn()
    createChargeableTimer({ budgetMs: 10, source: 'session', context: 'session s1', onExpire })

    await vi.advanceTimersByTimeAsync(10)

    expect(onExpire).toHaveBeenCalledOnce()
  })

  it('discounts only counter growth after the timer starts', async () => {
    vi.useFakeTimers()
    let inFlightMs = 7
    const onExpire = vi.fn()
    createChargeableTimer({
      budgetMs: 10,
      inFlightMs: () => inFlightMs,
      source: 'session',
      context: 'session s1',
      onExpire,
    })

    inFlightMs = 17
    await vi.advanceTimersByTimeAsync(10)
    expect(onExpire).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10)
    expect(onExpire).toHaveBeenCalledOnce()
  })

  it('does not bridge an unavailable sample', async () => {
    vi.useFakeTimers()
    let reads = 0
    const onExpire = vi.fn()
    createChargeableTimer({
      budgetMs: 10,
      inFlightMs: () => {
        reads += 1
        if (reads === 2) throw new Error('proxy unavailable')
        return reads === 1 ? 100 : 200
      },
      source: 'session',
      context: 'session s1',
      onExpire,
    })

    await vi.advanceTimersByTimeAsync(10)

    expect(onExpire).toHaveBeenCalledOnce()
  })

  it('caps counter growth at the matching wall interval', async () => {
    vi.useFakeTimers()
    let inFlightMs = 0
    const onExpire = vi.fn()
    createChargeableTimer({
      budgetMs: 10,
      inFlightMs: () => inFlightMs,
      source: 'session',
      context: 'session s1',
      onExpire,
    })

    inFlightMs = 100
    await vi.advanceTimersByTimeAsync(10)
    expect(onExpire).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10)
    expect(onExpire).toHaveBeenCalledOnce()
  })

  it('can be stopped before expiration', async () => {
    vi.useFakeTimers()
    const onExpire = vi.fn()
    const timer = createChargeableTimer({
      budgetMs: 10,
      source: 'session',
      context: 'session s1',
      onExpire,
    })

    timer.stop()
    await vi.advanceTimersByTimeAsync(20)

    expect(timer.timedOut()).toBe(false)
    expect(onExpire).not.toHaveBeenCalled()
  })
})
