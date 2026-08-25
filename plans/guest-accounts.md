# Guest Accounts and Anonymous Name Masking

Status: complete.

## Goal

Let people try the platform without joining the competition. A new signed-in account status, `guest`, can play and watch sessions like a normal user, but never sees real user names, cannot rate, and cannot submit. The rating and submission interfaces stay open and explorable; their commit buttons block on press with a toast. Admins create guest accounts with email and password.

The same name masking now applies to visitors who are not signed in: real user names are visible only to signed-in participants (`pending`, `normal`, `admin`), turning masking from a courtesy into an API rule the backend enforces on its public read surfaces.

## Mechanism

- **Role token**: `guest`, derived status `guest`. Precedence in `deriveStatus`: admin > user > guest
  > pending; unknown roles still fail closed to `pending`. `backend/src/auth/permissions.ts` declares the role so the admin plugin accepts it in `create-user` and `set-role`.
- **Guard split**: `requirePlayer` (guest, normal, or admin) gates only session start/stop; everything else keeps `requireActive`, so guests are refused submission, ratings, rating prompts, and dev keys.
- **Names rule**: `namesVisible(caller)` is true only for signed-in non-guest callers. Public reads (leaderboards, session detail, recording lists and streams, agent profiles) omit names for anonymous and guest callers but keep the opaque user id.
- **Hash labels**: shared, dependency-free `maskedAgentLabel` / `maskedPlayerLabel` in `schema/ts/src/accounts.ts` (FNV-1a over the user id, 6 hex chars), used by both backend and frontend so labels agree. Masked viewers get `Agent <hash>` / `Player <hash>` on every surface.
- **Blind mode interplay**: the season-scoped "Agent N" blind rating for participants is unchanged; a masked viewer gets hash labels regardless of the play window.
- **Toast**: a new `UiToast` primitive plus a singleton `useToast()` queue, hosted once in `AppShell`, bottom-center, auto-dismissing, `role="status"`.

## Files

- schema/ts/src/accounts.ts (status union, `maskedUserHash`, label helpers)
- backend/src/auth/permissions.ts, backend/src/auth/identity.ts (`requirePlayer`, `namesVisible`)
- backend/src/session/routes.ts, backend/src/recordings/view.ts and routes.ts, backend/src/ratings/routes.ts, backend/src/leaderboards/routes.ts, backend/src/submission/routes.ts
- frontend/src/api/client.ts, frontend/src/me.ts (`canPlay`, `hidesNames`), frontend/src/toast.ts
- frontend/src/components/ui/UiToast.vue, frontend/src/components/AppShell.vue
- frontend/src/lib/anonymity.ts, frontend/src/lib/attribution.ts
- frontend/src/pages/EnvironmentPage.vue, frontend/src/components/WatchAgentPicker.vue, frontend/src/components/SessionRatings.vue, frontend/src/pages/AgentProfilePage.vue, frontend/src/components/SubmitAgentForm.vue
- frontend/src/components/LeaderboardBoards.vue, frontend/src/components/GamesTable.vue, frontend/src/pages/ReplaysPage.vue, frontend/src/pages/ReplayPage.vue, frontend/src/pages/SessionPage.vue, frontend/src/components/PlayerAttribution.vue, SeatAttribution.vue, GameOverCard.vue, ChatPanel.vue, GameThread.vue
- frontend/src/components/admin/CreateUserDialog.vue, frontend/src/pages/UsersAdminPage.vue, frontend/src/components/admin/UsersTable.vue
- frontend/src/pages/StyleguidePage.vue, backend and frontend tests
- docs/specs/identity.md, docs/specs/frontend.md
