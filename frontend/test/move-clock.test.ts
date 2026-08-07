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

  it('freezes while held and gives back every millisecond of it', () => {
    // Pausing releases the controls, so the harness stops spending the budget. The picture has to say
    // the same thing or the countdown would lie about how long the person really has.
    const { clock, advance } = fakeClock()
    clock.open('2', 30_000)
    advance(5_000)

    clock.hold()
    advance(25_000)
    expect(clock.read()?.remainingMs).toBe(25_000)
    expect(clock.read()?.ember).toBe(false)

    clock.resume()
    expect(clock.read()?.remainingMs).toBe(25_000)
    advance(1_000)
    expect(clock.read()?.remainingMs).toBe(24_000)
  })

  it('ignores a repeated hold and a resume that follows no hold', () => {
    const { clock, advance } = fakeClock()
    clock.open('3', 30_000)
    clock.hold()
    advance(4_000)
    clock.hold() // the frozen instant stands; the second hold is not a fresh one
    advance(4_000)
    clock.resume()
    expect(clock.read()?.remainingMs).toBe(30_000)

    clock.resume() // nothing is held, so nothing is given back
    advance(2_000)
    expect(clock.read()?.remainingMs).toBe(28_000)
  })

  it('opens a turn that arrives while held at its full budget', () => {
    const { clock, advance } = fakeClock()
    clock.hold()
    advance(9_000)
    clock.open('6', 30_000)
    expect(clock.read()?.remainingMs).toBe(30_000)
    clock.resume()
    expect(clock.read()?.remainingMs).toBe(30_000)
  })

  it('restarts on the turn a reconnecting page lands on', () => {
    // The elapsed time lives in the harness, not on the wire, so a page that reconnects mid-turn opens
    // the clock again from the full budget. It reads high rather than low, and the harness decides.
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
