# Stage 12.5: Testing, CI, and docs

Status: complete. The browser suite moved off the `x-sandbox-user` header to Better Auth cookie sessions through a per-persona `APIRequestContext` model in `frontend/e2e/support/`: an `admin` fixture signed in as the seeded bootstrap admin, an `as(handle)` factory that creates a member through the roster endpoint and signs in as it, and `authenticateBrowser`, which copies a context's session cookie onto a browser context. The `restricted` server and `allowlist.spec.ts` are gone (the pending-approval journey subsumes them), so `playwright.config.ts` runs one server. Two follow-through details the migration surfaced, beyond the plan as written: a submitted agent's public identity is now its opaque Better Auth id, so a profile navigation resolves it through `userIdOf` rather than reusing the handle (which is only the display name now); and the leaderboards arc's in-browser rating matches the watch-row action button by either label (`Rate` when unrated, `Watch again` when rated), because the operator is no longer one of the judges and so has not pre-rated the agent. Five contributor docs beyond the three the plan names (`e2e-tests.md`, `development-setup.md`, `test.md`, `index.md`, `execution.md`) also described the removed allowlist model and were folded into the status model. Verified: both `npm run check` gates, all Docker-free suites, the Docker integration lane, and all twenty Playwright tests (including the three new journeys) pass, and the forbidden-token grep is clean across code, tests, docs, and CI.

Part of [Stage 12](../stage-12-user-system.md). This is the cross-cutting companion to steps 1 through 4, mirroring the role [Stage 6.8](../stage-06/8-testing-ci-and-docs.md) played for that stage: the whole-stage coverage picture, the browser journeys, the CI wiring, and the documentation pass that removes the allowlists from the record. Per-step tests live in each subplan; this file states how the layers fit and closes the stage.

## Test layers

Docker-free backend, Vitest on `:memory:`. Step 1 covers the auth mount, the schema-migration idempotency, the seed resync, the config validation, and the harness `TestUsers`. Step 2 covers status derivation, the full authorization matrix, `/api/me`, cookie-authenticated WebSocket upgrades, ban revocation, and admin gating. Step 4 covers the `UserDirectory` and the display-name payloads. Every existing suite runs on real sessions once step 2 migrates them, and that migration is itself the regression net for attribution: the rows carry Better Auth ids, the one-concurrent-session rule holds, owner-only pin and stop hold, and the own-agent rating exclusion holds.

Docker-gated integration. The existing lane's `stack.ts` gains the auth wiring, the shared `:memory:` handle and the seeded users, and the live-session and submission end-to-end paths authenticate with the session cookie on fetches and on the `ws` upgrade.

Docker-free frontend, Vitest under jsdom. Step 3 covers the login page, the me reshape, the pending banner, the signed-out shell, the 401 bounce, and the cookie-only requests. Step 4 covers the roster page.

Browser end-to-end, Playwright, run with `uv run python scripts/ci.py frontend-e2e`, which needs a running Docker daemon. Three new journeys:

1. Sign in as the seeded default admin, see the admin navigation, and sign out.
2. An admin creates a user, and that user signs in and starts able to participate, because the create dialog gives them role `user`, and plays a session.
3. A pending user sees the banner and the disabled start controls; an admin approves them on the Users page; the pending user reloads (the SPA fetches `/api/me` once at load, so approval reaches an already-open tab only on the next navigation) and the controls unlock.

The e2e backend uses a loopback `PUBLIC_ORIGIN`, explicitly enables insecure development defaults so its `ADMIN_EMAIL` and `ADMIN_PASSWORD` are deterministic, and binds its listener to loopback. No production or general integration lane inherits that opt-in. GitHub OAuth is not exercised in e2e, because it depends on an external identity provider; it is covered by the unit tests of the button wiring in step 3 plus a manual checklist item.

The existing `frontend/e2e/allowlist.spec.ts`, which asserts a `403 not_allowlisted` on a session start, is deleted with the allowlist; the pending-approval journey above subsumes its intent.

