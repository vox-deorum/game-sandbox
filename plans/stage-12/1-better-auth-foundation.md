# Stage 12.1: Better Auth foundation

Status: not started

Part of [Stage 12](../stage-12-user-system.md). This is build-order step 1: the Better Auth server embedded in the backend, its configuration, its database wiring, the Fastify mount, the seeded admin, and the test-harness support every later step's tests stand on. After this step the auth endpoints work end to end. A `POST /api/auth/sign-in/email` returns a session cookie, and GitHub OAuth redirects when configured. Nothing consumes the session yet: the header-based identity stub from Stage 3 keeps working untouched until [step 2](2-identity-and-authorization.md) swaps the seam, so this slice lands green without changing any authorization.

## Dependency

`better-auth` (the 1.x line) joins the dependencies in `backend/package.json`. The frontend client is the same package, added to `frontend/package.json` in [step 3](3-frontend-auth.md). Pin an exact version, because the programmatic migration import path and a few helper locations moved between 1.x releases (see Implementation decisions), and the plan verifies those paths against the pinned version at implementation time rather than assuming them.

## Configuration

A new `AuthOptions` slice joins `Config` in `backend/src/config.ts`, following the existing `SubmissionOptions` pattern: it is parsed once in `loadConfig` with the existing helpers and handed to the auth constructor and the seed as a typed object.

```ts
export interface AuthGithubOptions {
  clientId: string
  clientSecret: string
}

export interface AuthOptions {
  secret: string
  publicOrigin: string
  trustedOrigins: string[]
  adminEmail: string
  adminPassword: string
  adminName: string
  github?: AuthGithubOptions
}
```

Every setting has a class-scale default so the backend runs out of the box, matching the configuration convention that no variable is required for local development.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTH_SECRET` | `dev-secret-do-not-deploy` | The Better Auth signing secret for cookies and tokens. Startup logs a loud warning when the default is in use. |
| `PUBLIC_ORIGIN` | `http://localhost:<PORT>` | The public origin the site is reached at, used for cookie origin checks and OAuth callbacks. The GitHub callback URL is `<PUBLIC_ORIGIN>/api/auth/callback/github`. Startup logs a warning when the localhost default is in use, because a deployment that leaves it unset silently breaks OAuth callbacks and cross-origin cookies. |
| `AUTH_TRUSTED_ORIGINS` | unset | Extra comma-separated origins, appended to the built-in list `[PUBLIC_ORIGIN, 'http://localhost:5173']`. The Vite dev origin is always included so dev sign-in works through the proxy without extra setup. |
| `ADMIN_EMAIL` | `admin@example.com` | The seeded admin's email. |
| `ADMIN_PASSWORD` | `admin-dev-password` | The seeded admin's password, re-synced on every boot. Startup warns when the default is in use. |
| `ADMIN_NAME` | `Admin` | The seeded admin's display name. |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | unset | The GitHub OAuth app credentials. Both or neither: setting exactly one is a `ConfigError`. These are distinct from `GITHUB_TOKEN`, which stays a submissions-only credential. |

`sessionAllowlist` and `operatorAllowlist` stay on `Config` for now; [step 2](2-identity-and-authorization.md) removes them along with their `listVar` reads and the `DEV_USER_ID` import. Keeping them here means this step touches no authorization and lands green on its own.

## Shared SQLite handle

Better Auth must run on the same better-sqlite3 connection the storage layer uses. Two `:memory:` opens are two different databases, and even for a file two connections would not share the write-ahead state cleanly, so the auth tables and the app tables live behind one handle. Refactor `backend/src/storage/sqlite.ts`:

```ts
export interface SqliteHandle {
  storage: Storage
  sqlite: BetterSqlite3.Database
}
export async function openSqlite(dbPath: string): Promise<SqliteHandle>
export async function openSqliteStorage(dbPath: string): Promise<Storage>
```

`openSqlite` opens the connection, builds the schema, and returns both the `Storage` facade and the raw connection that Better Auth is handed. `openSqliteStorage` stays as a thin wrapper over `openSqlite` for the suites that never touch auth, so their call sites do not churn. The raw connection is never used for app queries outside `storage/` and `auth/`. The lint boundary that confines `better-sqlite3` imports to `storage/` is extended to admit `src/auth/`, which needs the type and the constructor argument.

## The auth instance

`backend/src/auth/auth.ts` builds the one instance the process uses:

