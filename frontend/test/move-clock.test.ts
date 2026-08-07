import { describe, expect, it } from 'vitest'

import { MOVE_CLOCK_EMBER_MS, MoveClock } from '../src/renderers/base/move-clock.js'

/** A fake clock, so every assertion below is about the countdown rather than about real time. */
function fakeClock(): { clock: MoveClock; advance: (ms: number) => void } {
  let now = 1000
  return {
    clock: new MoveClock(() => now),
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('the shared human move clock', () => {
  it('counts the budget down to zero and stays there', () => {
    const { clock, advance } = fakeClock()
    clock.open('7', 30_000)
    expect(clock.read()).toEqual({
      totalMs: 30_000,
      remainingMs: 30_000,
      fraction: 1,
      seconds: 30,
      ember: false,
    })

    advance(12_000)
    expect(clock.read()?.remainingMs).toBe(18_000)
    expect(clock.read()?.fraction).toBeCloseTo(0.6)
    expect(clock.read()?.seconds).toBe(18)

    advance(60_000)
    expect(clock.read()).toEqual({
      totalMs: 30_000,
      remainingMs: 0,
      fraction: 0,
      seconds: 0,
      ember: true,
    })
  })

  it('turns urgent inside the closing ten seconds', () => {
    const { clock, advance } = fakeClock()
    clock.open('1', 30_000)
    advance(30_000 - MOVE_CLOCK_EMBER_MS - 1)
    expect(clock.read()?.ember).toBe(false)
    advance(2)
    expect(clock.read()?.ember).toBe(true)
  })

  it('leaves a running countdown alone when the same turn is opened again', () => {
    const { clock, advance } = fakeClock()
    clock.open('4', 30_000)
    advance(9_000)
    clock.open('4', 30_000)
    expect(clock.read()?.remainingMs).toBe(21_000)

    // A new turn is a new budget.
    clock.open('5', 30_000)
    expect(clock.read()?.remainingMs).toBe(30_000)
  })

  it('keeps draining while a viewer holds their own playback paused', () => {
    // A playback pause freezes this viewer's picture, not the session: the harness keeps counting
    // toward the default action, so a wall-clock countdown is the honest reading of it.
    const { clock, advance } = fakeClock()
    clock.open('2', 30_000)
    advance(25_000)
    expect(clock.read()?.remainingMs).toBe(5_000)
    expect(clock.read()?.ember).toBe(true)
  })

  it('restarts on the turn a reconnecting page lands on', () => {
    // Nothing on the wire carries the deadline, so a page that reconnects mid-turn opens the clock
    // again from the session budget. It reads high rather than low, and the harness stays the authority.
    const { clock, advance } = fakeClock()
    clock.open('9', 30_000)
    advance(20_000)
    const reconnected = new MoveClock(() => 0)
    reconnected.open('9', 30_000)
    expect(reconnected.read()?.remainingMs).toBe(30_000)
  })

  it('reads nothing without a turn, without a budget, or once closed', () => {
    const { clock } = fakeClock()
    expect(clock.read()).toBeNull()

    clock.open('1', null)
    expect(clock.read()).toBeNull()
    clock.open('1', 0)
    expect(clock.read()).toBeNull()
    clock.open('1', undefined)
    expect(clock.read()).toBeNull()

    clock.open('1', 30_000)
    expect(clock.read()).not.toBeNull()
    clock.close()
    expect(clock.read()).toBeNull()
  })
})
