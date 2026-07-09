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
import type { TestUsers } from './support/auth.js'
import { FakeDriver } from './support/fake-driver.js'
import {
  makeConfig,
  makeEnvironments,
  makeSubmissionDeps,
  openTestStack,
} from './support/harness.js'

describe('HTTP API', () => {
  let app: FastifyInstance
  let storage: Storage
  let users: TestUsers
  let orchestrator: Orchestrator
  let dir: string
  let alice: Record<string, string>

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gs-http-'))
    const stack = await openTestStack()
    storage = stack.storage
    users = stack.users
    alice = await users.headersFor('alice')
    // Plain public sessions attach to the environment's play-open season; seed it so the start
    // routes are exercised against a normal play-open environment.
    await storage.ensureOpenSeason('flappy_bird', 1)
    const config = makeConfig({ recordingsDir: dir })
    orchestrator = new Orchestrator(new FakeDriver(), storage, makeEnvironments(), config)
    const recordings = new RecordingsStore(dir)
    app = await buildApp({
      orchestrator,
      environments: makeEnvironments(),
      recordings,
      retention: new Retention(storage, recordings, config),
      auth: stack.auth,
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

  it('serves the deployment branding from GET /api/config, defaulting both names', async () => {
    // The app under test wires no site name, so both fall back to the class-scale default. It also
    // wires no GitHub auth, so the login-page capability flag defaults to false.
    const res = await app.inject({ method: 'GET', url: '/api/config' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      site_name: 'Game Sandbox',
      site_short_name: 'Game Sandbox',
      github_auth: false,
    })
  })

  it('reflects a configured site name and short name in GET /api/config', async () => {
    const config = makeConfig({ recordingsDir: dir })
    const recordings = new RecordingsStore(dir)
    const stack = await openTestStack()
    const custom = await buildApp({
      orchestrator,
      siteName: 'Acme Arena',
      siteShortName: 'Acme',
      environments: makeEnvironments(),
      recordings,
      retention: new Retention(storage, recordings, config),
      auth: stack.auth,
      ...makeSubmissionDeps(storage, config),
    })
    try {
      const res = await custom.inject({ method: 'GET', url: '/api/config' })
      expect(res.json()).toEqual({
        site_name: 'Acme Arena',
        site_short_name: 'Acme',
        github_auth: false,
      })
    } finally {
      await custom.close()
      await stack.storage.close()
    }
  })

  it('reports github_auth true in GET /api/config when GitHub OAuth is configured', async () => {
    const config = makeConfig({ recordingsDir: dir })
    const recordings = new RecordingsStore(dir)
    const stack = await openTestStack()
    const custom = await buildApp({
      orchestrator,
      githubAuth: true,
      environments: makeEnvironments(),
      recordings,
      retention: new Retention(storage, recordings, config),
      auth: stack.auth,
      ...makeSubmissionDeps(storage, config),
    })
    try {
      const res = await custom.inject({ method: 'GET', url: '/api/config' })
      expect((res.json() as { github_auth: boolean }).github_auth).toBe(true)
    } finally {
      await custom.close()
      await stack.storage.close()
    }
  })

  it('starts a session and returns its id and websocket path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: alice,
      payload: { env_id: 'flappy_bird', slots: { player_0: { kind: 'builtin-agent' } } },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { id: string; ws_path: string }
    expect(body.ws_path).toBe(`/api/sessions/${body.id}/ws`)

    const row = await app.inject({ method: 'GET', url: `/api/sessions/${body.id}` })
    expect(row.statusCode).toBe(200)
    expect(row.json()).toMatchObject({ id: body.id, env_id: 'flappy_bird', status: 'starting' })
    // Attribution carries the Better Auth id, not a fabricated dev identity.
    expect((await storage.getSession(body.id))?.user_id).toBe(users.idOf('alice'))
  })

  it('rejects an invalid start body with 400', async () => {
    // The old single-`submission_id` shape (no `slots`) is rejected outright.
    const noSlots = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: alice,
      payload: { env_id: 'flappy_bird', mode: 'scripted', submission_id: 'sub-1' },
    })
    expect(noSlots.statusCode).toBe(400)

    const badKind = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: alice,
      payload: { env_id: 'flappy_bird', slots: { player_0: { kind: 'spectate' } } },
    })
    expect(badKind.statusCode).toBe(400)

    // `submission_id` is required exactly for a `submission` slot...
    const submissionNoId = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: alice,
      payload: { env_id: 'flappy_bird', slots: { player_0: { kind: 'submission' } } },
    })
    expect(submissionNoId.statusCode).toBe(400)

    // ...and forbidden on any other kind.
    const agentWithId = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: alice,
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
      headers: alice,
      payload: { env_id: 'flappy_bird', slots: { player_0: { kind: 'builtin-agent' } } },
    })
    expect(first.statusCode).toBe(201)
    const { id } = first.json() as { id: string }
    const second = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: alice,
      payload: { env_id: 'flappy_bird', slots: { player_0: { kind: 'builtin-agent' } } },
    })
    expect(second.statusCode).toBe(409)
    // The rejoin path reads the active session's id from the body, keyed by the stable code.
    expect(second.json()).toMatchObject({ code: 'already_active', active_session_id: id })
  })

  it('serves the session user and its status at GET /api/me, or a null user when anonymous', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/me' })
    expect(anon.statusCode).toBe(200)
    expect(anon.json()).toEqual({ user: null })

    const mine = await app.inject({ method: 'GET', url: '/api/me', headers: alice })
    expect(mine.statusCode).toBe(200)
    expect(mine.json()).toEqual({
      user: {
        id: users.idOf('alice'),
        name: 'alice',
        email: 'alice@test.local',
        image: null,
        status: 'normal',
      },
    })
  })

  it('round-trips each status at GET /api/me and reports a banned user as anonymous', async () => {
    const pending = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: await users.headersFor('newcomer', { status: 'pending' }),
    })
    expect((pending.json() as { user: { status: string } }).user.status).toBe('pending')

    const admin = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: await users.headersFor('boss', { status: 'admin' }),
    })
    expect((admin.json() as { user: { status: string } }).user.status).toBe('admin')

    // A user banned after their cookie was issued resolves to a null user (revocation proven).
    const doomed = await users.headersFor('doomed')
    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: doomed })).json(),
    ).toMatchObject({ user: { status: 'normal' } })
    await users.ban('doomed')
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: doomed })).json()).toEqual({
      user: null,
    })
  })

  it('rejects a pending user starting a session with 403 not_active', async () => {
    const pending = await users.headersFor('newcomer', { status: 'pending' })
    for (const kind of ['human', 'builtin-agent'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: pending,
        payload: { env_id: 'flappy_bird', slots: { player_0: { kind } } },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'not_active' })
    }
  })

  it('rejects an anonymous session start with 401 auth_required', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { env_id: 'flappy_bird', slots: { player_0: { kind: 'builtin-agent' } } },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'auth_required' })
  })

  it('keeps read-only routes open to an anonymous visitor', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/environments' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/recordings' })).statusCode).toBe(200)
  })

  it('404s an unknown session and an unknown recording', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/sessions/nope' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/recordings/nope' })).statusCode).toBe(404)
  })

  it('lets the owner delete a session but forbids a stranger', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: alice,
      payload: { env_id: 'flappy_bird', slots: { player_0: { kind: 'builtin-agent' } } },
    })
    const { id } = created.json() as { id: string }

    const stranger = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${id}`,
      headers: await users.headersFor('mallory'),
    })
    expect(stranger.statusCode).toBe(403)

    const owner = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${id}`,
      headers: alice,
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
      const ownerId = users.idOf('alice')
      await seedRecording('flappy_bird-1', 'flappy_bird', ownerId)
      await seedRecording('other-1', 'other_env', ownerId)

      const all = (await app.inject({ method: 'GET', url: '/api/recordings' })).json() as Array<{
        id: string
        user_id: string
        pinned: boolean
      }>
      expect(all.map((r) => r.id).sort()).toEqual(['flappy_bird-1', 'other-1'])
      expect(all.find((r) => r.id === 'flappy_bird-1')).toMatchObject({
        user_id: ownerId,
        pinned: false,
      })

      const filtered = (
        await app.inject({ method: 'GET', url: '/api/recordings?env=flappy_bird' })
      ).json() as Array<{ id: string }>
      expect(filtered.map((r) => r.id)).toEqual(['flappy_bird-1'])
    })

    it('pins and unpins owner-only and 404s an unknown recording', async () => {
      await seedRecording('flappy_bird-1', 'flappy_bird', users.idOf('alice'))

      const stranger = await app.inject({
        method: 'POST',
        url: '/api/recordings/flappy_bird-1/pin',
        headers: await users.headersFor('mallory'),
      })
      expect(stranger.statusCode).toBe(403)

      const owner = await app.inject({
        method: 'POST',
        url: '/api/recordings/flappy_bird-1/pin',
        headers: alice,
      })
      expect(owner.statusCode).toBe(204)
      expect((await storage.getRecording('flappy_bird-1'))?.pinned).toBe(1)

      const unpin = await app.inject({
        method: 'DELETE',
        url: '/api/recordings/flappy_bird-1/pin',
        headers: alice,
      })
      expect(unpin.statusCode).toBe(204)
      expect((await storage.getRecording('flappy_bird-1'))?.pinned).toBe(0)

      const missing = await app.inject({
        method: 'POST',
        url: '/api/recordings/nope/pin',
        headers: alice,
      })
      expect(missing.statusCode).toBe(404)
    })

    it('requires a signed-in user to pin', async () => {
      await seedRecording('flappy_bird-1', 'flappy_bird', users.idOf('alice'))
      const res = await app.inject({ method: 'POST', url: '/api/recordings/flappy_bird-1/pin' })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({ code: 'auth_required' })
    })
  })
})