```ts
import { betterAuth } from 'better-auth'
import { admin } from 'better-auth/plugins'
import { ac, roles } from './permissions'

export type Auth = ReturnType<typeof betterAuth>

export function createAuth(sqlite: BetterSqlite3.Database, options: AuthOptions): Auth {
  return betterAuth({
    database: sqlite,
    secret: options.secret,
    baseURL: options.publicOrigin,
    basePath: '/api/auth',
    trustedOrigins: options.trustedOrigins,
    emailAndPassword: { enabled: true, disableSignUp: true },
    socialProviders: options.github === undefined ? {} : { github: options.github },
    plugins: [admin({ ac, roles, defaultRole: 'pending', adminRoles: ['admin'] })],
  })
}
```

The instance is constructed in `main.ts` and in the test harness, never at module load, matching the config-injection rule that no service reaches for global state.

## Roles and the standalone ban

`pending` is not one of the admin plugin's built-in roles (`user`, `admin`), and Better Auth requires a custom role to be declared in an access-control config before `defaultRole` and role filtering will treat it as first-class. `backend/src/auth/permissions.ts` builds that config with `createAccessControl` over the admin plugin's default statements and exports `ac` plus a `roles` map declaring `admin`, `user`, and `pending`; `createAuth` passes both into `admin({ ac, roles, ... })`. The exact import paths (`better-auth/plugins/access` and `better-auth/plugins/admin/access`) are among the helper locations verified against the pinned version at implementation time. The app never grants fine-grained permissions off these roles — status is derived from the raw `role` in [step 2](2-identity-and-authorization.md) — so `pending` and `user` can be near-empty role definitions that exist only so the plugin accepts `defaultRole: 'pending'` and filters on the role cleanly. Ban stays orthogonal to role: it is the admin plugin's own `banned` flag, enforced by revoked sessions and blocked sign-in, not a fourth role.

## Schema migration

`backend/src/auth/migrate.ts` exposes `migrateAuthSchema(auth: Auth): Promise<void>`, which runs Better Auth's programmatic Kysely migration over the shared connection: it reads the required migrations for the configured options and enabled plugins and applies the ones the live database is missing. `main.ts` calls it right after the app's own schema bootstrap, and the test harness calls it on each `:memory:` database.

## Fastify mount

`backend/src/auth/routes.ts` exposes `registerAuthRoutes(app, deps: { auth: Auth })`, an encapsulated plugin that registers the documented Better Auth Fastify handler: one catch-all route for GET and POST on `/api/auth/*` that builds a Fetch `Request` from the Fastify request, calls `auth.handler(request)`, and copies the returned status, headers, and body back onto the Fastify reply. It is registered in `buildApp` alongside the other route registrations and before the SPA fallback, but only when an `auth` instance is present: `AppDeps` gains an _optional_ `auth?: Auth` field in this step, so the existing app-building suites, which pass no `auth`, are untouched and keep landing green. [Step 2](2-identity-and-authorization.md) makes the field required once the seam consumes it and every suite mints real sessions.

The body-parsing problem is handled inside the plugin scope. Better Auth's handler must see the exact request bytes, but the app's global JSON parser would consume the body first, and its default parser also rejects an empty body with a 400, which breaks the empty-bodied sign-out post. Inside the encapsulated plugin, register a scoped content-type parser for `application/json` that keeps the raw string and tolerates an empty body, and pass that raw string through as the `Request` body. Because Fastify plugins are encapsulated, this parser applies only within the auth plugin and the app's global parsing is untouched.

## Admin seed

`backend/src/auth/seed-admin.ts` exposes `ensureAdminUser(auth, { email, password, name }, log)`, run by `main.ts` after `migrateAuthSchema`. It is idempotent and treats deployment configuration as the source of truth:

