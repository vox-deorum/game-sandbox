# Stage 12.2: Identity seam and status authorization

Status: not started

Part of [Stage 12](../stage-12-user-system.md). This is build-order step 2, the identity seam swap and the one breaking step of the stage. The synchronous `resolveUserId(headers, query)` from Stage 3 becomes an asynchronous cookie-session lookup, the single derived status replaces both environment-variable allowlists, and every route's authorization is stated explicitly against the status model. After this step the `x-sandbox-user` header does nothing, the `?user=` channel is gone, and every backend test authenticates with a real session minted by [step 1](1-better-auth-foundation.md)'s harness.

## The rewritten seam

`backend/src/identity.ts` keeps its role as the one place the backend decides who a request belongs to, but its shape changes from header parsing to a session lookup and its authorization predicates change from allowlists to status:

```ts
export type UserStatus = 'pending' | 'normal' | 'admin'

export interface AuthUser {
  id: string
  name: string
  email: string
  image: string | null
  status: UserStatus
}

export function deriveStatus(role: string | null | undefined): UserStatus

export interface RequestIdentity {
  resolveUser(request: FastifyRequest): Promise<AuthUser | null>
  requireUser(request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | undefined>
  requireActive(request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | undefined>
  requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | undefined>
}

export function createRequestIdentity(auth: Auth): RequestIdentity
```

`deriveStatus` is a pure function of `role` alone: role `admin` is `admin`, role `pending` is `pending`, and anything else — including the plugin's built-in `user` role — is `normal`. Ban is not part of this mapping: it is a standalone flag Better Auth enforces by revoking sessions and blocking sign-in, so a banned user never carries a live session and `deriveStatus` is only ever reached for a non-banned user. Status is therefore one of three values; `banned` is not a request-time status.

`resolveUser` wraps the auth server's session lookup over the request headers and maps the session user's `role` through `deriveStatus`, returning `null` for an anonymous request. As defense in depth it also returns `null` if a resolved user is somehow flagged `banned`, though Better Auth has already revoked their sessions, so a banned user is treated as anonymous. Cookies ride browser fetches, WebSocket upgrade requests, and native download navigations on the same origin, so this one resolution path serves fetches, upgrades, and downloads, and the WebSocket `?user=` query channel is deleted rather than replaced. The lookup is memoized per request on a `WeakMap` keyed by the request object, so a route that both guards and personalizes does not query the session twice.

The three guards build on `resolveUser`. `requireUser` sends `401 { code: 'auth_required' }` and returns `undefined` when the request is anonymous, otherwise it returns the user. `requireActive` is `requireUser` followed by `403 { code: 'not_active' }` unless the status is `normal` or `admin`. `requireAdmin` is `requireUser` followed by `403 { code: 'not_operator' }` unless the status is `admin`. The guards return `undefined` after sending the error reply, matching the early-return style the handlers already use. The admin guard keeps the `not_operator` wire code because the admin console branches on it and "operator" stays the persona name in the docs; only its source of truth moves from the operator allowlist to `status === 'admin'`.

`resolveUserId`, `isAllowlisted`, `isOperator`, `DEV_USER_ID`, and the header and query-parameter constants are all deleted.

## GET /api/me

`/api/me` returns the session user and its status, or a null user for an anonymous request, and drops the `allowlisted` and `is_operator` booleans the frontend used to read:

```jsonc
// signed in                                    // anonymous
{ "user": { "id": "...", "name": "...",         { "user": null }
            "email": "...", "image": null,
            "status": "normal" } }
```

Anonymous is a `200` with `user: null`, not a `401`, so the app shell can render its signed-out state from a successful fetch. The frontend derives its capabilities from `status` in [step 3](3-frontend-auth.md).

## Authorization matrix

Each route group states its minimum requirement. Public reads stay open to anonymous visitors exactly as today; only the mutating and owner-scoped routes gain a guard.

| Route group | Requirement |
| --- | --- |
| `GET /api/environments`, `/api/config`, `/api/docs/*`, `GET /api/sessions/:id`, `GET /api/recordings` and `/:id`, public leaderboard and season reads, agent profiles, `GET /api/me` | Public. Anonymous is allowed. |
| `GET /api/environments/:envId/watch-agents` | Public, but personalized only when a user resolves. An anonymous caller gets the unpersonalized view with no rating status and no operator extras. |
| `GET /api/sessions/:id/ws` | Public spectate via `resolveUser`. An anonymous socket attaches with a null user and can never be the owner or hold the human seat. |
| `POST` and `DELETE /api/recordings/:id/pin`, `GET /api/submissions`, `GET /api/submissions/:id` | `requireUser`. A pending user may look at their own things; the existing ownership checks are unchanged, and an admin keeps the operator override on `GET /api/submissions/:id`. |
| `POST /api/sessions`, `DELETE /api/sessions/:id`, `POST /api/submissions`, `POST /api/submissions/reachability`, rating writes, author rating-prompt writes | `requireActive`. This replaces the `isAllowlisted` gate at the rating write and the orchestrator's own allowlist check. |
| `/api/admin/*` (the single `onRequest` hook), `GET /api/seasons?includeUnreleased=true`, the admin download links | `requireAdmin`. |

