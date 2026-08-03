# Stage 12.3: Frontend sign-in and session

Status: complete

Part of [Stage 12](../stage-12-user-system.md). This is build-order step 3: the single-page app stops inventing an identity and starts carrying the Better Auth session cookie. A login page appears, sign-out becomes real, the pending notice lands, and `frontend/src/identity.ts` is deleted. It builds on the backend from [step 2](2-identity-and-authorization.md), which now serves the new `/api/me` shape and enforces status on every mutating route.

## Auth client

`frontend/src/auth.ts` creates the one Better Auth Vue client the app uses:

```ts
import { adminClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/vue'

export const authClient = createAuthClient({
  baseURL: `${window.location.origin}/api/auth`,
  plugins: [adminClient()],
})
```

`better-auth` joins `frontend/package.json`. Sign-in, sign-out, and the roster calls in [step 4](4-admin-users-page.md) go through this client; every other request keeps using the typed wrappers in `api/client.ts`. The `adminClient` plugin is added here so the same client serves the roster page without a second construction.

## Requests carry cookies, not headers

`frontend/src/identity.ts` and its test are deleted. Same-origin fetches send cookies by default, so the `request()` helper in `api/client.ts` simply drops the `identityHeaders()` call, and `api/socket.ts` and `api/runLogSocket.ts` drop `withIdentityParam` because the browser sends the cookie on a same-origin WebSocket upgrade. The two admin download URL builders in `api/client.ts` drop their `?user=` parameter for the same reason.

`request()` gains one interceptor at its single choke point, mirroring where identity headers used to be injected: a `401` whose body carries code `auth_required`, on any page other than `/login`, navigates to `/login`. This is the banned-or-expired mid-session path. Better Auth has revoked the session, so the next API call bounces the user to sign in rather than leaving them on a page whose actions all fail.

Pages that intentionally support anonymous browsing do not use a protected request as an authentication probe. In particular, an ended public session mounts and fetches `SessionRatings` only when `/api/me` has a non-null user; an anonymous spectator sees a sign-in prompt in that panel and is not redirected merely because the session ended. The author-prompt read follows the same rule on signed-out submission pages. The interceptor remains the fallback for a request that began while authenticated and later receives `auth_required` because the session expired or was revoked.

## Me reshape

`api/client.ts` and `me.ts` follow the backend's new shape:

```ts
export type UserStatus = 'pending' | 'normal' | 'admin'
export interface MeUser { id: string; name: string; email: string; image: string | null; status: UserStatus }
export interface Me { user: MeUser | null }
```

`me.ts` keeps `MeState`, `MeProvider`, and `useMe` unchanged in mechanism, still fetching `/api/me` once at startup, and adds the two derived helpers every page that used to read `allowlisted` or `is_operator` now calls:

```ts
export function canParticipate(me: Me | null): boolean // status normal or admin
export function isAdmin(me: Me | null): boolean        // status admin
```

Identity comparisons and profile-link builders update mechanically from `me.me?.user_id` to `me.me?.user?.id` in `ExperimentTabs.vue`, `MyAgentsPage.vue`, `ProfilePage.vue`, `SeasonsPage.vue`, and `AccountMenu.vue`. Visible account labels do not make that mechanical substitution: `ProfilePage.vue` and `AccountMenu.vue` render the session user's name and email, with the opaque id retained only for ownership, links, and an optional diagnostic tooltip. The `allowlisted` gates on the start, submit, and rating flows become `canParticipate`, and the `is_operator` gates on the admin navigation, the console pages, and the operator extras of `watch-agents` become `isAdmin`. The old `currentUserId` fallbacks are removed: when `me.user` is null the affordance renders its signed-out state rather than a fabricated id.

## Login page

`pages/LoginPage.vue` at route `/login` carries both sign-in methods and follows the design system, building from the `UiButton`, `UiField`, and `UiCard` primitives and the semantic tokens rather than ad hoc markup.

