import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NewSessionInput, Storage } from '../src/storage/index.js'
import { openSqliteStorage } from '../src/storage/sqlite.js'

function input(overrides: Partial<NewSessionInput> = {}): NewSessionInput {
  return {
    id: 'sess-1',
    user_id: 'alice',
    env_id: 'flappy_bird',
    mode: 'human',
    recording_id: 'flappy_bird-sess-1',
    created_at: '2026-06-11T00:00:00.000Z',
    ...overrides,
  }
}

describe('storage on :memory:', () => {
  let storage: Storage

  beforeEach(async () => {
    // The real implementation on an in-memory SQLite, schema and all.
    storage = await openSqliteStorage(':memory:')
  })

  afterEach(async () => {
    await storage.close()
  })

  it('creates a session in the starting state and reads it back', async () => {
    const created = await storage.createSession(input())
    expect(created).toMatchObject({
      id: 'sess-1',
      user_id: 'alice',
      env_id: 'flappy_bird',
      mode: 'human',
      status: 'starting',
      termination_reason: null,
      ended_at: null,
    })
    const fetched = await storage.getSession('sess-1')
    expect(fetched).toEqual(created)
  })

  it('moves a session through running and ended', async () => {
    await storage.createSession(input())
    await storage.markRunning('sess-1')
    expect((await storage.getSession('sess-1'))?.status).toBe('running')

    await storage.markEnded('sess-1', 'terminated', '2026-06-11T00:01:00.000Z')
    const ended = await storage.getSession('sess-1')
    expect(ended?.status).toBe('ended')
    expect(ended?.termination_reason).toBe('terminated')
    expect(ended?.ended_at).toBe('2026-06-11T00:01:00.000Z')
  })

  it('finds a user active session while starting or running, but not once ended', async () => {
    await storage.createSession(input())
    expect(await storage.findActiveSessionByUser('alice')).toBeDefined()

    await storage.markRunning('sess-1')
    expect(await storage.findActiveSessionByUser('alice')).toBeDefined()

    await storage.markEnded('sess-1', 'stopped', '2026-06-11T00:02:00.000Z')
    expect(await storage.findActiveSessionByUser('alice')).toBeUndefined()
  })

  it('keeps users independent for the active-session lookup', async () => {
    await storage.createSession(input({ id: 'a', user_id: 'alice' }))
    await storage.createSession(input({ id: 'b', user_id: 'bob' }))
    expect((await storage.findActiveSessionByUser('alice'))?.id).toBe('a')
    expect((await storage.findActiveSessionByUser('bob'))?.id).toBe('b')
    expect(await storage.findActiveSessionByUser('carol')).toBeUndefined()
  })

  it('lists sessions most recent first', async () => {
    await storage.createSession(input({ id: 'a', created_at: '2026-06-11T00:00:00.000Z' }))
    await storage.createSession(input({ id: 'b', created_at: '2026-06-11T00:05:00.000Z' }))
    const ids = (await storage.listSessions()).map((s) => s.id)
    expect(ids).toEqual(['b', 'a'])
  })

  it('returns undefined for an unknown session', async () => {
    expect(await storage.getSession('nope')).toBeUndefined()
  })
})
