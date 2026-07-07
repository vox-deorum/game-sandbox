# Stage 12.5: Testing, CI, and docs

Status: not started

Part of [Stage 12](../stage-12-user-system.md). This is the cross-cutting companion to steps 1 through 4, mirroring the role [Stage 6.8](../stage-06/8-testing-ci-and-docs.md) played for that stage: the whole-stage coverage picture, the browser journeys, the CI wiring, and the documentation pass that removes the allowlists from the record. Per-step tests live in each subplan; this file states how the layers fit and closes the stage.

## Test layers

Docker-free backend, Vitest on `:memory:`. Step 1 covers the auth mount, the schema-migration idempotency, the seed resync, the config validation, and the harness `TestUsers`. Step 2 covers status derivation, the full authorization matrix, `/api/me`, cookie-authenticated WebSocket upgrades, ban revocation, and admin gating. Step 4 covers the `UserDirectory` and the display-name payloads. Every existing suite runs on real sessions once step 2 migrates them, and that migration is itself the regression net for attribution: the rows carry Better Auth ids, the one-concurrent-session rule holds, owner-only pin and stop hold, and the own-agent rating exclusion holds.

Docker-gated integration. The existing lane's `stack.ts` gains the auth wiring, the shared `:memory:` handle and the seeded users, and the live-session and submission end-to-end paths authenticate with the session cookie on fetches and on the `ws` upgrade.

Docker-free frontend, Vitest under jsdom. Step 3 covers the login page, the me reshape, the pending banner, the signed-out shell, the 401 bounce, and the cookie-only requests. Step 4 covers the roster page.

Browser end-to-end, Playwright, run with `uv run python scripts/ci.py frontend-e2e`, which needs a running Docker daemon. Three new journeys:

1. Sign in as the seeded default admin, see the admin navigation, and sign out.
2. An admin creates a user, and that user signs in and starts able to participate, because the create dialog gives them role `user`, and plays a session.
3. A pending user sees the banner and the disabled start controls; an admin approves them on the Users page; the pending user reloads (the SPA fetches `/api/me` once at load, so approval reaches an already-open tab only on the next navigation) and the controls unlock.

The e2e backend runs with the default `ADMIN_EMAIL` and `ADMIN_PASSWORD` seed so the credentials are deterministic. GitHub OAuth is not exercised in e2e, because it depends on an external identity provider; it is covered by the unit tests of the button wiring in step 3 plus a manual checklist item.

The existing `frontend/e2e/allowlist.spec.ts`, which asserts a `403 not_allowlisted` on a session start, is deleted with the allowlist; the pending-approval journey above subsumes its intent.

## CI

No new lanes. The Docker-free suites run where they run today, the integration lane inherits the auth-aware stack, and the lint and type gates, `npm run check` on both workspaces, cover the new `auth/` modules and the new pages. One audit item: remove `SESSION_ALLOWLIST` and `OPERATOR_ALLOWLIST` from any CI environment plumbing.

## Docs

The specification is the higher authority and moves in the same change set. Rewrite the Identity section of [frontend.md](../../docs/specs/frontend.md) from its GitHub-OAuth-only description to the Better Auth model: the two sign-in methods, no self-registration, the three role statuses and what each may do plus the standalone ban, the pending-by-default GitHub sign-ups, and the admin roster, keeping the existing rule that the backend derives identity from the authenticated session and never from the request body. Fold any surviving allowlist phrasing (in this spec or the others) into the status model rather than assuming a specific line.

The contributor docs follow. In [configuration.md](../../docs/contributors/configuration.md), drop the two allowlist rows, add the server and session auth rows (`AUTH_SECRET`, `PUBLIC_ORIGIN`, `AUTH_TRUSTED_ORIGINS`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`, and the two `GITHUB_OAUTH_*` variables), and add a deployment note: set the secret and the admin password, register the GitHub OAuth callback URL `<PUBLIC_ORIGIN>/api/auth/callback/github`, note that `GITHUB_TOKEN` stays a submissions-only credential distinct from the OAuth app, and note that `sandbox.db` now also holds the Better Auth tables. In [backend.md](../../docs/contributors/backend.md), replace the development-identity and authorization section with the session-lookup seam, `deriveStatus`, the guard trio, and the statuses, update the `src/identity.ts` row in the module table, and delete the `?user=` download note.

The plans follow too. Add the Stage 12 row to the [plans README](../README.md) stage table, and keep this stage's files current as decisions move, per the plan governance.

Run the strict documentation build with `uv run python scripts/ci.py docs` before finishing.

## Done when

Both `npm run check` gates and all Docker-free suites are green, the integration lane passes with cookie auth, and the three Playwright journeys pass. A grep finds no `SESSION_ALLOWLIST`, `OPERATOR_ALLOWLIST`, `x-sandbox-user`, or `not_allowlisted` anywhere in code, tests, docs, or CI. The specification and contributor docs describe the Better Auth model, and the Stage 12 parent's "Done when" is demonstrable end to end.
