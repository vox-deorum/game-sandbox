/**
 * Stage 12.1 foundation: the embedded Better Auth server on the shared SQLite database. Vitest on
 * `:memory:`, no Docker. Covers the schema migration, email/password sign-in over `app.inject`, the
 * idempotent bootstrap-admin seed, the config validation matrix, the admin roster surface (including
 * that user deletion is refused server-side), and the test-harness user minting.
 *
 * Nothing here exercises the identity seam: that is still the untouched Stage 3 header stub, so these
 * tests speak only to the auth endpoints under `/api/auth/*` and to the config loader.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/app.js'
import type { Auth } from '../../src/auth/auth.js'
import { migrateAuthSchema } from '../../src/auth/migrate.js'
import { BOOTSTRAP_ADMIN_ID, ensureAdminUser } from '../../src/auth/seed-admin.js'
import {
  DEV_ADMIN_EMAIL,
  DEV_ADMIN_PASSWORD,
  DEV_AUTH_SECRET,
  loadConfig,
} from '../../src/config.js'
import { RecordingsStore } from '../../src/recordings.js'
import { Retention } from '../../src/retention.js'
import { Orchestrator } from '../../src/session/orchestrator.js'
import { openSqlite, type SqliteHandle } from '../../src/storage/sqlite.js'
import { makeTestAuth, type TestUsers } from '../support/auth.js'
import { FakeDriver } from '../support/fake-driver.js'
import { makeConfig, makeEnvironments, makeSubmissionDeps } from '../support/harness.js'

const SEED_ADMIN = { email: 'root@test.local', password: 'root-password-123', name: 'Root' }

/** The table names in a database, for asserting both the auth and the app schema landed. */
function tableNames(sqlite: SqliteHandle['sqlite']): string[] {
  const rows = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string
  }[]
  return rows.map((row) => row.name).sort()
}

function adminCount(sqlite: SqliteHandle['sqlite']): number {
  const row = sqlite.prepare("SELECT COUNT(*) AS n FROM user WHERE role = 'admin'").get() as {
    n: number
  }
  return row.n
}

/** A fresh `:memory:` database, auth instance, and mounted app — the setup every auth suite shares. */
interface AuthAppFixture {
  handle: SqliteHandle
  auth: Auth
  users: TestUsers
  app: FastifyInstance
  orchestrator: Orchestrator
  dir: string
}

async function setupAuthApp(): Promise<AuthAppFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'gs-auth-'))
  const handle = await openSqlite(':memory:')
  const { auth, users } = await makeTestAuth(handle.sqlite)
  const config = makeConfig({ recordingsDir: dir })
  const recordings = new RecordingsStore(dir)
  const orchestrator = new Orchestrator(
    new FakeDriver(),
    handle.storage,
    makeEnvironments(),
    config,
  )
  const app = await buildApp({
    orchestrator,
    environments: makeEnvironments(),
    recordings,
    retention: new Retention(handle.storage, recordings, config),
    allowlist: config.sessionAllowlist,
    auth,
    ...makeSubmissionDeps(handle.storage, config),
  })
  return { handle, auth, users, app, orchestrator, dir }
}

async function teardownAuthApp(fx: AuthAppFixture): Promise<void> {
  await fx.orchestrator.shutdown()
  await fx.app.close()
  // storage.close() closes the shared connection, so it stays the last teardown action.
  await fx.handle.storage.close()
  rmSync(fx.dir, { recursive: true, force: true })
}

// --- Schema migration ------------------------------------------------------------------------
describe('auth schema migration', () => {
  let handle: SqliteHandle

  beforeEach(async () => {
    handle = await openSqlite(':memory:')
    await makeTestAuth(handle.sqlite)
  })

  afterEach(async () => {
    await handle.storage.close()
  })

  it('creates the Better Auth tables alongside the app schema', () => {
    const names = tableNames(handle.sqlite)
    expect(names).toEqual(
      expect.arrayContaining([
        'user',
        'session',
        'account',
        'verification',
        'sessions',
        'recordings',
      ]),
    )
  })

  it('is idempotent: a second migration changes nothing', async () => {
    const before = tableNames(handle.sqlite)
    const { auth } = await makeTestAuth(handle.sqlite)
    await migrateAuthSchema(auth)
    expect(tableNames(handle.sqlite)).toEqual(before)
  })
})

