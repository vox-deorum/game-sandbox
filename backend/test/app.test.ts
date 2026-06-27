import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import { RecordingsStore } from '../src/recordings.js'
import { Retention } from '../src/retention.js'
import { Orchestrator } from '../src/session/orchestrator.js'
import type { Storage } from '../src/storage/index.js'
import { openSqliteStorage } from '../src/storage/sqlite.js'
import { FakeDriver } from './support/fake-driver.js'
import { makeConfig, makeEnvironments, makeSubmissionDeps } from './support/harness.js'

const ALLOWLIST = ['dev-user', 'alice', 'bob']

describe('HTTP API', () => {
  let app: FastifyInstance
  let storage: Storage
  let orchestrator: Orchestrator
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gs-http-'))
    storage = await openSqliteStorage(':memory:')
    // Plain public sessions attach to the environment's play-open season; seed it so the start
    // routes are exercised against a normal play-open environment.
    await storage.ensureOpenSeason('flappy_bird', 1)
    const config = makeConfig({ recordingsDir: dir, sessionAllowlist: ALLOWLIST })
    orchestrator = new Orchestrator(new FakeDriver(), storage, makeEnvironments(), config)
    const recordings = new RecordingsStore(dir)
    app = await buildApp({
      orchestrator,
      environments: makeEnvironments(),
      recordings,
      retention: new Retention(storage, recordings, config),
      allowlist: ALLOWLIST,
      ...makeSubmissionDeps(storage, config),
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
      payload: { env_id: 'flappy_bird', slots: { player_0: { kind: 'builtin-agent' } } },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { id: string; ws_path: string }
    expect(body.ws_path).toBe(`/api/sessions/${body.id}/ws`)

    const row = await app.inject({ method: 'GET', url: `/api/sessions/${body.id}` })
    expect(row.statusCode).toBe(200)
    expect(row.json()).toMatchObject({ id: body.id, env_id: 'flappy_bird', status: 'starting' })
  })

  it('rejects an invalid start body with 400', async () => {
    // The old single-`submission_id` shape (no `slots`) is rejected outright.
    const noSlots = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { env_id: 'flappy_bird', mode: 'scripted', submission_id: 'sub-1' },
    })
    expect(noSlots.statusCode).toBe(400)

    const badKind = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { env_id: 'flappy_bird', slots: { player_0: { kind: 'spectate' } } },
    })
    expect(badKind.statusCode).toBe(400)

    // `submission_id` is required exactly for a `submission` slot...
    const submissionNoId = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { env_id: 'flappy_bird', slots: { player_0: { kind: 'submission' } } },
    })
    expect(submissionNoId.statusCode).toBe(400)

    // ...and forbidden on any other kind.
    const agentWithId = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        env_id: 'flappy_bird',
        slots: { player_0: { kind: 'builtin-agent', submission_id: 'sub-1' } },
      },
    })
    expect(agentWithId.statusCode).toBe(400)
  })

  it('enforces one active session per user with 409 and returns the active session id', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { env_id: 'flappy_bird', slots: { player_0: { kind: 'builtin-agent' } } },
    })
    expect(first.statusCode).toBe(201)
    const { id } = first.json() as { id: string }
    const second = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { env_id: 'flappy_bird', slots: { player_0: { kind: 'builtin-agent' } } },
    })
    expect(second.statusCode).toBe(409)
    // The rejoin path reads the active session's id from the body, keyed by the stable code.
    expect(second.json()).toMatchObject({ code: 'already_active', active_session_id: id })
  })

  it('reports identity and allowlist membership at GET /api/me', async () => {
    const mine = await app.inject({ method: 'GET', url: '/api/me' })
    expect(mine.statusCode).toBe(200)
    // The dev mock user is in the default operator allowlist, so it reports as an operator too.
    expect(mine.json()).toEqual({ user_id: 'dev-user', allowlisted: true, is_operator: true })

    const stranger = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { 'x-sandbox-user': 'carol' },
    })
    expect(stranger.json()).toEqual({
      user_id: 'carol',
      allowlisted: false,
      is_operator: false,
    })
  })

  it('rejects a non-allowlisted user starting a human or scripted session with 403', async () => {
    for (const kind of ['human', 'builtin-agent'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { 'x-sandbox-user': 'carol' },
        payload: { env_id: 'flappy_bird', slots: { player_0: { kind } } },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'not_allowlisted' })
    }
  })

  it('keeps read-only routes open to a non-allowlisted user', async () => {
    const headers = { 'x-sandbox-user': 'carol' }
    expect(
      (await app.inject({ method: 'GET', url: '/api/environments', headers })).statusCode,
    ).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/recordings', headers })).statusCode).toBe(
      200,
    )
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
      payload: { env_id: 'flappy_bird', slots: { player_0: { kind: 'builtin-agent' } } },
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

  describe('recordings listing and pinning', () => {
    // Write a recording directory (a header line) plus its retention row, the post-finalize state.
    async function seedRecording(id: string, env: string, user: string): Promise<void> {
      await mkdir(join(dir, id), { recursive: true })
      const header = JSON.stringify({ schema_version: 1, environment: env, seed: 0 })
      await writeFile(join(dir, id, 'recording.jsonl'), `${header}\n`, 'utf-8')
      await storage.createRecording({
        id,
        user_id: user,
        env_id: env,
        created_at: '2026-06-11T00:00:00.000Z',
      })
    }

    it('merges retention metadata into the listing and filters on ?env=', async () => {
      await seedRecording('flappy_bird-1', 'flappy_bird', 'alice')
      await seedRecording('other-1', 'other_env', 'alice')

      const all = (await app.inject({ method: 'GET', url: '/api/recordings' })).json() as Array<{
        id: string
        user_id: string
        pinned: boolean
      }>
      expect(all.map((r) => r.id).sort()).toEqual(['flappy_bird-1', 'other-1'])
      expect(all.find((r) => r.id === 'flappy_bird-1')).toMatchObject({
        user_id: 'alice',
        pinned: false,
      })

      const filtered = (
        await app.inject({ method: 'GET', url: '/api/recordings?env=flappy_bird' })
      ).json() as Array<{ id: string }>
      expect(filtered.map((r) => r.id)).toEqual(['flappy_bird-1'])
    })

    it('pins and unpins owner-only and 404s an unknown recording', async () => {
      await seedRecording('flappy_bird-1', 'flappy_bird', 'alice')

      const stranger = await app.inject({
        method: 'POST',
        url: '/api/recordings/flappy_bird-1/pin',
        headers: { 'x-sandbox-user': 'mallory' },
      })
      expect(stranger.statusCode).toBe(403)

      const owner = await app.inject({
        method: 'POST',
        url: '/api/recordings/flappy_bird-1/pin',
        headers: { 'x-sandbox-user': 'alice' },
      })
      expect(owner.statusCode).toBe(204)
      expect((await storage.getRecording('flappy_bird-1'))?.pinned).toBe(1)

      const unpin = await app.inject({
        method: 'DELETE',
        url: '/api/recordings/flappy_bird-1/pin',
        headers: { 'x-sandbox-user': 'alice' },
      })
      expect(unpin.statusCode).toBe(204)
      expect((await storage.getRecording('flappy_bird-1'))?.pinned).toBe(0)

      const missing = await app.inject({
        method: 'POST',
        url: '/api/recordings/nope/pin',
        headers: { 'x-sandbox-user': 'alice' },
      })
      expect(missing.statusCode).toBe(404)
    })
  })
})
