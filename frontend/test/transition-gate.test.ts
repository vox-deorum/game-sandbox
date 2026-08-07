import { describe, expect, it } from 'vitest'

import { TransitionGate } from '../src/renderers/base/transition-gate.js'

/** Whether a promise has settled by the time the microtask queue drains. */
async function settled(promise: Promise<void>): Promise<boolean> {
  return await Promise.race([promise.then(() => true), Promise.resolve().then(() => false)])
}

describe('TransitionGate', () => {
  it('holds the waiter until the transition ends', async () => {
    const gate = new TransitionGate()
    const waiting = gate.wait()
    expect(gate.pending).toBe(true)
    expect(await settled(waiting)).toBe(false)

    gate.settle()
    expect(gate.pending).toBe(false)
    await expect(waiting).resolves.toBeUndefined()
  })

  it('releases a superseded waiter, so a host that moved on is never left hanging', async () => {
    const gate = new TransitionGate()
    const first = gate.wait()
    const second = gate.wait()

    await expect(first).resolves.toBeUndefined()
    expect(await settled(second)).toBe(false)

    gate.settle()
    await expect(second).resolves.toBeUndefined()
  })

  it('settles harmlessly when nothing is waiting', () => {
    const gate = new TransitionGate()
    expect(gate.pending).toBe(false)
    expect(() => {
      gate.settle()
      gate.settle()
    }).not.toThrow()
  })
})