Two rows carry a caveat. `GET /api/seasons` is public; only the `includeUnreleased=true` variant needs `requireAdmin`, so that handler resolves identity and gates inline on the query flag rather than gating the whole route. Pin and unpin sit under `requireUser`, not `requireActive`, because they are an owner's own-library actions already scoped by the existing ownership check; a pending user is admitted but owns no recordings to pin (they cannot start sessions), so the looser gate is inert today — noted so a later change that lets pending users accrue recordings revisits it.

## Module and deps changes

`AppDeps` loses `allowlist` and `operatorAllowlist`. `buildApp` builds `const identity = createRequestIdentity(deps.auth)` once from the `auth` instance added in [step 1](1-better-auth-foundation.md), where it was optional; this step makes `auth` a required `AppDeps` field, since the seam now consumes it and every suite mints sessions. That `RequestIdentity` threads into the route modules. `AdminDeps`, `LeaderboardDeps`, and `RatingDeps` replace their `operatorAllowlist` or `allowlist` fields with `identity: RequestIdentity`.

The orchestrator drops the allowlist. The `isAllowlisted(request.userId, config.sessionAllowlist)` check in `start()` and its `not_allowlisted` `OrchestratorError` are deleted, because the route guard now refuses a non-active user before the orchestrator is called. The orchestrator keeps owning the one-concurrent-session-per-user rule, and `attach` takes `userId: string | null` so an anonymous spectator can attach without being mistaken for an owner.

`Config` drops `sessionAllowlist` and `operatorAllowlist` and their `listVar` reads, and the now-unused `DEV_USER_ID` import goes with them. The WebSocket session handler and the admin log-stream guard resolve identity from the upgrade request's cookie header, and the `request.query` identity argument disappears from their signatures. The admin download flow drops its `?user=` channel: the frontend URL builders stop appending it and `resolveUserId`'s query-parameter read (which the admin prefix used so a native download navigation could carry identity without the header) is gone, because the browser now sends the session cookie on the download navigation.

Handlers keep resolving identity inline rather than through a global hook, so a public route pays for no session lookup:

```ts
app.post<{ Body: StartBody }>('/api/sessions', { schema: START_SESSION_SCHEMA }, async (request, reply) => {
  const user = await identity.requireActive(request, reply)
  if (user === undefined) return
  // ... deps.orchestrator.start({ userId: user.id, ... })
})
```

## Attribution and data

The `user_id` columns on `sessions`, `recordings`, `submissions`, `ratings`, and `season_runs` keep their plain-string type, and new rows carry Better Auth user ids. There is no data migration: the codebase builds its schema fresh and dev databases are recreated, so there is no legacy `dev-user` data to rewrite. The frontend wire change this creates — the `POST /api/sessions` failure code carried on the `403` moves from `not_allowlisted` (formerly thrown by the orchestrator) to `not_active` (now sent by `requireActive` before the orchestrator runs), which `startSession` maps onto the `StartSessionResult` union in `api/client.ts` — is consumed in [step 3](3-frontend-auth.md).

## Implementation decisions

- **No `x-sandbox-user` fallback anywhere in production code.** The whole value of the seam was that it could be replaced without leaving a second trust path to reason about. Tests mint real sessions through the harness instead of setting a header, so the boundary the tests exercise is the one that ships.
- **Guards on `RequestIdentity`, not Fastify decorators.** The explicit-deps object matches the repo's style and keeps route modules unit-testable without standing up a real app and a real auth instance.
- **One session lookup per request.** The `WeakMap` memoization inside `createRequestIdentity` means a route that guards and then personalizes, such as `watch-agents`, resolves the session once.

## Tests

Rewrite `backend/test/identity.test.ts` around the new surface: `deriveStatus` mapping each role to its status, `resolveUser` treating a banned user as anonymous, and guard behavior over a stub `Auth`, so an anonymous request gets `401 auth_required`, a pending user gets `403 not_active` from `requireActive`, and a non-admin gets `403 not_operator` from `requireAdmin`.

Migrate every suite that set the header, `test/app.test.ts`, `test/submission/api.test.ts`, `test/admin/api.test.ts`, `test/ratings/api.test.ts`, `test/leaderboards/api.test.ts`, and the integration `support/stack.ts` and `support/ws-client.ts`, to `await users.headersFor(...)`. New assertions across those suites:

- `/api/me` returns `user: null` when anonymous, round-trips each status when signed in, and returns `user: null` for a user banned after their cookie was issued, proving revocation.
- The matrix holds: a pending user gets `403 not_active` on session start, submit, reachability, a rating write, and an author-prompt write; an anonymous request gets `401 auth_required` on the same; pin, unpin, and own-submission reads work for a pending user; and public reads work anonymously.
- The admin guard refuses a `normal` user with `403 not_operator`, admits an `admin`, and the admin log-stream WebSocket authenticates from the upgrade cookie.
- The session WebSocket attaches an owner with controls from their cookie, lets a second signed-in user spectate, lets an anonymous socket spectate without controls, and writes attribution rows carrying Better Auth ids.
- The orchestrator suite drops its allowlist-rejection tests, and its one-concurrent-session and owner-stop tests keep passing with real user ids.
- The Docker-gated integration lane passes the session cookie on fetches and through the `ws` client's `headers` option.

## Done when

No source or test file references `x-sandbox-user`, `SESSION_ALLOWLIST`, `OPERATOR_ALLOWLIST`, `resolveUserId`, `isAllowlisted`, or `isOperator`. Every mutating route enforces the status matrix, public reads stay anonymous-friendly, WebSockets and downloads authenticate by cookie, `/api/me` serves the new shape, and the full backend suite is green on real sessions.
