import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import { RecordingsStore } from '../src/recordings.js'
import { Orchestrator } from '../src/session/orchestrator.js'
import type { Storage } from '../src/storage/index.js'
import { openSqliteStorage } from '../src/storage/sqlite.js'
import { FakeDriver } from './support/fake-driver.js'
import { makeConfig, makeEnvironments } from './support/harness.js'

describe('HTTP API', () => {
  let app: FastifyInstance
  let storage: Storage
  let orchestrator: Orchestrator
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gs-http-'))
    storage = await openSqliteStorage(':memory:')
    orchestrator = new Orchestrator(
      new FakeDriver(),
      storage,
      makeEnvironments(),
      makeConfig({ recordingsDir: dir }),
    )
    app = await buildApp({
      orchestrator,
      environments: makeEnvironments(),
      recordings: new RecordingsStore(dir),
    })
  })

  afterEach(async () => {
    await orchestrator.shutdown()
    await app.close()
    await storage.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists environments with their public metadata', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/environments' })
    expect(res.statusCode).toBe(200)
    const envs = res.json() as Array<{ env_id: string }>
    expect(envs.map((e) => e.env_id)).toContain('flappy_bird')
  })

  it('starts a session and returns its id and websocket path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { env_id: 'flappy_bird', mode: 'scripted' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { id: string; ws_path: string }
    expect(body.ws_path).toBe(`/api/sessions/${body.id}/ws`)

    const row = await app.inject({ method: 'GET', url: `/api/sessions/${body.id}` })
    expect(row.statusCode).toBe(200)
    expect(row.json()).toMatchObject({ id: body.id, env_id: 'flappy_bird', status: 'starting' })
  })

  it('rejects an invalid start body with 400', async () => {
    const noMode = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { env_id: 'flappy_bird' },
    })
    expect(noMode.statusCode).toBe(400)

    const badMode = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { env_id: 'flappy_bird', mode: 'spectate' },
    })
    expect(badMode.statusCode).toBe(400)
  })

  it('enforces one active session per user with 409', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { env_id: 'flappy_bird', mode: 'scripted' },
    })
    expect(first.statusCode).toBe(201)
    const second = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { env_id: 'flappy_bird', mode: 'scripted' },
    })
    expect(second.statusCode).toBe(409)
  })

  it('404s an unknown session and an unknown recording', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/sessions/nope' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/recordings/nope' })).statusCode).toBe(404)
  })

  it('lets the owner delete a session but forbids a stranger', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'x-sandbox-user': 'alice' },
      payload: { env_id: 'flappy_bird', mode: 'scripted' },
    })
    const { id } = created.json() as { id: string }

    const stranger = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${id}`,
      headers: { 'x-sandbox-user': 'mallory' },
    })
    expect(stranger.statusCode).toBe(403)

    const owner = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${id}`,
      headers: { 'x-sandbox-user': 'alice' },
    })
    expect(owner.statusCode).toBe(204)
  })

  it('lists recordings (empty when nothing has been recorded)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/recordings' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })
})
