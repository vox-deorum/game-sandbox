# Stage 12.4: Admin Users page

Status: complete. Two notes. `UserDirectory.namesFor` reads the `user` table with a locally-typed raw better-sqlite3 prepared statement rather than a raw Kysely query: the module boundary from step 1 deliberately denies `kysely` imports in `auth/**` while admitting `better-sqlite3` there, and the substantive intent — no extension of the app's `Database` schema type — is unchanged. Blind attribution got stricter than the pre-stage status quo: because public leaderboard payloads now pair `user_id` with `user_name`, an opaque id is trivially reversible, so a blind viewer sees a human seat as a neutral "Human" (no name, no id, no tooltip) rather than the opaque id, the viewer's own seat excepted; live-session and replay surfaces share one `hasSubmittedAgent` gate so an all-human game is never masked.

Part of [Stage 12](../stage-12-user-system.md). This is build-order step 4, the roster UI. User management needs no bespoke backend routes, because Better Auth's admin plugin already exposes the supported operations under `/api/auth/admin/*`, gated server-side by the custom admin role from [step 1](1-better-auth-foundation.md). That role deliberately lacks user deletion. So this step is mostly a frontend page over the admin client from [step 3](3-frontend-auth.md), plus a small backend addition that puts human display names on every payload whose opaque Better Auth user id is shown to a person.

## Endpoints consumed

The page drives the admin client's methods, which call the plugin endpoints:

| Action | Endpoint | Notes |
| --- | --- | --- |
| List the roster | `GET /api/auth/admin/list-users` | `searchValue` with `searchField` over email or name (a contains match), `limit` and `offset` for paging, and a single `filterField` per request: the role tabs filter `role`, and the standalone Banned tab filters `banned`. Returns the page of users and a total. |
| Create a user | `POST /api/auth/admin/create-user` | Name, email, password, and role, with role `user` as the dialog default. |
| Approve a pending user | `POST /api/auth/admin/set-role` | Role `user`. |
| Promote or demote | `POST /api/auth/admin/set-role` | Role `admin` or role `user`. |
| Ban or unban | `POST /api/auth/admin/ban-user` and `unban-user` | An optional `banReason`. Banning revokes the user's sessions and blocks sign-in. |
| Reset a password | `POST /api/auth/admin/set-user-password` | The admin sets a new fixed password. |

There is deliberately no remove-user action in the UI. Submissions, recordings, ratings, and placements key on the user id, so deleting a user would orphan that attribution. Ban is the retirement path. This is a server-side invariant as well as a UI choice: the custom admin role omits `user:delete`, and a direct `POST /api/auth/admin/remove-user` receives a forbidden response even from an admin session.

## The page

`pages/UsersAdminPage.vue` at route `/admin/users` self-gates on `isAdmin(me)` the way `AdminConsolePage.vue` self-gates, with the plugin's server-side custom-role permission check as the real authority. It builds from the design-system primitives and the semantic tokens, and any new primitive variant it needs is added to the dev-only `/styleguide` route.

- Status tabs each map to one `list-users` filter because the auth boundary enforces one canonical role per user: All applies no filter, Pending/Normal/Admins filter `role` (`pending`/`user`/`admin`), and Banned filters `banned = true`. A banned user therefore appears under the Banned tab and under the tab for their role, consistent with ban being an orthogonal flag. The local badge helper maps the same three canonical values as `deriveStatus` and treats any noncanonical value as pending, so an imported or corrupted row fails closed in the All view. A search box queries email or name, and a paged table of 50 rows shows the name, email, a status badge, and the created date.
- Row actions depend on the row's status: Approve for a pending user, Promote or Demote, Ban with a reason prompt or Unban, and Reset password. Actions that would target the acting admin are disabled client-side, and Better Auth also refuses a self-ban server-side.
- A create-user dialog takes a name, email, password, and role. This is the manual-account path for a student who has no GitHub account.
- The status badge shows the role-derived status (`pending`/`normal`/`admin`) and, independently, a banned marker when the row is banned — ban decorates rather than replaces the role, matching the standalone model — from a small helper local to the page.

## Navigation

`AppSidebar.vue` gains a global "Users" entry, shown only to an admin through `isAdmin`, grouped with the existing admin affordances, and `frontend/src/main.ts` adds the route.

## Public display names

Rows across the app store Better Auth user ids, which are opaque, so the UI must not regress from readable handles to random ids. `backend/src/auth/users.ts` adds a small directory:

```ts
export interface UserDirectory {
  namesFor(ids: readonly string[]): Promise<Map<string, string>>
}
export function createUserDirectory(sqlite: BetterSqlite3.Database): UserDirectory
```

It reads display names from Better Auth's `user` table with a locally-typed raw Kysely query, rather than extending the app's `Database` schema type, because that table is library-owned (see the migration decision in [step 1](1-better-auth-foundation.md)) and the app never writes it. Callers batch ids through `namesFor` rather than issuing a query per row. The directory is threaded through `AppDeps`, `AdminDeps`, `LeaderboardDeps`, `RatingDeps`, the orchestrator, and the workflow runner wherever a response or recording attribution crosses the UI boundary. It adds:

