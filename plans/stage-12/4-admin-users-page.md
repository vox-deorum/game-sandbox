# Stage 12.4: Admin Users page

Status: not started

Part of [Stage 12](../stage-12-user-system.md). This is build-order step 4, the roster UI. User management needs no bespoke backend routes, because Better Auth's admin plugin already exposes the operations under `/api/auth/admin/*`, gated server-side by the plugin's `adminRoles: ['admin']` check from [step 1](1-better-auth-foundation.md). So this step is mostly a frontend page over the admin client from [step 3](3-frontend-auth.md), plus a small backend addition that puts human display names on the public payloads that today show raw user ids.

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

There is deliberately no remove-user action in the UI. Submissions, recordings, ratings, and placements key on the user id, so deleting a user would orphan that attribution. Ban is the retirement path.

## The page

`pages/UsersAdminPage.vue` at route `/admin/users` self-gates on `isAdmin(me)` the way `AdminConsolePage.vue` self-gates, with the plugin's server-side `adminRoles` check as the real authority. It builds from the design-system primitives and the semantic tokens, and any new primitive variant it needs is added to the dev-only `/styleguide` route.

- Status tabs each map to one `list-users` filter, which they can because ban is standalone rather than a precedence over role: All applies no filter, Pending/Normal/Admins filter `role` (`pending`/`user`/`admin`), and Banned filters `banned = true`. A banned user therefore appears under the Banned tab and, if they still hold a role, under that role's tab too — consistent with ban being an orthogonal flag. A search box queries email or name, and a paged table of 50 rows shows the name, email, a status badge, and the created date.
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

It reads display names from Better Auth's `user` table with a locally-typed raw Kysely query, rather than extending the app's `Database` schema type, because that table is library-owned (see the migration decision in [step 1](1-better-auth-foundation.md)) and the app never writes it. Threaded through `AppDeps`, and into `AdminDeps` and `LeaderboardDeps` where they are needed, it adds:

- `owner_name` on `GET /api/environments/:envId/agents/:ownerId`.
- `owner_name` in the operator extras of `watch-agents` and `user_name` on the admin season submissions list.
- `agent_user_name` on the leaderboard board rows that carry an `agent_user_id`.

The frontend renders the name wherever the id shows today, on the agent profile header, the board rows, and the admin lists, keeping the id as a tooltip and fallback for a missing user.

## Implementation decisions

- **Drive the plugin endpoints directly with `authClient.admin.*`, not a proxy through `/api/admin`.** Proxy routes would re-implement an already-gated, already-typed API for no gain. This page is the one place `authClient.admin` is used.
- **`UserDirectory` reads the `user` table with a locally-typed raw query.** The table is library-owned, so the app does not fold it into its own schema type, and the directory only reads it.

## Tests

- Frontend, `frontend/test/users-admin.test.ts`, with `authClient.admin` mocked: the roster renders with correct status badges, the search box and the status tabs issue the right queries, the approve, promote, ban, unban, and create flows call the right client methods and refresh the list, a non-admin sees the access notice, and self-targeting actions are disabled.
- Backend: a `UserDirectory.namesFor` unit test, and assertions that `owner_name` and `agent_user_name` are present on the agent profile and board payloads, extending the existing suites.
- The sidebar Users entry renders only for an admin.

## Done when

An admin lists, searches, and pages the roster; approves a pending GitHub sign-up; creates a fixed email and password account; bans a user with a reason and unbans them; and promotes and demotes, with every action effective immediately against the status gates from [step 2](2-identity-and-authorization.md). Public agent and board views show display names instead of raw ids.
