# Stage 12.6: GitHub integration

Status: planned.

Part of [Stage 12](../stage-12-user-system.md). Steps 1 through 5 made GitHub OAuth a sign-in method and nothing more: a GitHub sign-up creates a Better Auth user, but the GitHub identity itself (the username, the avatar, the connection to an already existing account) is dropped at the door. This step connects that identity to the rest of the app. A GitHub sign-in whose verified email matches an existing account attaches to that account instead of minting a duplicate pending user, a signed-in user can link a GitHub account to an email and password account and unlink it again, the captured GitHub username, and for GitHub sign-ups the avatar, appear on the profile and the account menu, and an agent profile links to its owner's GitHub profile, which delivers the link the [Stage 5 plan](../stage-05/6-watch-run-and-agent-profile.md) sketched before Better Auth existed.

## Linking policy

Better Auth's account linking does the heavy lifting, so this is mostly configuration plus UI. In `createAuth()`:

- `account.accountLinking` is enabled with `trustedProviders: ['github']`, so signing in with GitHub on an email an existing account already owns links the GitHub account to that user rather than creating a second, pending one. GitHub reports verified emails, and admin-created accounts are exactly what this rescues: a student whose admin-created email matches their GitHub email ends up with one identity, not two.
- Implicit linking also requires the existing local account to be email-verified, and Better Auth creates credential accounts with `emailVerified: false`, which would make the rescue fail with an account-not-linked error. The deployment's policy is that an admin entering an email is the attestation: the admin create path and the bootstrap-admin seed set `emailVerified: true`, and a one-time startup migration marks existing credential accounts verified so accounts created before this step also qualify.
- `allowDifferentEmails: true`, so an already signed-in user can explicitly link a GitHub account whose email differs from their account email. The explicit flow runs from an authenticated session and proves control of both sides, which is why the mismatch is acceptable there while implicit linking at sign-in still requires a matching verified email.
- One GitHub account per user. Better Auth would happily link a second GitHub account to the same user, which would leave the stored handle below ambiguous and let an unlink of one account clear or misattribute it. A before-link check refuses a second GitHub connection, so the handle always names the single connected account and the profile UI stays one connect or disconnect row.
- `allowUnlinkingAll` stays at its default of off. Better Auth refuses to unlink the last remaining sign-in method, so a GitHub-created user with no password cannot lock themselves out, and the UI mirrors the same rule.

Linking never touches `role`. An approved student who later connects GitHub stays `normal`, and a GitHub sign-in that implicit linking attaches to an admin-created account inherits that account's existing status, because `defaultRole: 'pending'` only applies when a new user row is created.

## Capturing the GitHub username

Better Auth stores the provider's numeric account id, not the handle, and its own profile sync cannot carry this field: additional fields declared `input: false` are filtered out of provider-profile data during both sign-up and link synchronization, and declaring the field client-writable instead would let any user claim any handle. So the handle is written server-side. `githubUsername` is declared under `user.additionalFields` as an optional string with `input: false`, and a hook on the GitHub OAuth callback writes the profile's `login` through an internal adapter update, which bypasses the input filter while every client-facing path stays read-only. The hook runs when a GitHub account is linked and again on every GitHub OAuth sign-in, so a renamed GitHub handle is stale only until that user next signs in with GitHub, and unlinking clears the field so a stale handle never outlives the connection. The handle is a snapshot, never a per-request GitHub API call.

Name and avatar deliberately follow different rules. A user created by a GitHub sign-up gets their GitHub name and avatar once at creation, Better Auth's default, because GitHub registration is a supported path and those users have no admin-curated identity to protect. Linking GitHub to an existing account copies neither: `updateUserInfoOnLink` stays off, since it would also write the provider's name and silently rename an admin-curated account across the roster, leaderboards, and recordings. Only the handle crosses over on link.

`GET /api/me` carries the new `github_username` beside the existing `image`. `backend/src/auth/users.ts` broadens the directory from [step 4](4-admin-users-page.md) with a `profilesFor(ids)` read that returns the display name and the optional GitHub username together; `namesFor` remains for the many callers that only need names.

## Where the identity shows