- The email and password form calls `authClient.signIn.email`, and on success calls `window.location.assign('/')`. A full navigation re-runs the one `/api/me` fetch, which is simpler and less error-prone than threading a reactive session refresh through the provider.
- The "Sign in with GitHub" button calls `authClient.signIn.social({ provider: 'github', callbackURL: '/' })` and is rendered only when the deployment enables GitHub OAuth (see the capability flag below).
- Error states cover invalid credentials and the banned message Better Auth returns on a banned sign-in attempt.
- There is no registration link. The copy states that accounts come from GitHub, the seeded admin, or an admin creating one, because self-registration does not exist.
- A visitor who is already signed in is redirected to `/`.

## Auth capability on GET /api/config

`GET /api/config` gains a `github_auth: boolean`, threaded through `AppDeps` as a `githubAuth` flag beside the existing `siteName`, derived from whether the auth instance configured a GitHub provider. `useSiteConfig.ts` parses it, and the login page reads it to show or hide the GitHub button. This rides the existing public config read because the login page needs the flag before any session exists. This is the one small backend touch in this step.

## Shell states

`AccountMenu.vue` renders the signed-in user's name and email with the profile link and a working "Log out" that calls `authClient.signOut()` and then `window.location.assign('/login')`; when signed out it renders a "Sign in" link to `/login`, replacing the disabled placeholder button that exists today.

`AppShell.vue` renders a pending banner when `me.me?.user?.status === 'pending'`: a notice that the account is awaiting approval, that browsing works, and that starting sessions, submitting, and rating unlock once an admin approves the user. The start, submit, and rate controls disable through `canParticipate` with the same message inline, so a pending or anonymous user sees why the control is off rather than a dead button.

There is no global router guard. Pages already self-gate, as the admin console does, so anonymous browsing stays exactly as it is, and `/my/agents` and `/my/profile` show a sign-in prompt when the user is null.

## Implementation decisions

- **Full-page navigation after sign-in and sign-out, not reactive session propagation.** The app already fetches `/api/me` exactly once per load, and an auth transition is a rare page-level event, so a full reload keeps `me.ts` the single identity source rather than wiring `authClient.useSession` into the shell as a second one.
- **The 401 interceptor lives in `request()`.** One choke point handles the mid-session ban or expiry, the same place that used to inject the identity header.
- **The `StartSessionResult` reason `not_allowlisted` becomes `not_active`.** `startSession` in `api/client.ts` maps the start `403` from `code: 'not_allowlisted'` to `code: 'not_active'`, the union member is renamed, and the two consumers that branch on it — `EnvironmentPage.vue` and `WatchAgentPicker.vue`, whose copy today reads "You are not on the session allowlist." — switch to the awaiting-approval message. The `request()` 401 interceptor does not touch this, since it is a `403` the start flow handles itself.

## Tests

Frontend Vitest under jsdom, with fetch and the `authClient` module mocked:

- `LoginPage` submits credentials through the mocked client, renders each error state, shows the GitHub button only when `github_auth` is set, and redirects when already signed in.
- `me.ts` parses the new shape, and `canParticipate` and `isAdmin` return the right truth table across the three statuses and the null user.
- `AccountMenu` renders the signed-in and signed-out states, and its log-out calls the client.
- `ProfilePage` renders the signed-in user's name, email, and status without presenting the opaque id as their account label.
- The pending banner renders for `pending` only, and the start, submit, and rate affordances disable for `pending` and anonymous and enable for `normal`.
- `api/client.ts` requests carry no identity header, a `401 auth_required` redirects to `/login`, `startSession` maps the start `403 not_active` onto the renamed union member, and the socket URL builders emit no `user` parameter.
- An anonymous spectator can watch a public session through termination without a ratings request or login redirect, while a signed-in user loads the personalized rating view; signed-out author-prompt UI likewise avoids its protected read.
- The suites that asserted the old shapes, `socket.test.ts`, `api.test.ts`, the experiment-tabs, seasons, and sidebar suites, and the session start-flow suites, follow the reshapes, and the deleted `identity.test.ts` goes with its module.

## Done when

A signed-out visitor browses public pages, opens `/login`, signs in with email and password, or with GitHub when it is configured, and the shell shows their name with a working log-out. A pending user sees the banner and disabled participation controls with honest copy. A user banned mid-session is bounced to `/login` on their next request. `frontend/src/identity.ts` no longer exists, and no request carries `x-sandbox-user` or `?user=`.