// --- Sign-in over the mounted app ------------------------------------------------------------
describe('email and password sign-in over app.inject', () => {
  let fx: AuthAppFixture
  let handle: SqliteHandle
  let app: FastifyInstance

  beforeEach(async () => {
    fx = await setupAuthApp()
    ;({ handle, app } = fx)
    await ensureAdminUser(fx.auth, SEED_ADMIN, () => {})
  })

  afterEach(async () => {
    await teardownAuthApp(fx)
  })

  it('signs in the seeded admin and sets a session cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: SEED_ADMIN.email, password: SEED_ADMIN.password },
    })
    expect(res.statusCode).toBe(200)
    expect(res.cookies.length).toBeGreaterThan(0)
    expect(res.cookies.some((cookie) => cookie.value !== '')).toBe(true)
  })

  it('refuses a wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: SEED_ADMIN.email, password: 'not-the-password' },
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('rejects self-registration because sign-up is disabled', async () => {
    const before = adminCount(handle.sqlite)
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'intruder@test.local', password: 'intruder-password', name: 'Intruder' },
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    const rows = handle.sqlite.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }
    // Only the seeded admin exists; the sign-up created no user.
    expect(rows.n).toBe(1)
    expect(adminCount(handle.sqlite)).toBe(before)
  })

  it('round-trips the session cookie through get-session', async () => {
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: SEED_ADMIN.email, password: SEED_ADMIN.password },
    })
    const cookie = signIn.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    const session = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie },
    })
    expect(session.statusCode).toBe(200)
    expect(session.json().user.id).toBe(BOOTSTRAP_ADMIN_ID)
  })

  it('tolerates an empty-bodied sign-out post (scoped parser)', async () => {
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: SEED_ADMIN.email, password: SEED_ADMIN.password },
    })
    const cookie = signIn.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    // Empty body with an application/json content type would 400 under Fastify's default parser; the
    // scoped raw-string parser tolerates it so the documented sign-out works.
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie, 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('keeps the tolerant JSON parser scoped to the auth plugin', async () => {
    // The same empty-bodied application/json POST that the auth sign-out tolerates must still 400 on a
    // non-auth route: the scoped raw-string parser is encapsulated to the auth plugin, so the app's
    // global default parser (which rejects an empty JSON body) stays in force everywhere else.
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/does-not-exist/pin',
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
  })
})