## Demo launcher and fixture accounts

The demo workflow migrates with the authentication boundary rather than retaining a privileged development identity path. The e2e fixture creates the bootstrap admin and the data-rich `ada-lovelace` member as real Better Auth accounts with deterministic, development-only email and password credentials; the copied demo database therefore includes their auth rows alongside the application data.

`scripts/demo.py` removes `VITE_SANDBOX_USER`, `SESSION_ALLOWLIST`, and `OPERATOR_ALLOWLIST` from the frontend build and backend environment. Both `npm run demo` and `npm run demo:user` use the explicitly opted-in loopback auth configuration from step 1 and start at the real `/login` flow. The default command prints the bootstrap-admin development credentials, while `demo:user` prints Ada's member credentials; recreating the demo database invalidates cookies from a previous run, so the selected persona is reached through a real sign-in rather than a stale browser session or fabricated header. The command help and contributor documentation state that distinction plainly.

`scripts/tests/test_demo.py` follows the new contract: neither mode emits a removed identity or allowlist variable, both use loopback-only insecure auth, the selected credential hint names an account the e2e fixture creates, and the ordinary member remains role `user` while the bootstrap account is role `admin`. The demo's stale-schema rebuild path copies the Better Auth tables and still retries cleanly.

## CI

No new lanes. The Docker-free suites run where they run today, the integration lane inherits the auth-aware stack, and the lint and type gates, `npm run check` on both workspaces, cover the new `auth/` modules and the new pages. Remove `SESSION_ALLOWLIST`, `OPERATOR_ALLOWLIST`, and `VITE_SANDBOX_USER` from CI, e2e, and demo environment plumbing.

## Docs

The specification is the higher authority and its [Identity and access](../../docs/specs/frontend.md#identity-and-access) section moves with the Stage 12 plan rather than waiting for implementation. During this step, verify that the implemented behavior still matches its two sign-in methods, lack of public registration and deletion, three statuses, standalone ban, pending-by-default GitHub users, admin roster, stable bootstrap admin, and display-name rules. Fold any surviving allowlist phrasing in the other specifications into the status model rather than assuming a specific line.

The contributor docs follow. In [configuration.md](../../docs/contributors/configuration.md), drop the two allowlist rows, add the server and session auth rows (`AUTH_SECRET`, `PUBLIC_ORIGIN`, `AUTH_TRUSTED_ORIGINS`, `AUTH_ALLOW_INSECURE_DEFAULTS`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`, and the two `GITHUB_OAUTH_*` variables), and add a deployment note: set the secret and bootstrap credentials, never enable insecure defaults outside loopback development, register the GitHub OAuth callback URL `<PUBLIC_ORIGIN>/api/auth/callback/github`, note that `GITHUB_TOKEN` stays a submissions-only credential distinct from the OAuth app, and note that `sandbox.db` now also holds the Better Auth tables. In [backend.md](../../docs/contributors/backend.md), replace the development-identity and authorization section with the session-lookup seam, `deriveStatus`, the guard trio, and the statuses, update the `src/identity.ts` row in the module table, and delete the `?user=` download note.

The plans follow too. Add the Stage 12 row to the [plans README](../README.md) stage table, and keep this stage's files current as decisions move, per the plan governance.

Run the strict documentation build with `uv run python scripts/ci.py docs` before finishing.

## Done when

Both `npm run check` gates and all Docker-free suites are green, the integration lane passes with cookie auth, and the three Playwright journeys pass. `npm run demo` and `npm run demo:user` reach their admin and member personas through real email and password sessions against the copied fixture database. A grep finds no `SESSION_ALLOWLIST`, `OPERATOR_ALLOWLIST`, `VITE_SANDBOX_USER`, `x-sandbox-user`, or `not_allowlisted` anywhere in code, tests, docs, or CI. The specification and contributor docs describe the Better Auth model, and the Stage 12 parent's "Done when" is demonstrable end to end.
