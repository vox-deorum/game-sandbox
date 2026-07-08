/**
 * The single Better Auth instance the process uses, built over the shared better-sqlite3 connection
 * so the auth tables (`user`, `session`, `account`, `verification`) live on the same database as the
 * app's storage. Constructed in `main.ts` and in the test harness, never at module load, matching the
 * config-injection rule that no service reaches for global state.
 *
 * Role handling is Better Auth's own: `role` is a string the admin plugin comma-splits for its
 * permission and admin-membership checks (`adminRoles` defaults to `['admin']`). We layer no extra
 * single-role invariant on top; the permission surface is shaped entirely by the access-control
 * config in `./permissions.ts`.
 */

import { betterAuth } from 'better-auth'
import { admin } from 'better-auth/plugins'
import type BetterSqlite3 from 'better-sqlite3'

import type { AuthOptions } from '../config.js'
import { ac, roles } from './permissions.js'

export function createAuth(sqlite: BetterSqlite3.Database, options: AuthOptions) {
  return betterAuth({
    // A raw better-sqlite3 handle selects Better Auth's built-in Kysely adapter, which is what the
    // programmatic migration in `./migrate.ts` requires.
    database: sqlite,
    secret: options.secret,
    baseURL: options.publicOrigin,
    basePath: '/api/auth',
    trustedOrigins: options.trustedOrigins,
    // No public email/password registration: accounts exist only via the seed, admin creation, and
    // GitHub sign-in.
    emailAndPassword: { enabled: true, disableSignUp: true },
    socialProviders: options.github === undefined ? {} : { github: options.github },
    // No session.cookieCache: every request does a real session lookup, so a ban takes effect on the
    // very next request rather than after a cache window. SQLite lookups are cheap at class scale.
    plugins: [admin({ ac, roles, defaultRole: 'pending' })],
  })
}

/**
 * The concrete auth instance type, inferred from {@link createAuth} so it carries the admin plugin's
 * server API (`api.createUser`, `api.banUser`, …) rather than the generic `Auth<BetterAuthOptions>`,
 * which would erase them.
 */
export type Auth = ReturnType<typeof createAuth>