- The profile page gains a connected-accounts section, rendered only when the deployment configures GitHub OAuth (the `github_auth` capability flag from `/api/config`): the linked GitHub username as a link to the GitHub profile, a connect button that calls `authClient.linkSocial({ provider: 'github', callbackURL: '/profile' })`, and a disconnect action over `authClient.unlinkAccount` that is disabled when GitHub is the only sign-in method. The linked state comes from `authClient.listAccounts()`.
- The account menu and the profile header render the avatar from the existing `image` field with an initial-letter fallback. In practice only GitHub-created users carry an image, because linking does not copy the avatar, so an admin-created account keeps the letter fallback. The avatar becomes a design-system primitive and its variants go on the dev-only `/styleguide` route.
- The agent profile page links the owner to `https://github.com/<username>` when `GET /api/environments/:envId/agents/:ownerId` carries the new optional `owner_github`, resolved through `profilesFor`. Only the agent profile payload carries the handle: leaderboard rows, recordings, and live-session payloads stay name-only, so blind rating and the recording masking from step 4 are untouched.

## Out of scope

Verifying that a submitted repository belongs to the submitter's GitHub account stays out. The specification does not require it, and forks, collaborators, and organization repos make it a policy question for the owner rather than a lookup, so it is raised separately instead of quietly added here. Webhooks, organization-membership gates, and a GitHub App are also out. `GITHUB_TOKEN` remains the operator-only submissions credential from [submission.md](../../docs/specs/submission.md), unrelated to any user's OAuth identity.

## Docs

The Identity and access section of [frontend.md](../../docs/specs/frontend.md) moves with this plan, as it did for the rest of the stage: one account per person with linking rather than duplicates, admin-entered emails counting as verified, one GitHub connection per user, the explicit connect and disconnect flow, the last-method safeguard, name and avatar coming from GitHub only at GitHub sign-up, and the agent-profile GitHub link. [backend.md](../../docs/contributors/backend.md) adds the username capture and `profilesFor` to the identity section. [configuration.md](../../docs/contributors/configuration.md) needs no new variables; its GitHub OAuth note states that the same OAuth app powers both sign-in and account linking.

## Implementation decisions

- **Implicit linking is limited to the trusted GitHub provider on a matching verified email, and an admin entering an email counts as verification.** That is the duplicate-account rescue. Every other combination goes through the explicit, session-authenticated connect flow.
- **The handle is written by a server-side hook, snapshotted, not fetched.** Better Auth's profile sync filters non-client-writable additional fields, so the hook writes the handle directly at link time and on every GitHub sign-in. No request-time GitHub API calls, and no client path can set or spoof the field.
- **One GitHub connection per user.** A before-link check refuses a second GitHub account, which is what keeps a single user-level handle truthful through link and unlink.
- **Name and avatar sync only at GitHub sign-up, never at link.** GitHub-created users get both once at creation; linking writes only the handle, so admin-curated display names and existing identities are never rewritten by a link.
- **Only the agent profile exposes the handle publicly.** Submissions are public GitHub repos already, so the owner's handle on their agent page reveals nothing new, but it stays off every payload the blind-rating rules touch.

## Tests

- Backend, Vitest on `:memory:`: the linking configuration flags; `emailVerified: true` on the admin create path and the bootstrap seed, and the startup migration marking existing credential accounts verified, idempotently; the before-link refusal of a second GitHub account; the callback hook writing the handle on link and on a later GitHub sign-in, leaving `name` and `image` untouched on link, and clearing the handle on unlink; `profilesFor` returning names and handles with the missing-handle fallback; the reshaped `/api/me`; and `owner_github` on the agent profile payload and its absence from board, recording, and session payloads.
- Frontend, Vitest under jsdom with `authClient` mocked: the connected-accounts section links and unlinks and refreshes, the disconnect action is disabled for a sole sign-in method, the section is absent without `github_auth`, the avatar renders with its fallback, and the agent profile shows the GitHub link exactly when the payload carries the handle.
- Browser end-to-end: no new journey, because GitHub OAuth depends on the external identity provider, consistent with the stance [step 5](5-testing-ci-and-docs.md) took for the sign-in button. Existing Playwright assertions that touch the profile page or account menu markup are revised in the same change, and the manual checklist gains the link and unlink flow.

## Done when

A GitHub sign-in whose verified email matches an admin-created account signs into that account, keeping its status and its admin-curated display name, instead of creating a pending duplicate. A signed-in user connects a GitHub account with a different email from the profile page, sees their GitHub username there and in the account menu, and disconnects it again, while disconnecting the only sign-in method is refused and connecting a second GitHub account is refused. A GitHub-created user carries the GitHub name and avatar from sign-up, and a renamed GitHub handle updates on that user's next GitHub sign-in. An agent profile links to its owner's GitHub profile, and no board, recording, or session payload carries the handle. The specification and contributor docs describe the linking model.
