# Stage 4: Testing, CI Wiring, and Docs

Status: complete.

Part of [Stage 4](../stage-04-frontend-core.md). The exit criteria are executable, split by what they need: frontend unit tests in jsdom with no canvas and no network, backend unit tests for the allowlist and retention on the existing in-memory setup, and a browser end-to-end suite for the criteria that only mean something with a real renderer over a real session.

## Frontend unit tests (Vitest, jsdom, no backend)

jsdom implements no canvas rasterization, and pulling in a native canvas package just for tests is a Windows-CI tax not worth paying. The renderer's scene/paint split in [flappy-bird-renderer.md](flappy-bird-renderer.md) exists partly for this: everything with logic in it is testable as plain functions, and actual pixels are the end-to-end suite's job. (Implementation note: the project moved to Vue, so the component-shaped suites use `@testing-library/vue`, not React.) Suites:

- **Scene computation**: states from a checked-in Stage 2 determinism fixture produce scenes with the bird, every pipe, and the HUD values in the right places; the purity property — states fed in shuffled order yield scenes identical to in-order, which is what the scrubber relies on.
- **Input mapping**: keydown (and not key repeat), pointerdown, and touchstart each send exactly one `input` envelope with slot and flap action through a stubbed `sendAction`; no listeners attach when `controlledSlots` is empty or `sendAction` is absent.
- **Socket client**: frame classification against the shared rule, command serialization, the attach replay (header, latest state, status) driving callbacks in order, reconnect after a drop.
- **Replay transport**: play advances on the pace interval (fake timers), pause stops, step moves one state, scrub renders the state under the index, `?t=` seeks on load, an unknown `schema_version` shows the needs-newer-viewer message.
- **Pages and identity**: home cards render the metadata fields; environment-page entry points hidden when `/api/me` (mocked fetch) says not allowlisted; the start form sends `human_slot_timeout_ms` when overridden (the override exit criterion's frontend half); the 409 rejoin path navigates to the active session.

## Backend unit tests (Vitest, FakeDriver, `:memory:`)

Extending the Stage 3 suites on the same fixtures — no Docker:

- **Identity and allowlist**: `resolveUserId` takes the WS `user` query parameter when the header is absent; `GET /api/me` reports the resolved user and allowlist membership; `POST /api/sessions` is 403 for a non-allowlisted header identity in both modes, while the same identity can list sessions, fetch recordings, and attach as a spectator.
- **Retention**: finalize writes the recordings row; the migration backfills from `sessions`; the sweep evicts an unpinned recording past the window, evicts oldest-unpinned-first over quota, never evicts pinned, and ignores rowless directories; deletion removes directory and row and tolerates a missing half; the listing merges rows with headers and filters on `?env=`.
- **Pinning**: pin and unpin flip the flag owner-only; pinning is refused with `pinned_quota` at the pinned cap; a pinned recording survives a sweep that evicts its unpinned neighbors — the exit criterion verbatim.
- **Start route**: the 409 body carries the active session id.

## End-to-end tests (Playwright, Docker required)

Confirmed implementation: Playwright drives Chromium against the real backend (Docker daemon required, same gate as `backend-integration`) with the backend serving the built frontend from one origin. The Playwright config starts two backend instances, one allowlisting `dev-user` and one allowlisting no one, so the allowlist variation has a non-allowlisted context. This is the executable form of the stage's experiential criteria, one scripted journey plus the variations:

- **The main journey**: the auto-logged mock user lands on home, opens the Flappy Bird environment page, starts a play session, sees the canvas drawing states and the per-step input window in the play UI, flaps with the keyboard and sees the score change, pauses and resumes (the paused overlay appears and clears), stops the session, and from the end card opens the replay URL, scrubs it, and pins it.
- **Watch**: a scripted session streams the built-in agent's run into the same renderer with no input controls.
- **Spectator**: a second browser context opening the session URL sees states but no controls.
- **Allowlist**: a context with a non-allowlisted `VITE_SANDBOX_USER` sees no play entry points, and a direct start request is rejected.

Pixel-level rendering assertions stay out: the e2e suite asserts the canvas is painted and the DOM facts around it (score text, banners, controls), not screenshots, so the suite does not flake on font or GPU differences across runners.

## CI wiring

The frontend rides the existing workspace-wide jobs with no YAML change: `check:ts` (tsc plus Biome through the root config) and `test:ts` pick up the new package, and the schema-package moves from [frontend-infrastructure.md](frontend-infrastructure.md) keep their existing tests green as the refactor gate. `scripts/ci.py` has a `frontend-e2e` job that builds the frontend, builds the session base image, installs Playwright's Chromium, and runs the gated suite. It is wired in `ci.yml` as a new `ubuntu-latest` job alongside `backend-integration`, with the same local story: it needs Docker Desktop and is runnable directly. The `generated-code-fresh` job stayed untouched because playtesting kept `pace_interval_ms` unchanged.

## Docs

Contributor docs live under `docs/contributors/`. `docs/contributors/frontend.md` covers package layout, how to run the dev server against a local backend, the mock identity and how to act as another user, the renderer contract and registry, how to add a renderer for a new environment, and the replay viewer's transport. `docs/contributors/backend.md` covers the new configuration (`SESSION_ALLOWLIST`, the retention variables, `FRONTEND_DIST`), `GET /api/me`, the recordings table, and the retention sweep. `docs/contributors/execution.md` covers the WS `user` query parameter in the protocol section. `docs/contributors/test.md` covers the `frontend-e2e` job. Student pages stayed untouched: nothing participant-facing changes until submissions arrive in Stage 5.
