import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Storage } from '../src/storage/index.js'
import type { TestUsers } from './support/auth.js'
import { makeConfig, openTestApp, type TestApp } from './support/harness.js'
import { llmEnvironments, makeTestLlmOptions } from './support/llm-options.js'

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

  it('returns independent play and submission settings with resolved rules and template locations', async () => {
    await storage.updateSeasonConfig(playSeasonId, {
      deps_version: 1,
      matches: [],
      overrides: { parameters: { pipe_gap: 120 }, step_timeout_ms: 250, episode_timeout_ms: 5_000 },
    })
    await storage.setSubmissionStatus(playSeasonId, 'closed')
    const submissionSeason = await storage.createSeason({ env_id: 'flappy_bird', deps_version: 1 })
    await storage.setSubmissionStatus(submissionSeason.id, 'open')
    await storage.setSeasonTemplateRepository(submissionSeason.id, {
      url: 'https://example.test/course-template',
      branch: null,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/environments/flappy_bird/season-settings',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      play: {
        season_id: playSeasonId,
        season_label: null,
        template_repo: {
          url: 'https://github.com/vox-deorum/game-agent-template',
          branch: 'templates/flappy_bird',
        },
        values: { players: 1, pipe_gap: 120 },
        rules: {
          step_timeout_ms: 250,
          episode_timeout_ms: 5_000,
          messaging_enabled: false,
          message_cap: null,
          llm_enabled: false,
        },
      },
      submission: {
        season_id: submissionSeason.id,
        season_label: null,
        template_repo: { url: 'https://example.test/course-template', branch: null },
        values: { players: 1, pipe_gap: 100 },
        rules: {
          step_timeout_ms: 1_000,
          episode_timeout_ms: 120_000,
          messaging_enabled: false,
          message_cap: null,
          llm_enabled: false,
        },
      },
    })
  })

  it('uses the environment branch when a season pastes the deployment template repository', async () => {
    for (const templateRepoUrl of [
      fixture.config.templateRepoUrl,
      `${fixture.config.templateRepoUrl}/`,
    ]) {
      await storage.setSeasonTemplateRepository(playSeasonId, {
        url: templateRepoUrl,
        branch: null,
      })

      const response = await app.inject({
        method: 'GET',
        url: '/api/environments/flappy_bird/season-settings',
      })

      expect(response.statusCode).toBe(200)
      expect(
        (response.json() as { play: { template_repo: { url: string; branch: string | null } } })
          .play.template_repo,
      ).toEqual({ url: templateRepoUrl, branch: 'templates/flappy_bird' })
    }
  })

  it('serves a saved branch on the deployment or a custom repository', async () => {
    for (const [url, expectedUrl] of [
      [null, fixture.config.templateRepoUrl],
      ['https://example.test/course-template', 'https://example.test/course-template'],
    ] as const) {
      await storage.setSeasonTemplateRepository(playSeasonId, {
        url,
        branch: 'examples/flappy_bird/hello',
      })

      const response = await app.inject({
        method: 'GET',
        url: '/api/environments/flappy_bird/season-settings',
      })

      expect(response.statusCode).toBe(200)
      expect(
        (response.json() as { play: { template_repo: { url: string; branch: string | null } } })
          .play.template_repo,
      ).toEqual({ url: expectedUrl, branch: 'examples/flappy_bird/hello' })
    }
  })

  it('reports closed gates as null and rejects an unknown environment', async () => {
    await storage.setSubmissionStatus(playSeasonId, 'closed')
    await storage.setPlayStatus(playSeasonId, 'closed')
    const closed = await app.inject({
      method: 'GET',
      url: '/api/environments/flappy_bird/season-settings',
    })
    expect(closed.statusCode).toBe(200)
    expect(closed.json()).toEqual({ play: null, submission: null })

    const missing = await app.inject({
      method: 'GET',
      url: '/api/environments/nope/season-settings',
    })
    expect(missing.statusCode).toBe(404)
  })

  it('reports LLM access only when the deployment can provide it', async () => {
    async function readLlmEnabled(configured: boolean): Promise<boolean> {
      const root = join(fixture.rootDir, configured ? 'llm-configured' : 'llm-unconfigured')
      const llm = makeTestLlmOptions()
      const llmFixture = await openTestApp({
        environments: llmEnvironments(),
        config: makeConfig({
          dataDir: root,
          recordingsDir: join(root, 'recordings'),
          submissionsDir: join(root, 'submissions'),
          llm: configured
            ? {
                ...llm,
                upstreamUrl: 'https://provider.test/v1',
                models: { small: { upstream: 'provider-small', costWeight: 1 } },
              }
            : llm,
        }),
      })
      try {
        const season = await llmFixture.storage.ensureOpenSeason('llm_env', 1)
        await llmFixture.storage.updateSeasonConfig(season.id, {
          deps_version: 1,
          matches: [],
          overrides: { llm: { enabled: true } },
        })
        const response = await llmFixture.app.inject({
          method: 'GET',
          url: '/api/environments/llm_env/season-settings',
        })
        expect(response.statusCode).toBe(200)
        return (response.json() as { play: { rules: { llm_enabled: boolean } } }).play.rules
          .llm_enabled
      } finally {
        await llmFixture.close()
      }
    }

    await expect(readLlmEnabled(false)).resolves.toBe(false)
    await expect(readLlmEnabled(true)).resolves.toBe(true)
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

    it('keeps season settings available with the default after drift', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/environments/flappy_bird/season-settings',
      })
      expect(res.statusCode).toBe(200)
      expect((res.json() as { play: { values: Record<string, number> } }).play.values).toEqual({
        players: 1,
        pipe_gap: 100,
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
      site_icon_url: '/game-sandbox-icon.png',
      site_short_name: 'Game Sandbox',
      github_auth: false,
    })
  })

  it('reflects a configured site name and short name in GET /api/config', async () => {
    const custom = await openTestApp({
      siteName: 'Acme Arena',
      siteIconUrl: 'https://cdn.example.edu/acme.svg',
      siteShortName: 'Acme',
    })
    try {
      const res = await custom.app.inject({ method: 'GET', url: '/api/config' })
      expect(res.json()).toEqual({
        site_name: 'Acme Arena',
        site_icon_url: 'https://cdn.example.edu/acme.svg',
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

    const row = await app.inject({
      method: 'GET',
      url: `/api/sessions/${body.id}`,
      // A signed-in viewer sees the resolved name; an anonymous (masked) caller would not.
      headers: alice,
    })
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
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/sess-ghost',
      // Signed in so the directory lookup is the thing under test, not anonymous masking.
      headers: alice,
    })
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

  it('accepts agent and self human companion wire shapes before singleton layout validation rejects them', async () => {
    for (const companion of [{ kind: 'builtin-agent', name: 'naive' }, { kind: 'self' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: alice,
        payload: startPayload({
          seat_0: { kind: 'human', companion },
        }),
      })
      expect(res.statusCode).toBe(400)
      expect((res.json() as { error: string }).error).toContain(
        'singleton seat seat_0 cannot have a companion',
      )
    }
  })

  it('rejects extra fields on a self human companion', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: alice,
      payload: startPayload({
        seat_0: { kind: 'human', companion: { kind: 'self', name: 'naive' } },
      }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'invalid_request' })
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

  it('404s an unknown session and an unknown recording', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/sessions/nope' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/recordings/nope' })).statusCode).toBe(404)
  })

  it('refuses unsafe recording ids', async () => {
    for (const path of ['/api/recordings/..%2F..%2Fetc', '/api/recordings/x..%2fy']) {
      const res = await app.inject({ method: 'GET', url: path })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ code: 'invalid_request' })
    }
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
    async function seedRecording(id: string, env: string, user: string) {
      await mkdir(join(dir, id), { recursive: true })
      const header = {
        schema_version: 1,
        environment: env,
        parameters: {},
        seed: 0,
        players: { player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' } },
        seats: { seat_0: ['player_0'] },
        seat_plan: 'solo',
      }
      await writeFile(
        join(dir, id, 'recording.jsonl'),
        `${JSON.stringify({ ...header, overlay_static: { map: 'not part of the listing' } })}\n`,
      )
      await storage.createRecording({
        id,
        user_id: user,
        env_id: env,
        created_at: '2026-06-11T00:00:00.000Z',
      })
      return header
    }

    it('merges retention metadata into the listing and filters on ?env=', async () => {
      const ownerId = users.idOf('alice')
      const flappyHeader = await seedRecording('flappy_bird-1', 'flappy_bird', ownerId)
      // A recording whose owner id has no user row: the id stays, no user_name appears.
      const otherHeader = await seedRecording('other-1', 'other_env', 'ghost-user')

      const response = await app.inject({
        method: 'GET',
        url: '/api/recordings',
        headers: await users.headersFor('bob'),
      })
      expect(response.statusCode).toBe(200)
      const all = response.json<Array<{ id: string }>>().sort((a, b) => a.id.localeCompare(b.id))
      expect(all).toEqual([
        expect.objectContaining({
          id: 'flappy_bird-1',
          user_id: ownerId,
          user_name: 'alice',
          pinned: false,
          created_at: '2026-06-11T00:00:00.000Z',
          header: flappyHeader,
        }),
        expect.objectContaining({ id: 'other-1', user_id: 'ghost-user', header: otherHeader }),
      ])
      expect(all[1]).not.toHaveProperty('user_name')

      const filtered = (
        await app.inject({ method: 'GET', url: '/api/recordings?env=flappy_bird' })
      ).json() as Array<{ id: string }>
      expect(filtered.map((r) => r.id)).toEqual(['flappy_bird-1'])
    })

    it('exposes the owner pin and unpin changes in the public listing', async () => {
      await seedRecording('flappy_bird-1', 'flappy_bird', users.idOf('alice'))
      for (const [method, pinned] of [
        ['POST', true],
        ['DELETE', false],
      ] as const) {
        const response = await app.inject({
          method,
          url: '/api/recordings/flappy_bird-1/pin',
          headers: alice,
        })
        expect(response.statusCode).toBe(204)
        const listing = await app.inject({ method: 'GET', url: '/api/recordings' })
        expect(listing.json()).toEqual([expect.objectContaining({ id: 'flappy_bird-1', pinned })])
      }
    })

    it.each([
      'POST',
      'DELETE',
    ] as const)('refuses unauthorized or missing-recording %s pin requests', async (method) => {
      await seedRecording('flappy_bird-1', 'flappy_bird', users.idOf('alice'))
      const pinned = method === 'DELETE'
      await storage.setRecordingPinned('flappy_bird-1', pinned)
      const anonymous = await app.inject({ method, url: '/api/recordings/flappy_bird-1/pin' })
      expect(anonymous.statusCode).toBe(401)
      expect(anonymous.json()).toMatchObject({ code: 'auth_required' })
      const stranger = await app.inject({
        method,
        url: '/api/recordings/flappy_bird-1/pin',
        headers: await users.headersFor('mallory'),
      })
      expect(stranger.statusCode).toBe(403)
      const missing = await app.inject({ method, url: '/api/recordings/nope/pin', headers: alice })
      expect(missing.statusCode).toBe(404)
      const listing = await app.inject({ method: 'GET', url: '/api/recordings' })
      expect(listing.json()).toEqual([expect.objectContaining({ id: 'flappy_bird-1', pinned })])
    })

    it('returns pinned_quota without pinning another recording when the quota is full', async () => {
      const root = join(fixture.rootDir, 'pin-quota')
      const capped = await openTestApp({
        config: makeConfig({
          dataDir: root,
          recordingsDir: join(root, 'recordings'),
          submissionsDir: join(root, 'submissions'),
          recordingUserQuota: 1,
        }),
      })
      try {
        const headers = await capped.users.headersFor('owner')
        for (const id of ['first', 'second']) {
          await capped.storage.createRecording({
            id,
            user_id: capped.users.idOf('owner'),
            env_id: 'flappy_bird',
            created_at: '2026-06-11T00:00:00.000Z',
          })
        }
        const first = await capped.app.inject({
          method: 'POST',
          url: '/api/recordings/first/pin',
          headers,
        })
        expect(first.statusCode).toBe(204)
        const second = await capped.app.inject({
          method: 'POST',
          url: '/api/recordings/second/pin',
          headers,
        })
        expect(second.statusCode).toBe(409)
        expect(second.json()).toMatchObject({ code: 'pinned_quota' })
        expect((await capped.storage.getRecording('second'))?.pinned).toBe(0)
      } finally {
        await capped.close()
      }
    })
  })

  describe('blind recording masking', () => {
    const REC_ID = 'flappy_bird-blind'

    // Bob owns the recording of Alice's submitted agent. The session supplies its season.
    async function seedBlindRecording() {
      const seatOwnerId = users.idOf('alice')
      const ownerId = users.idOf('bob')
      const header = {
        schema_version: 1,
        environment: 'flappy_bird',
        parameters: {},
        overlay_static: { map: 'preserved in the stream' },
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
      const states = '{"tick":0,"chat":"✓"}\n{"tick":1}\n'
      await writeFile(join(dir, REC_ID, 'recording.jsonl'), `${JSON.stringify(header)}\n${states}`)
      await storage.createSession({
        id: `producing-${REC_ID}`,
        user_id: ownerId,
        env_id: 'flappy_bird',
        parameters: { players: 1 },
        mode: 'scripted',
        recording_id: REC_ID,
        season_id: playSeasonId,
        created_at: '2026-06-11T00:00:00.000Z',
      })
      await storage.createRecording({
        id: REC_ID,
        user_id: ownerId,
        env_id: 'flappy_bird',
        created_at: '2026-06-11T00:00:00.000Z',
      })
      return { ownerId, seatOwnerId, header, states }
    }

    it.each([
      ['anonymous', 'open', 'hash', 'owner', false],
      ['anonymous', 'closed', 'hash', 'owner', false],
      ['guest', 'open', 'hash', 'owner', false],
      ['guest', 'closed', 'hash', 'owner', false],
      ['admin', 'open', 'identified', 'owner', true],
      ['bob', 'open', 'blind', 'owner', false],
      ['mallory', 'open', 'blind', 'hidden', false],
      ['mallory', 'closed', 'identified', 'owner', true],
    ] as const)('serves consistent %s attribution while play is %s', async (viewer, status, attribution, owner, named) => {
      await users.headersFor('bob')
      const { ownerId, seatOwnerId, header, states } = await seedBlindRecording()
      await storage.setPlayStatus(playSeasonId, status)
      const headers =
        viewer === 'anonymous'
          ? {}
          : await users.headersFor(viewer, {
              status: viewer === 'guest' ? 'guest' : viewer === 'admin' ? 'admin' : 'normal',
            })
      const players = {
        player_0:
          attribution === 'identified'
            ? { kind: 'agent', label: "alice's agent", user: seatOwnerId, submission_id: 'sub-a' }
            : {
                kind: 'agent',
                label:
                  attribution === 'hash' ? expect.stringMatching(/^Agent [0-9a-f]{6}$/) : 'Agent',
                submission_id: 'sub-a',
              },
      }
      const listing = await app.inject({
        method: 'GET',
        url: '/api/recordings',
        headers,
      })
      expect(listing.statusCode).toBe(200)
      const { overlay_static, ...listHeader } = header
      expect(listing.json()).toEqual([
        {
          id: REC_ID,
          user_id: owner === 'hidden' ? null : ownerId,
          ...(named ? { user_name: 'bob' } : {}),
          created_at: '2026-06-11T00:00:00.000Z',
          pinned: false,
          termination_reason: null,
          failed_player: null,
          termination_detail: null,
          winner_id: null,
          season_id: playSeasonId,
          header: { ...listHeader, players },
        },
      ])
      const stream = await app.inject({ method: 'GET', url: `/api/recordings/${REC_ID}`, headers })
      expect(stream.statusCode).toBe(200)
      expect(stream.headers['content-type']).toContain('application/x-ndjson')
      const newline = stream.body.indexOf('\n')
      const streamHeader = JSON.parse(stream.body.slice(0, newline))
      expect(streamHeader).toEqual({ ...listHeader, overlay_static, players })
      expect(streamHeader.players).toEqual(listing.json()[0].header.players)
      expect(stream.body.slice(newline + 1)).toBe(states)
    })
  })
})
