/**
 * Real signed-in users for any suite, on the suite's own `:memory:` database. The minimal-churn
 * replacement for the old dev-identity header: {@link TestUsers.headersFor} returns headers carrying
 * a genuine Better Auth session cookie, so a suite exercises the shipped trust boundary rather than a
 * test-only shortcut.
 *
 * `makeTestAuth` builds an auth instance on the suite's raw connection and runs its schema migration;
 * it does not seed the bootstrap admin (the seed suite calls `ensureAdminUser` explicitly).
 */
import type BetterSqlite3 from 'better-sqlite3'

import { type Auth, createAuth } from '../../src/auth/auth.js'
import { migrateAuthSchema } from '../../src/auth/migrate.js'
import { TEST_AUTH_OPTIONS } from './auth-options.js'

/** A fixed password every test user shares; only its presence matters, never its value. */
const TEST_PASSWORD = 'test-password-123'

/** The status a test user is minted at; maps to the Better Auth role the user carries. */
export type TestStatus = 'normal' | 'admin' | 'pending'

const ROLE_BY_STATUS: Record<TestStatus, 'user' | 'admin' | 'pending'> = {
  normal: 'user',
  admin: 'admin',
  pending: 'pending',
}

/** A reserved internal admin used only to drive admin-session operations like `ban`. */
const BAN_ACTOR = '__test-users-admin__'

export interface TestAuth {
  auth: Auth
  users: TestUsers
}

export async function makeTestAuth(sqlite: BetterSqlite3.Database): Promise<TestAuth> {
  const auth = createAuth(sqlite, TEST_AUTH_OPTIONS)
  await migrateAuthSchema(auth, sqlite)
  return { auth, users: new TestUsers(auth) }
}

interface MintedUser {
  id: string
  status: TestStatus
  headers: Record<string, string>
}

export class TestUsers {
  private readonly minted = new Map<string, MintedUser>()

  constructor(private readonly auth: Auth) {}

  /**
   * Lazily create `<name>@test.local` with the role implied by `status` (default `normal` -> role
   * `user`), sign the user in server-side, memoize per name, and return headers carrying the session
   * cookie. Re-calling with the same name returns the memoized user; a repeat call that asks for a
   * *different* status throws rather than silently hand back the wrong role — a test that needs a
   * different role should use a different name.
   */
  async headersFor(name: string, opts?: { status?: TestStatus }): Promise<Record<string, string>> {
    const status = opts?.status ?? 'normal'
    const existing = this.minted.get(name)
    if (existing !== undefined) {
      if (existing.status !== status) {
        throw new Error(
          `test user '${name}' was already minted as '${existing.status}'; cannot re-request it as '${status}' (use a different name)`,
        )
      }
      return existing.headers
    }

    const email = `${name}@test.local`
    const role = ROLE_BY_STATUS[status]
    // Server-side (no request/headers), so the admin plugin skips its permission check and creates
    // the user directly; the role is still validated against the configured roles.
    const created = await this.auth.api.createUser({
      body: { email, password: TEST_PASSWORD, name, role },
    })

    const signIn = await this.auth.api.signInEmail({
      body: { email, password: TEST_PASSWORD },
      returnHeaders: true,
    })
    const cookie = signIn.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0])
      .join('; ')

    const minted: MintedUser = { id: created.user.id, status, headers: { cookie } }
    this.minted.set(name, minted)
    return minted.headers
  }

  /** Ban the named user through an admin session, revoking its existing sessions. */
  async ban(name: string): Promise<void> {
    const adminHeaders = await this.headersFor(BAN_ACTOR, { status: 'admin' })
    await this.auth.api.banUser({
      body: { userId: this.idOf(name) },
      headers: new Headers(adminHeaders),
    })
  }

  /** The Better Auth user id for a previously minted name, for asserting row attribution. */
  idOf(name: string): string {
    const minted = this.minted.get(name)
    if (minted === undefined) {
      throw new Error(`test user '${name}' has not been created; call headersFor('${name}') first`)
    }
    return minted.id
  }
}