1. Look up the user by email through the auth context's internal adapter.
2. If missing, create it server-side with role `admin` (the admin plugin's `createUser` runs without a session on the server).
3. If present, force the role back to `admin`, clear the ban fields, and reset the password to the configured value. Two version-specific details are verified against the pinned Better Auth at implementation time: role and ban fields are updated through the auth context's internal adapter, and the password reset rewrites the credential `account` row (not the `user` row) — through the internal adapter and the context's password hasher, or by reusing the admin plugin's `setUserPassword` if it can run without a session on the server.

Resyncing the password on every boot is deliberate. Rotating `ADMIN_PASSWORD` in deployment configuration and restarting rotates the credential with no manual step, and an admin account that was demoted, banned, or had its password changed heals on the next restart. A restart with unchanged configuration is a no-op apart from writing an equivalent password hash.

## Startup wiring

`main.ts` orders the boot as `loadConfig`, then `openSqlite(config.dbPath)` (which builds the app schema), then `createAuth(sqlite, config.auth)`, then `migrateAuthSchema(auth)`, then `ensureAdminUser(auth, config.auth, log)`, then the rest of the existing wiring, then `buildApp` with `auth` in its deps. The seeded-default warnings for `AUTH_SECRET`, `ADMIN_PASSWORD`, and a localhost `PUBLIC_ORIGIN` go through the existing `log` callback, not a new logging concept.

## Test harness support

`backend/test/support/auth.ts` gives every suite real signed-in users on its own `:memory:` database, the minimal-churn replacement for the `{ 'x-sandbox-user': 'alice' }` header:

```ts
export interface TestAuth {
  auth: Auth
  users: TestUsers
}
export async function makeTestAuth(sqlite: BetterSqlite3.Database): Promise<TestAuth>

export type TestStatus = 'normal' | 'admin' | 'pending'

export class TestUsers {
  headersFor(name: string, opts?: { status?: TestStatus }): Promise<Record<string, string>>
  ban(name: string): Promise<void>
  idOf(name: string): string
}
```

`makeTestAuth` builds an auth instance on the suite's connection and runs its schema migration. `headersFor` lazily creates `<name>@test.local` with the role implied by `status` (the default `normal` maps to role `user`), signs the user in server-side, memoizes the result per name, and returns headers carrying the session cookie. `ban` bans the named user through an admin session so a test can watch a mid-session ban revoke a previously issued cookie, and `idOf` returns the Better Auth user id so a test can assert row attribution. No dev-header fallback survives in production code, so the trust boundary the tests exercise is the shipped one.

## Implementation decisions

- **Status lives in the admin plugin's own fields, not a custom `status` additional field.** The plugin already maintains `role`, `banned`, `banReason`, and `banExpires`, and it enforces them: a banned user cannot sign in and their sessions are revoked. A custom `status` field would duplicate what `role` and `banned` encode, would not by itself block sign-in or revoke sessions, and would forfeit the ready-made roster endpoints. The `status` string is instead derived from `role` at the one place identity is resolved, in [step 2](2-identity-and-authorization.md), while `banned` stays the plugin's own standalone flag rather than folding into the status.
- **`disableSignUp: true`.** There is no public email and password registration. Accounts exist only via the seed, the admin plugin's `createUser`, and GitHub sign-in.
- **`defaultRole: 'pending'`, with `pending` a declared role.** A GitHub sign-up lands `pending`. Because `pending` is not a built-in role, it is declared in the access-control config (see [Roles and the standalone ban](#roles-and-the-standalone-ban)); the seed and admin-created users pass an explicit role, which overrides the default.
- **No `session.cookieCache`.** Every request does a real session lookup, so a ban takes effect on the very next request rather than after a cache window. SQLite lookups are cheap at class scale.
- **Programmatic migration, not folding the auth tables into the flat app schema.** The app schema in `backend/src/storage/` is the application's own, edited in place. Better Auth's tables, `user`, `session`, `account`, and `verification`, are library-owned: their exact shape follows the installed package version and the enabled plugins, and none of the four names collides with the app's plural `sessions` and `recordings`. Copying generated DDL into the app schema would drift silently on a package upgrade. The programmatic migration introspects the live database, adds what is missing, is idempotent, and runs identically on the production file database and the in-memory test databases because it runs on the same connection. A comment in the app schema records that the auth tables are created separately.
- **GitHub OAuth is optional.** `createAuth` omits `socialProviders.github` when it is unconfigured; [step 3](3-frontend-auth.md) surfaces the capability to the SPA through `GET /api/config` so the login page hides the button.

## Tests

`backend/test/auth/foundation.test.ts`, Vitest on `:memory:`, no Docker:

- After `openSqlite(':memory:')` and `makeTestAuth`, the Better Auth tables exist alongside the app schema, and running `migrateAuthSchema` a second time is a no-op.
- Over `app.inject`, `POST /api/auth/sign-in/email` with the seeded admin returns a `set-cookie` session token, a wrong password is refused, `POST /api/auth/sign-up/email` is rejected because self-registration is disabled, and `GET /api/auth/get-session` round-trips the cookie.
- `ensureAdminUser` creates the admin once, a second run changes nothing observable, and after demoting the account and changing the configured password a re-run restores role `admin` and only the new password signs in.
- Config parsing enforces the both-or-neither GitHub rule, parses `AUTH_TRUSTED_ORIGINS`, and applies the documented defaults.
- `TestUsers.headersFor` yields headers that `GET /api/auth/get-session` accepts, a `status: 'pending'` user carries role `pending`, and `ban()` makes a previously issued cookie stop resolving.

## Done when

The backend starts with Better Auth mounted at `/api/auth/*` on the shared SQLite database, the admin account exists and re-syncs from configuration on every boot, email and password sign-in works over `app.inject` and over HTTP, self-registration is refused, and the harness can mint real signed-in users for any suite. Identity resolution everywhere else in the backend is still the untouched Stage 3 stub, so the rest of the suite is unchanged by this step.
