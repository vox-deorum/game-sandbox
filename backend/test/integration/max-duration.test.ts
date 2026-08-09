/** A small deployment duration override ends a scripted live session before its natural outcome. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type Stack, startSession, startStack, waitForEnded } from './support/stack.js'

describe('session max duration', () => {
  let stack: Stack

  beforeEach(async () => {
    stack = await startStack({
      sessionIdleTimeoutMs: 10_000,
      sessionMaxDurationMs: 500,
    })
  })

  afterEach(async () => {
    await stack.close()
  })

  it('ends a scripted Flappy Bird session with time_limit', async () => {
    const { id } = await startSession(stack, {
      env_id: 'flappy_bird',
      seats: { seat_0: { kind: 'builtin-agent', name: 'naive' } },
    })

    const row = await waitForEnded(stack, id, 30_000)
    expect(row.termination_reason).toBe('time_limit')
  })
})
