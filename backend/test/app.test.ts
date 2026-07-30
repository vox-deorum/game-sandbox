import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Storage } from '../src/storage/index.js'
import type { TestUsers } from './support/auth.js'
import { openTestApp, type TestApp } from './support/harness.js'

describe('HTTP API', () => {
  let app: FastifyInstance
  let fixture: TestApp
  let storage: Storage
  let users: TestUsers
  let dir: string
  let alice: Record<string, string>
  let playSeasonId: string
  let simultaneousSeasonId: string

  beforeEach(async () => {
    fixture = await openTestApp()
    app = fixture.app
    storage = fixture.storage
    users = fixture.users
    dir = fixture.config.recordingsDir
    alice = await users.headersFor('alice')
    // Plain public sessions attach to the environment's play-open season; seed it so the start
    // routes are exercised against a normal play-open environment.
    playSeasonId = (await storage.ensureOpenSeason('flappy_bird', 1)).id
    simultaneousSeasonId = (await storage.ensureOpenSeason('simultaneous', 1)).id
  })

  afterEach(async () => {
    await fixture.close()
  })

  function startPayload(seats: Record<string, unknown>): Record<string, unknown> {
    return {
      env_id: 'flappy_bird',
      season_id: playSeasonId,
      parameters: { players: 1, pipe_gap: 100 },
      seats,
    }
  }

  it('lists environments with their public metadata', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/environments' })
    expect(res.statusCode).toBe(200)
    const envs = res.json() as Array<{ env_id: string }>
    expect(envs.map((e) => e.env_id)).toContain('flappy_bird')
  })

  it('returns the active season and resolved play parameter defaults', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/environments/flappy_bird/play-parameters',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ season_id: playSeasonId, values: { players: 1, pipe_gap: 100 } })
  })

  // Season overrides are checked against the environment's declarations when an operator writes them
  // and never again, so an environment that later tightens a bound (or changes its player bounds, which
  // moves the synthesized `players` range) leaves a stored override the current declarations reject.
  // That is an operator problem. It must not take public play offline, and above all it must not be
  // reported to a player as a fault in the settings they submitted.
  describe('a season override the current declarations reject', () => {
    beforeEach(async () => {
      // Written through storage, the way a config saved against older declarations survives: the
      // storage codec is structure-only, so only the admin API would have refused this.
      await storage.updateSeasonConfig(playSeasonId, {
        deps_version: 1,
        matches: [],
        overrides: { parameters: { pipe_gap: 9999 } },
      })
    })

    it('still serves the prefill, falling back to the environment default', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/environments/flappy_bird/play-parameters',
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        season_id: playSeasonId,
        values: { players: 1, pipe_gap: 100 },
      })
    })

    it('still starts a session from a valid submitted map', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: alice,
        payload: startPayload({ seat_0: { kind: 'builtin-agent', name: 'naive' } }),
      })
      expect(res.statusCode).toBe(201)
      const { id } = res.json() as { id: string }
      expect((await storage.getSession(id))?.parameters).toEqual({ players: 1, pipe_gap: 100 })
    })
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
    const custom = await openTestApp({
      siteName: 'Acme Arena',
      siteShortName: 'Acme',
    })
    try {
      const res = await custom.app.inject({ method: 'GET', url: '/api/config' })
      expect(res.json()).toEqual({
        site_name: 'Acme Arena',
        site_short_name: 'Acme',
        github_auth: false,
      })
    } finally {
      // The fixture owns several resources, and cleanup remains safe for nested test helpers.
      await custom.close()
      await custom.close()
    }
  })

  it('reports github_auth true in GET /api/config when GitHub OAuth is configured', async () => {
    const custom = await openTestApp({
      githubAuth: true,
    })
    try {
      const res = await custom.app.inject({ method: 'GET', url: '/api/config' })
      expect((res.json() as { github_auth: boolean }).github_auth).toBe(true)
    } finally {
      await custom.close()
    }
  })

  it('starts a session and returns its id and websocket path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: alice,
      payload: startPayload({ seat_0: { kind: 'builtin-agent', name: 'naive' } }),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { id: string; ws_path: string }
    expect(body.ws_path).toBe(`/api/sessions/${body.id}/ws`)

    const row = await app.inject({ method: 'GET', url: `/api/sessions/${body.id}` })
    expect(row.statusCode).toBe(200)
    // The detail carries the stable owner id plus the resolved display name beside it.
    expect(row.json()).toMatchObject({
      id: body.id,
      env_id: 'flappy_bird',
      status: 'starting',
      user_id: users.idOf('alice'),
      user_name: 'alice',
    })
    expect(row.json()).not.toHaveProperty('github_username')
    // Attribution carries the Better Auth id, not a fabricated dev identity.
    expect((await storage.getSession(body.id))?.user_id).toBe(users.idOf('alice'))
    expect((await storage.getSession(body.id))?.parameters).toEqual({ players: 1, pipe_gap: 100 })
  })

  it('rejects a direct simultaneous human-timeout override before creating a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: alice,
      payload: {
        env_id: 'simultaneous',
        season_id: simultaneousSeasonId,
        parameters: { players: 1, pipe_gap: 100 },
        human_timeout_ms: 2000,
        seats: { seat_0: { kind: 'human' } },
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'human_timeout_not_allowed' })
    expect(await storage.listSessions()).toEqual([])
  })

  it('omits the session detail user_name when the owner id has no user row', async () => {
    await storage.createSession({
      id: 'sess-ghost',
      user_id: 'ghost-user',
      env_id: 'flappy_bird',
      parameters: { players: 1 },
      mode: 'scripted',
      recording_id: null,
      created_at: new Date().toISOString(),
    })
    const res = await app.inject({ method: 'GET', url: '/api/sessions/sess-ghost' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ user_id: 'ghost-user' })
    expect(res.json()).not.toHaveProperty('user_name')
  })

  it('rejects an invalid start body with 400', async () => {
    // The old single-`submission_id` shape (no `seats`) is rejected outright.
    const noSeats = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: alice,
      payload: { env_id: 'flappy_bird', mode: 'scripted', submission_id: 'sub-1' },
    })
    expect(noSeats.statusCode).toBe(400)

    const badKind = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: alice,
      payload: { env_id: 'flappy_bird', seats: { seat_0: { kind: 'spectate' } } },
    })
    expect(badKind.statusCode).toBe(400)

    // `submission_id` is required exactly for a `submission` seat.
    const submissionNoId = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: alice,
      payload: { env_id: 'flappy_bird', seats: { seat_0: { kind: 'submission' } } },
    })
    expect(submissionNoId.statusCode).toBe(400)

    // ...and forbidden on any other kind.
    const agentWithId = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: alice,
      payload: {
        env_id: 'flappy_bird',
        seats: { seat_0: { kind: 'builtin-agent', submission_id: 'sub-1' } },
      },
    })
    expect(agentWithId.statusCode).toBe(400)
  })

  it('accepts the human companion wire shape before singleton layout validation rejects it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: alice,
      payload: startPayload({
        seat_0: { kind: 'human', companion: { kind: 'builtin-agent', name: 'naive' } },
      }),
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toContain(
      'singleton seat seat_0 cannot have a companion',
    )
  })

  it('enforces one active session per user with 409 and returns the active session id', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: alice,
      payload: startPayload({ seat_0: { kind: 'builtin-agent', name: 'naive' } }),
    })
    expect(first.statusCode).toBe(201)
    const { id } = first.json() as { id: string }
    const second = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: alice,
      payload: startPayload({ seat_0: { kind: 'builtin-agent', name: 'naive' } }),
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
        github_username: null,
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
    for (const assignment of [
      { kind: 'human' as const },
      { kind: 'builtin-agent' as const, name: 'naive' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: pending,
        payload: startPayload({ seat_0: assignment }),
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'not_active' })
    }
  })

  it('rejects an anonymous session start with 401 auth_required', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: startPayload({ seat_0: { kind: 'builtin-agent', name: 'naive' } }),
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
      payload: startPayload({ seat_0: { kind: 'builtin-agent', name: 'naive' } }),
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
      const header = JSON.stringify({
        schema_version: 1,
        environment: env,
        parameters: {},
        seed: 0,
        players: { player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' } },
        seats: { seat_0: ['player_0'] },
        seat_plan: 'solo',
      })
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
      // A recording whose owner id has no user row: the id stays, no user_name appears.
      await seedRecording('other-1', 'other_env', 'ghost-user')

      const all = (await app.inject({ method: 'GET', url: '/api/recordings' })).json() as Array<{
        id: string
        user_id: string
        user_name?: string
        pinned: boolean
      }>
      expect(all.map((r) => r.id).sort()).toEqual(['flappy_bird-1', 'other-1'])
      // The owner's display name rides beside the stable id.
      expect(all.find((r) => r.id === 'flappy_bird-1')).toMatchObject({
        user_id: ownerId,
        user_name: 'alice',
        pinned: false,
      })
      expect(all.find((r) => r.id === 'flappy_bird-1')).not.toHaveProperty('github_username')
      expect(all.find((r) => r.id === 'other-1')).toMatchObject({ user_id: 'ghost-user' })
      expect(all.find((r) => r.id === 'other-1')).not.toHaveProperty('user_name')

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

  describe('blind recording masking', () => {
    const REC_ID = 'flappy_bird-blind'

    type PlayerEntry = { kind: string; label: string; user?: string; submission_id?: string }
    type BlindRow = {
      id: string
      user_id: string | null
      user_name?: string
      header: { players?: Record<string, PlayerEntry> }
    }

    // A play-open recording seating a submitted agent — the state blind rating protects. The recording
    // is owned by the watcher (bob), the submitted seat by alice; the producing session carries the
    // season id retention joins onto the recording so its blind state can be resolved.
    async function seedBlindRecording(): Promise<{ ownerId: string; seatOwnerId: string }> {
      const season = await storage.ensureOpenSeason('flappy_bird', 1)
      await storage.setPlayStatus(season.id, 'open')
      const seatOwnerId = users.idOf('alice')
      const ownerId = users.idOf('bob')
      const header = {
        schema_version: 1,
        environment: 'flappy_bird',
        parameters: {},
        seed: 0,
        players: {
          player_0: {
            kind: 'agent',
            label: "alice's agent",
            user: seatOwnerId,
            submission_id: 'sub-a',
          },
        },
        seats: { seat_0: ['player_0'] },
        seat_plan: 'solo',
      }
      await mkdir(join(dir, REC_ID), { recursive: true })
      await writeFile(
        join(dir, REC_ID, 'recording.jsonl'),
        `${JSON.stringify(header)}\n{"tick":0}\n`,
        'utf-8',
      )
      await storage.createSession({
        id: `producing-${REC_ID}`,
        user_id: ownerId,
        env_id: 'flappy_bird',
        parameters: { players: 1 },
        mode: 'scripted',
        recording_id: REC_ID,
        season_id: season.id,
        created_at: new Date().toISOString(),
      })
      await storage.createRecording({
        id: REC_ID,
        user_id: ownerId,
        env_id: 'flappy_bird',
        created_at: new Date().toISOString(),
      })
      return { ownerId, seatOwnerId }
    }

    async function listAs(headers?: Record<string, string>): Promise<BlindRow | undefined> {
      const res = await app.inject({
        method: 'GET',
        url: '/api/recordings',
        ...(headers ? { headers } : {}),
      })
      return (res.json() as BlindRow[]).find((row) => row.id === REC_ID)
    }

    it('masks the header attribution and owner fields for an anonymous viewer', async () => {
      await users.headersFor('bob')
      await seedBlindRecording()
      const row = await listAs()
      expect(row?.user_id).toBeNull()
      expect(row).not.toHaveProperty('user_name')
      expect(row?.header.players?.player_0).toEqual({
        kind: 'agent',
        label: 'Agent',
        submission_id: 'sub-a',
      })
    })

    it('leaves attribution and owner fields intact for an operator', async () => {
      await users.headersFor('bob')
      const op = await users.headersFor('op', { status: 'admin' })
      const { ownerId, seatOwnerId } = await seedBlindRecording()
      const row = await listAs(op)
      expect(row?.user_id).toBe(ownerId)
      expect(row?.user_name).toBe('bob')
      expect(row?.header.players?.player_0).toMatchObject({
        label: "alice's agent",
        user: seatOwnerId,
        submission_id: 'sub-a',
      })
    })

    it('keeps the owner id for the recording owner (to pin) but still masks the other seat and the name', async () => {
      const bob = await users.headersFor('bob')
      const { ownerId } = await seedBlindRecording()
      const row = await listAs(bob)
      expect(row?.user_id).toBe(ownerId)
      expect(row).not.toHaveProperty('user_name')
      expect(row?.header.players?.player_0?.label).toBe('Agent')
    })

    it('rewrites only the stream header for an anonymous viewer, and not for an operator', async () => {
      await users.headersFor('bob')
      const op = await users.headersFor('op', { status: 'admin' })
      await seedBlindRecording()

      const anon = await app.inject({ method: 'GET', url: `/api/recordings/${REC_ID}` })
      const anonLines = anon.body.split('\n')
      expect(
        (JSON.parse(anonLines[0] ?? '{}') as { players: Record<string, PlayerEntry> }).players
          .player_0,
      ).toEqual({ kind: 'agent', label: 'Agent', submission_id: 'sub-a' })
      // The state line rides through untouched.
      expect(anonLines[1]).toBe('{"tick":0}')

      const operator = await app.inject({
        method: 'GET',
        url: `/api/recordings/${REC_ID}`,
        headers: op,
      })
      const opFirst = JSON.parse(operator.body.split('\n')[0] ?? '{}') as {
        players: Record<string, PlayerEntry>
      }
      expect(opFirst.players.player_0).toMatchObject({
        label: "alice's agent",
        submission_id: 'sub-a',
      })
    })
  })
})