// --- Bootstrap-admin seed --------------------------------------------------------------------
describe('ensureAdminUser', () => {
  let handle: SqliteHandle
  let auth: Auth

  beforeEach(async () => {
    handle = await openSqlite(':memory:')
    auth = (await makeTestAuth(handle.sqlite)).auth
  })

  afterEach(async () => {
    await handle.storage.close()
  })

  it('creates the reserved-id admin once and is a no-op on re-run', async () => {
    await ensureAdminUser(auth, SEED_ADMIN, () => {})
    const first = await auth.api.signInEmail({
      body: { email: SEED_ADMIN.email, password: SEED_ADMIN.password },
    })
    expect(first.user.id).toBe(BOOTSTRAP_ADMIN_ID)
    expect(adminCount(handle.sqlite)).toBe(1)

    await ensureAdminUser(auth, SEED_ADMIN, () => {})
    expect(adminCount(handle.sqlite)).toBe(1)
    const again = await auth.api.signInEmail({
      body: { email: SEED_ADMIN.email, password: SEED_ADMIN.password },
    })
    expect(again.user.id).toBe(BOOTSTRAP_ADMIN_ID)
  })

  it('heals a demoted admin and moves to new credentials on re-run', async () => {
    await ensureAdminUser(auth, SEED_ADMIN, () => {})

    // Demote and simulate drift, then re-sync from new configuration.
    handle.sqlite.prepare("UPDATE user SET role = 'user' WHERE id = ?").run(BOOTSTRAP_ADMIN_ID)
    const rotated = { email: 'root2@test.local', password: 'root2-password-456', name: 'Root Two' }
    await ensureAdminUser(auth, rotated, () => {})

    const signIn = await auth.api.signInEmail({
      body: { email: rotated.email, password: rotated.password },
    })
    expect(signIn.user.id).toBe(BOOTSTRAP_ADMIN_ID)
    expect(signIn.user.role).toBe('admin')
    expect(adminCount(handle.sqlite)).toBe(1)

    // The old email no longer signs anyone in.
    await expect(
      auth.api.signInEmail({ body: { email: SEED_ADMIN.email, password: SEED_ADMIN.password } }),
    ).rejects.toThrow()
  })

  it('refuses startup when the configured email belongs to another user', async () => {
    // A different user already owns the email, and the bootstrap admin does not exist yet.
    await auth.api.createUser({
      body: {
        email: SEED_ADMIN.email,
        password: 'someone-elses-password',
        name: 'Someone',
        role: 'user',
      },
    })
    await expect(ensureAdminUser(auth, SEED_ADMIN, () => {})).rejects.toThrow(/refusing to start/)
  })

  it('revokes existing admin sessions when the password rotates', async () => {
    await ensureAdminUser(auth, SEED_ADMIN, () => {})
    const signIn = await auth.api.signInEmail({
      body: { email: SEED_ADMIN.email, password: SEED_ADMIN.password },
      returnHeaders: true,
    })
    const cookie = signIn.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0])
      .join('; ')
    const before = await auth.api.getSession({ headers: new Headers({ cookie }) })
    expect(before?.user.id).toBe(BOOTSTRAP_ADMIN_ID)

    // A changed password rotates the hash and revokes every existing session, so the old cookie dies.
    await ensureAdminUser(auth, { ...SEED_ADMIN, password: 'a-rotated-password-123' }, () => {})
    const after = await auth.api.getSession({ headers: new Headers({ cookie }) })
    expect(after).toBeNull()
  })

  it('keeps existing admin sessions when the password is unchanged', async () => {
    await ensureAdminUser(auth, SEED_ADMIN, () => {})
    const signIn = await auth.api.signInEmail({
      body: { email: SEED_ADMIN.email, password: SEED_ADMIN.password },
      returnHeaders: true,
    })
    const cookie = signIn.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0])
      .join('; ')

    // An ordinary restart with unchanged configuration must not log the admin out.
    await ensureAdminUser(auth, SEED_ADMIN, () => {})
    const after = await auth.api.getSession({ headers: new Headers({ cookie }) })
    expect(after?.user.id).toBe(BOOTSTRAP_ADMIN_ID)
  })
})

