/**
 * The idle-timeout exit criterion against a real container: a session that no one ever attaches to
 * is killed once its idle window passes, recorded with reason `idle_timeout`, and its container is
 * removed from the host.
 */
import Docker from 'dockerode'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type Stack, startSession, startStack, waitForEnded } from './support/stack.js'

const SESSION_LABEL = 'game-sandbox.session'

async function labeledContainerCount(sessionId: string): Promise<number> {
  const containers = await new Docker().listContainers({
    all: true,
    filters: { label: [`${SESSION_LABEL}=${sessionId}`] },
  })
  return containers.length
}

describe('idle timeout', () => {
  let stack: Stack

  beforeEach(async () => {
    // The idle window must trip before the episode can end on its own: a never-attached human
    // session still steps on the noop fallback, and Flappy Bird's bird falls within ~1.5 s. A
    // 500 ms window fires during container start / the first steps, so idle_timeout is the reason
    // that claims the teardown first (it wins even if the episode terminates during the kill grace).
    stack = await startStack({ sessionIdleTimeoutMs: 500 })
  })

  afterEach(async () => {
    await stack.close()
  })

  it('kills a never-attached session and removes its container', async () => {
    const { id } = await startSession(stack, {
      env_id: 'flappy_bird',
      seats: { seat_0: { kind: 'human' } },
    })

    const row = await waitForEnded(stack, id, 30_000)
    expect(row.termination_reason).toBe('idle_timeout')

    // The container is gone from the host (the driver removes it after the kill).
    expect(await labeledContainerCount(id)).toBe(0)
  })
})