- `owner_name` on `GET /api/environments/:envId/agents/:ownerId`.
- `owner_name` in the operator extras of `watch-agents` and `user_name` on the admin season submissions list.
- `user_name` on the submission variant of the shared `BoardAgentRef`, beside its stable `user_id`. Leaderboard rows and run-game slots both carry this nested agent shape, so one contract gives the main board and shared matchup table readable owners.
- A resolved owner name for each submitted agent in the personalized session-rating view, so its `display_name` never formats an opaque user id as `<id>'s agent` after blind feedback closes.
- `user_name` on recording summaries from `GET /api/recordings`, and `user_name` on `GET /api/sessions/:id`, so the replay list, replay metadata, and live-session metadata show the owner's name.
- `requested_by_name` on admin run summaries and details. Together with the enriched `BoardAgentRef`, this covers the admin run list, admin run details, and the public released-season matchup table that uses the same game component.

Recording-header attribution needs one additional path because `GET /api/recordings/:id` streams an immutable NDJSON artifact rather than a JSON payload the route can decorate. Before either a live session or a headless workflow game launches, its caller batches the human and submission-owner ids through `UserDirectory` and passes both stable ids and display names into `assembleSeats`. The header keeps each stable id in `player.user`, but its human `label` is the display name and its submitted-agent label is `<display name>'s agent`. The stored recording is written once at launch and never rewritten. A missing directory row falls back to the stable id at every boundary, and the frontend keeps that id in a tooltip wherever a separate name field is rendered.

Because blind rating must hold against the raw API and not only the UI (a public leaderboard already pairs `user_id` with `user_name`, so an opaque id is trivially reversible), the two public recording reads enforce the blind decision server-side rather than relying on the browser to mask. `recordings-view.ts` owns that decision, an operator is never blind, a recording with no play-open season or no submitted agent has nothing to hide, and an unresolved caller stays blind, mirroring the frontend's `isBlindReplay` gate. For a blind viewer `GET /api/recordings` masks each row's header attribution and drops the owner name (keeping the owner id only for the owner, who needs it to pin), and `GET /api/recordings/:id` rewrites only the header line of the stream (the state lines pass through byte-for-byte) before serving it. The masking strips the reversible `user` id and the `<owner>'s agent` label but keeps the opaque `submission_id`, so the client still numbers a masked agent as "Agent N" and the viewer's own seat stays identified. The stored artifact is unchanged; only the read is masked.

The frontend renders the name wherever the id shows today: the agent profile header, watch-agent operator details, personalized rating view, leaderboard rows, replay list and viewer metadata, live-session metadata and player attribution, admin submission and run lists, run details, and game tables. Stable ids remain the values used for ownership checks, links, keys, and tooltips, and are the visible fallback only when the directory has no matching user.

## Implementation decisions

- **Drive the plugin endpoints directly with `authClient.admin.*`, not a proxy through `/api/admin`.** Proxy routes would re-implement an already-gated, already-typed API for no gain. This page is the one place `authClient.admin` is used.
- **`UserDirectory` reads the `user` table with a locally-typed raw query.** The table is library-owned, so the app does not fold it into its own schema type, and the directory only reads it.
- **Recording attribution snapshots a display name.** A recording must remain replayable without joining mutable auth data into its NDJSON stream. `player.user` remains the durable identity, while `player.label` captures the name in use when the game launched; other API responses resolve the current name from the directory.

## Tests

- Frontend, `frontend/test/users-admin.test.ts`, with `authClient.admin` mocked: the roster renders with correct status badges, the search box and the status tabs issue the right queries, the approve, promote, ban, unban, and create flows call the right client methods and refresh the list, a non-admin sees the access notice, and self-targeting actions are disabled.
- Backend: a `UserDirectory.namesFor` unit test, plus assertions for all enriched payloads: agent profile, operator watch choices, personalized rating views, nested leaderboard `BoardAgentRef` values, recording summaries, session detail, admin submissions, run summaries and details, and run-game slots. Live-session and workflow launch-config tests prove recording headers preserve opaque ids in `player.user` while using display names in `player.label`, including the missing-user fallback.
- Frontend: extend the existing agent, picker, leaderboard, replay list, replay viewer, live session, season submissions, run list, run details, and games-table tests to assert names are visible, ids remain available as tooltips or fallbacks, and ownership and profile links still use ids.
- The sidebar Users entry renders only for an admin.

## Done when

An admin lists, searches, and pages the roster; approves a pending GitHub sign-up; creates a fixed email and password account; bans a user with a reason and unbans them; and promotes and demotes, with every action effective immediately against the status gates from [step 2](2-identity-and-authorization.md). Direct user deletion is refused server-side. Agent, board, replay, live attribution, submission, run, and game-table views show display names instead of opaque ids while retaining ids for identity and navigation.