// --- Config validation matrix ----------------------------------------------------------------
describe('auth configuration', () => {
  const NORMAL = {
    PUBLIC_ORIGIN: 'https://sandbox.example.edu',
    AUTH_SECRET: 'an-explicit-secret-of-at-least-32-chars',
    ADMIN_EMAIL: 'ops@example.edu',
    ADMIN_PASSWORD: 'an-explicit-admin-password',
  }

  it('requires an explicit public origin, secret, and credentials in normal mode', () => {
    expect(() => loadConfig({})).toThrow(/PUBLIC_ORIGIN/)
    const { PUBLIC_ORIGIN, ...noOrigin } = NORMAL
    expect(() => loadConfig(noOrigin)).toThrow(/PUBLIC_ORIGIN/)
    const { AUTH_SECRET, ...noSecret } = NORMAL
    expect(() => loadConfig(noSecret)).toThrow(/AUTH_SECRET/)
    const { ADMIN_EMAIL, ...noEmail } = NORMAL
    expect(() => loadConfig(noEmail)).toThrow(/ADMIN_EMAIL/)
    const { ADMIN_PASSWORD, ...noPassword } = NORMAL
    expect(() => loadConfig(noPassword)).toThrow(/ADMIN_PASSWORD/)
  })

  it('rejects the published development credentials without the opt-in', () => {
    expect(() => loadConfig({ ...NORMAL, AUTH_SECRET: DEV_AUTH_SECRET })).toThrow(/AUTH_SECRET/)
    expect(() => loadConfig({ ...NORMAL, ADMIN_EMAIL: DEV_ADMIN_EMAIL })).toThrow(/ADMIN_EMAIL/)
    expect(() => loadConfig({ ...NORMAL, ADMIN_PASSWORD: DEV_ADMIN_PASSWORD })).toThrow(
      /ADMIN_PASSWORD/,
    )
  })

  it('rejects the published dev email regardless of case', () => {
    // The published-value guard must normalize before comparing: a differently-cased ADMIN_EMAIL would
    // otherwise slip past it and then lowercase down to the known-public dev address.
    expect(() => loadConfig({ ...NORMAL, ADMIN_EMAIL: 'Admin@Example.com' })).toThrow(/ADMIN_EMAIL/)
  })

  it('lowercases the admin email it accepts', () => {
    expect(loadConfig({ ...NORMAL, ADMIN_EMAIL: 'Ops@Example.EDU' }).auth.adminEmail).toBe(
      'ops@example.edu',
    )
  })

  it('rejects a non-http(s) public origin and one carrying a path', () => {
    expect(() => loadConfig({ ...NORMAL, PUBLIC_ORIGIN: 'ftp://example.edu' })).toThrow(
      /PUBLIC_ORIGIN/,
    )
    expect(() => loadConfig({ ...NORMAL, PUBLIC_ORIGIN: 'https://example.edu/sandbox' })).toThrow(
      /PUBLIC_ORIGIN/,
    )
  })

  it('rejects an AUTH_SECRET shorter than 32 characters', () => {
    expect(() => loadConfig({ ...NORMAL, AUTH_SECRET: 'too-short' })).toThrow(/AUTH_SECRET/)
  })

  it('accepts the published defaults only behind the loopback opt-in', () => {
    const config = loadConfig({ AUTH_ALLOW_INSECURE_DEFAULTS: 'true' })
    expect(config.auth.insecureDevelopment).toBe(true)
    expect(config.auth.secret).toBe(DEV_AUTH_SECRET)
    expect(config.auth.adminEmail).toBe(DEV_ADMIN_EMAIL)
    expect(config.auth.adminPassword).toBe(DEV_ADMIN_PASSWORD)
    expect(config.listenHost).toBe('127.0.0.1')
  })

  it('rejects the opt-in on a non-loopback origin', () => {
    expect(() =>
      loadConfig({ AUTH_ALLOW_INSECURE_DEFAULTS: 'true', PUBLIC_ORIGIN: 'https://example.edu' }),
    ).toThrow(/loopback/)
  })

  it('binds 0.0.0.0 in normal mode and the loopback interface in insecure mode', () => {
    expect(loadConfig(NORMAL).listenHost).toBe('0.0.0.0')
    expect(loadConfig({ AUTH_ALLOW_INSECURE_DEFAULTS: 'true' }).listenHost).toBe('127.0.0.1')
    expect(
      loadConfig({ AUTH_ALLOW_INSECURE_DEFAULTS: 'true', PUBLIC_ORIGIN: 'http://[::1]:8080' })
        .listenHost,
    ).toBe('::1')
  })

  it('includes the Vite origin automatically only in the opted-in local mode', () => {
    expect(loadConfig(NORMAL).auth.trustedOrigins).not.toContain('http://localhost:5173')
    expect(loadConfig({ AUTH_ALLOW_INSECURE_DEFAULTS: 'true' }).auth.trustedOrigins).toContain(
      'http://localhost:5173',
    )
  })

  it('appends AUTH_TRUSTED_ORIGINS to the public origin', () => {
    const { auth } = loadConfig({
      ...NORMAL,
      AUTH_TRUSTED_ORIGINS: 'https://a.example.edu, https://b.example.edu',
    })
    expect(auth.trustedOrigins).toContain('https://sandbox.example.edu')
    expect(auth.trustedOrigins).toContain('https://a.example.edu')
    expect(auth.trustedOrigins).toContain('https://b.example.edu')
  })

  it('enforces the GitHub both-or-neither rule', () => {
    expect(loadConfig(NORMAL).auth.github).toBeUndefined()
    expect(() => loadConfig({ ...NORMAL, GITHUB_OAUTH_CLIENT_ID: 'id-only' })).toThrow(/GITHUB/)
    expect(() => loadConfig({ ...NORMAL, GITHUB_OAUTH_CLIENT_SECRET: 'secret-only' })).toThrow(
      /GITHUB/,
    )
    const { auth } = loadConfig({
      ...NORMAL,
      GITHUB_OAUTH_CLIENT_ID: 'the-id',
      GITHUB_OAUTH_CLIENT_SECRET: 'the-secret',
    })
    expect(auth.github).toEqual({ clientId: 'the-id', clientSecret: 'the-secret' })
  })
})

