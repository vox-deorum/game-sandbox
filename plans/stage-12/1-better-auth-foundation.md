# Stage 12.1: Better Auth foundation

Status: complete. One deviation from the original plan: Game Sandbox does not layer a single-role invariant or an exact-admin `/api/auth/admin/*` guard over Better Auth. It uses the admin plugin's native role handling directly (a comma-splittable `role` string, with `adminRoles` defaulting to `['admin']`), because no supported operation writes a composite role and status derivation resolves any value deterministically. `better-auth` is pinned at `1.6.23`; `getMigrations` imports from `better-auth/db/migration`, and the bootstrap seed writes the reserved-id user through the auth context's internal adapter, which honors a supplied id.

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
  insecureDevelopment: boolean
  adminEmail: string
  adminPassword: string
  adminName: string
  github?: AuthGithubOptions
}
```

The required `.env.default` owns the concrete class-scale defaults, including the published local credentials and the insecure-development opt-in. A normal startup requires deployment overrides for `PUBLIC_ORIGIN`, `AUTH_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`. The published development values are accepted only when `AUTH_ALLOW_INSECURE_DEFAULTS=true` and `PUBLIC_ORIGIN` has hostname `localhost`, `127.0.0.1`, or `[::1]`; that mode also binds the HTTP listener to the corresponding loopback interface instead of `0.0.0.0`. Parent-process deployment variables take priority over the file, and a normal deployment provides real credentials and sets `AUTH_ALLOW_INSECURE_DEFAULTS=false`. The explicit opt-in and listener restriction keep accidental deployments from starting with published credentials, while a developer can use the tracked local setup without inventing secrets.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTH_SECRET` | `dev-secret-do-not-deploy-32-chars` | The Better Auth signing secret for cookies and tokens. The development value satisfies Better Auth's minimum length but is public and accepted only with the explicit insecure-defaults opt-in on a loopback origin. |
| `PUBLIC_ORIGIN` | `http://localhost:8080` | The public origin the site is reached at, used for cookie origin checks and OAuth callbacks. Override it together with `PORT` when changing the local port. A normal startup requires a deployment value. The GitHub callback URL is `<PUBLIC_ORIGIN>/api/auth/callback/github`. |
| `AUTH_TRUSTED_ORIGINS` | unset | Extra comma-separated origins, appended to the built-in list. That list includes `http://localhost:5173` only when insecure defaults are explicitly enabled on a loopback origin; otherwise it contains only `PUBLIC_ORIGIN` plus the configured extras. |
| `AUTH_ALLOW_INSECURE_DEFAULTS` | `true` | Allows the published development secret and bootstrap credentials, but only with a loopback `PUBLIC_ORIGIN`. Never enable it in a deployment. |
| `ADMIN_EMAIL` | `admin@example.com` | The bootstrap admin's development email. The value is accepted only with the explicit insecure-defaults opt-in on a loopback origin; a deployment must set it explicitly. |
| `ADMIN_PASSWORD` | `admin-dev-password` | The bootstrap admin's development password, re-synced on every boot. The value is accepted only with the explicit insecure-defaults opt-in on a loopback origin; a deployment must set it explicitly. |
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
    plugins: [admin({ ac, roles, defaultRole: 'pending' })],
  })
}
```

The instance is constructed in `main.ts` and in the test harness, never at module load, matching the config-injection rule that no service reaches for global state.

## Roles and the standalone ban

`pending` is not one of the admin plugin's built-in roles (`user`, `admin`), and Better Auth requires a custom role to be declared in an access-control config before `defaultRole` and role filtering will treat it as first-class. `backend/src/auth/permissions.ts` builds that config with `createAccessControl` over the admin plugin's default statements and exports `ac` plus a `roles` map declaring `admin`, `user`, and `pending`; `createAuth` passes both into `admin({ ac, roles, ... })`. The exact import paths (`better-auth/plugins/access` and `better-auth/plugins/admin/access`) are among the helper locations verified against the pinned version at implementation time. `pending` and `user` have no admin-plugin permissions. The `admin` role is an explicit allowlist of the roster operations this stage supports, including list, create, set-role, ban, unban, and set-password, and deliberately omits the plugin's `user:delete` permission. Consequently `POST /api/auth/admin/remove-user` is refused by the plugin even for an admin session, not merely hidden in the frontend. Status is derived from the raw `role` in [step 2](2-identity-and-authorization.md). Ban stays orthogonal to role: it is the admin plugin's own `banned` flag, enforced by revoked sessions and blocked sign-in, not a fourth role.

Role handling is Better Auth's own, with no extra invariant layered on top. The admin plugin stores `role` as a string that may hold a comma-separated list, comma-splits it for its permission checks, and treats the acting user as an administrator when any split role is in `adminRoles` (which defaults to `['admin']`). This deployment relies on that behavior directly: the seed and the admin roster endpoints only ever write a single scalar role, so a composite role is not something any supported operation creates, and the permission surface is shaped entirely by the access-control config above. Status derivation in [step 2](2-identity-and-authorization.md) reads the same comma-split list with `admin` taking precedence over `user` over `pending`, so a hand-corrupted composite value still resolves to a well-defined status rather than needing a separate guard.

## Schema migration

`backend/src/auth/migrate.ts` exposes `migrateAuthSchema(auth: Auth): Promise<void>`, which runs Better Auth's programmatic Kysely migration over the shared connection: it reads the required migrations for the configured options and enabled plugins and applies the ones the live database is missing. `main.ts` calls it right after the app's own schema bootstrap, and the test harness calls it on each `:memory:` database.

## Fastify mount

`backend/src/auth/routes.ts` exposes `registerAuthRoutes(app, deps: { auth: Auth })`, an encapsulated plugin that registers the documented Better Auth Fastify handler: one catch-all route for GET and POST on `/api/auth/*` that builds a Fetch `Request` from the Fastify request, calls `auth.handler(request)`, and copies the returned status, headers, and body back onto the Fastify reply. It is registered in `buildApp` alongside the other route registrations and before the SPA fallback, but only when an `auth` instance is present: `AppDeps` gains an _optional_ `auth?: Auth` field in this step, so the existing app-building suites, which pass no `auth`, are untouched and keep landing green. [Step 2](2-identity-and-authorization.md) makes the field required once the seam consumes it and every suite mints real sessions.

The body-parsing problem is handled inside the plugin scope. Better Auth's handler must see the exact request bytes, but the app's global JSON parser would consume the body first, and its default parser also rejects an empty body with a 400, which breaks the empty-bodied sign-out post. Inside the encapsulated plugin, register a scoped content-type parser for `application/json` that keeps the raw string and tolerates an empty body, and pass that raw string through as the `Request` body. Because Fastify plugins are encapsulated, this parser applies only within the auth plugin and the app's global parsing is untouched.

## Admin seed

`backend/src/auth/seed-admin.ts` exposes `ensureAdminUser(auth, { email, password, name }, log)`, run by `main.ts` after `migrateAuthSchema`. It owns one reserved, stable Better Auth user id, `game-sandbox-bootstrap-admin`, so changing `ADMIN_EMAIL` updates the same bootstrap account instead of creating another administrator. It is idempotent and treats deployment configuration as the source of truth:

1. Look up the user by the reserved id through the auth context's internal adapter.
2. If missing, first refuse startup when another user already owns the configured email, then create the reserved-id user server-side with role `admin`.
3. If present, first refuse startup when the configured email belongs to a different user, then update this same user's email and name, force its role back to `admin`, clear the ban fields, and reset the password to the configured value. Two version-specific details are verified against the pinned Better Auth at implementation time: supplying the reserved id on server-side creation, updating role and ban fields through the auth context's internal adapter, and rewriting the credential `account` row (not the `user` row) through the internal adapter and the context's password hasher, or by reusing the admin plugin's `setUserPassword` if it can run without a session on the server.

Resyncing the password on every boot is deliberate. Rotating `ADMIN_PASSWORD` in deployment configuration and restarting rotates the credential with no manual step, and an admin account that was demoted, banned, or had its password changed heals on the next restart. A restart with unchanged configuration is a no-op apart from writing an equivalent password hash.

## Startup wiring

`main.ts` orders the boot as `loadConfig`, then `openSqlite(config.dbPath)` (which builds the app schema), then `createAuth(sqlite, config.auth)`, then `migrateAuthSchema(auth)`, then `ensureAdminUser(auth, config.auth, log)`, then the rest of the existing wiring, then `buildApp` with `auth` in its deps. An explicitly opted-in development setup logs warnings for the published credentials and binds Fastify to the loopback interface represented by `PUBLIC_ORIGIN`. A normal startup binds to `0.0.0.0` only after `loadConfig` has received an explicit public origin, signing secret, and bootstrap credentials.

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
- `ensureAdminUser` creates the reserved-id admin once, a second run changes nothing observable, and after demoting the account and changing the configured email and password a re-run restores the same user id and role, moves sign-in to the new email and password, and leaves no second admin. An email collision with another user refuses startup.
- Config parsing enforces the both-or-neither GitHub rule, parses `AUTH_TRUSTED_ORIGINS`, requires an explicit public origin and credentials in normal mode, rejects the published development credentials unless both the explicit opt-in and a loopback origin are present, rejects the opt-in itself for a non-loopback origin, and includes the Vite origin automatically only in that opted-in local mode. The parser derives `listenHost` as a loopback interface in insecure mode versus `0.0.0.0` in normal mode, so the binding restriction is asserted without booting `main.ts`.
- An admin session can perform each supported roster operation but receives a forbidden response from `POST /api/auth/admin/remove-user`, proving deletion is absent from the server-side role rather than only the UI.
- `TestUsers.headersFor` yields headers that `GET /api/auth/get-session` accepts, a `status: 'pending'` user carries role `pending`, and `ban()` makes a previously issued cookie stop resolving.

## Done when

The backend starts with Better Auth mounted at `/api/auth/*` on the shared SQLite database, the one stable bootstrap-admin account exists and re-syncs from explicit deployment configuration on every boot, normal mode requires an explicit public origin and credentials, insecure development requires an explicit opt-in and a loopback-only listener, email and password sign-in works over `app.inject` and over HTTP, user deletion is refused server-side, self-registration is refused, and the harness can mint real signed-in users for any suite. Identity resolution everywhere else in the backend is still the untouched Stage 3 stub, so the rest of the suite is unchanged by this step.