// --- Admin roster surface --------------------------------------------------------------------
describe('admin roster endpoints', () => {
  let fx: AuthAppFixture
  let app: FastifyInstance
  let users: TestUsers

  beforeEach(async () => {
    fx = await setupAuthApp()
    ;({ app, users } = fx)
  })

  afterEach(async () => {
    await teardownAuthApp(fx)
  })

  it('lets an admin drive every supported roster operation', async () => {
    const admin = await users.headersFor('boss', { status: 'admin' })

    const created = await app.inject({
      method: 'POST',
      url: '/api/auth/admin/create-user',
      headers: admin,
      payload: {
        email: 'target@test.local',
        password: 'target-password',
        name: 'Target',
        role: 'user',
      },
    })
    expect(created.statusCode).toBe(200)
    const targetId = created.json().user.id as string

    const setRole = await app.inject({
      method: 'POST',
      url: '/api/auth/admin/set-role',
      headers: admin,
      payload: { userId: targetId, role: 'admin' },
    })
    expect(setRole.statusCode).toBe(200)

    const ban = await app.inject({
      method: 'POST',
      url: '/api/auth/admin/ban-user',
      headers: admin,
      payload: { userId: targetId, banReason: 'testing' },
    })
    expect(ban.statusCode).toBe(200)

    const unban = await app.inject({
      method: 'POST',
      url: '/api/auth/admin/unban-user',
      headers: admin,
      payload: { userId: targetId },
    })
    expect(unban.statusCode).toBe(200)

    const setPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/admin/set-user-password',
      headers: admin,
      payload: { userId: targetId, newPassword: 'a-new-password' },
    })
    expect(setPassword.statusCode).toBe(200)

    const list = await app.inject({
      method: 'GET',
      url: '/api/auth/admin/list-users',
      headers: admin,
    })
    expect(list.statusCode).toBe(200)
  })

  it('refuses user deletion server-side, even for an admin session', async () => {
    const admin = await users.headersFor('boss', { status: 'admin' })
    const created = await app.inject({
      method: 'POST',
      url: '/api/auth/admin/create-user',
      headers: admin,
      payload: {
        email: 'doomed@test.local',
        password: 'doomed-password',
        name: 'Doomed',
        role: 'user',
      },
    })
    const targetId = created.json().user.id as string

    const removed = await app.inject({
      method: 'POST',
      url: '/api/auth/admin/remove-user',
      headers: admin,
      payload: { userId: targetId },
    })
    // The custom admin role omits the `delete` permission, so the plugin refuses the endpoint.
    expect(removed.statusCode).toBe(403)
  })
})

// --- Test harness user minting ---------------------------------------------------------------
describe('TestUsers harness', () => {
  let fx: AuthAppFixture
  let app: FastifyInstance
  let users: TestUsers

  beforeEach(async () => {
    fx = await setupAuthApp()
    ;({ app, users } = fx)
  })

  afterEach(async () => {
    await teardownAuthApp(fx)
  })

  it('yields headers that get-session accepts', async () => {
    const alice = await users.headersFor('alice')
    const res = await app.inject({ method: 'GET', url: '/api/auth/get-session', headers: alice })
    expect(res.statusCode).toBe(200)
    expect(res.json().user.id).toBe(users.idOf('alice'))
  })

  it('mints a pending user carrying the pending role', async () => {
    const penny = await users.headersFor('penny', { status: 'pending' })
    const res = await app.inject({ method: 'GET', url: '/api/auth/get-session', headers: penny })
    expect(res.json().user.role).toBe('pending')
  })

  it('revokes a previously issued cookie on ban', async () => {
    const alice = await users.headersFor('alice')
    const before = await app.inject({ method: 'GET', url: '/api/auth/get-session', headers: alice })
    expect(before.json()?.user).toBeDefined()

    await users.ban('alice')
    const after = await app.inject({ method: 'GET', url: '/api/auth/get-session', headers: alice })
    // The ban revoked the session, so the old cookie no longer resolves to a user.
    expect(after.json()).toBeNull()
  })
})
