# Stage 4: Frontend Core

Status: complete. All build-order steps are implemented and unit-tested: the frontend infrastructure (the `frontend/` package, the shared wire types in the schema package, the API and socket clients, the mock identity with `GET /api/me` and the allowlist gate, the renderer contract and registry, the Home and Environment pages); the Flappy Bird renderer (the scene/paint split, the in-game HUD, raw input over the socket); live-session control (the session host, the start form, the active-timeout display, pause/resume, the end-of-session card); replay and retention (the replay viewer with play/pause/step/scrub and `?t=` deep links, the backend `recordings` table with migration backfill, the eviction sweep, and pinning); and the testing/CI/docs step (backend retention/pinning suites, frontend scene/input/transport/session/replay suites, the `frontend-e2e` Playwright job wired into `ci.py` and `ci.yml`, and the contributor docs). Two implementation notes that diverged from the sub-documents are recorded in those files: the replay viewer parses recordings with a dependency-free browser parser (the schema package's Ajv reader is Node-only) reading the supported version from a new `@game-sandbox/schema/version` subpath; and the component test library is `@testing-library/vue` (the project moved to Vue after these documents were first written).

## Goal

A person opens the site, is signed in automatically as the mock development user, browses environments, plays Flappy Bird live in the browser, and watches any recording in the replay viewer. This is the first stage a non-developer can experience. GitHub OAuth is deliberately out of this stage (see Deferred work); identity stays the Stage 3 stub with one auto-logged-on mock user, shaped so OAuth later replaces the resolution without touching anything built here.

## Plan documents

The detailed design lives under [stage-04/](stage-04/), in build order:

- [frontend-infrastructure.md](stage-04/frontend-infrastructure.md): the `frontend/` package and tooling, the shared wire types hoisted into the schema package, the API and WebSocket clients, the mock auto-logon identity with the backend allowlist gate and `GET /api/me`, the renderer contract and registry, the Home and Environment pages.
- [flappy-bird-renderer.md](stage-04/flappy-bird-renderer.md): the Flappy Bird renderer module — the game world from the overlay fields, the in-game UI, raw device input as actions over the WebSocket, and the scene/paint split that keeps it testable and replay-pure.
- [live-session-control.md](stage-04/live-session-control.md): the play and watch start flows, the session page hosting a renderer over the live socket, the human-slot timeout control and display, pause/resume, and the end-of-session card.
- [replay-and-retention.md](stage-04/replay-and-retention.md): the replay viewer (load by URL, play, pause, step, scrub), the recordings retention metadata and eviction sweep in the backend, pinning, and the feedback stub.
- [testing-ci-and-docs.md](stage-04/testing-ci-and-docs.md): the test suites that encode the exit criteria, the browser end-to-end job, CI wiring, the docs pages.

## Scope

Stand up the web app in `frontend/`. Confirmed at stage start: Vue 3 with Vite, TypeScript throughout, types imported from the Stage 1 generated schema types, and a renderer architecture where each environment registers a module that receives per-step state objects and draws into a canvas or DOM region, per [interaction.md](../specs/interaction.md). The wire shapes the browser shares with the backend (environment metadata, command envelopes, the line-classification rule) move into the schema package so there is one declaration, not a mirror. The backend serves the built bundle from the same origin through `@fastify/static`, so one command (`npm start` at the repo root) builds the frontend and launches the whole stack.

Identity is the mock auto-logon: the frontend signs everyone in as a single development user (the Stage 3 stub's `dev-user`, overridable for testing), shows it in the chrome, and sends it on every request; the backend's stub resolution grows a WebSocket-compatible source but remains the one place identity is decided. The operator-configured allowlist that gates starting live sessions is implemented now, keyed on that stub identity, with `GET /api/me` telling the frontend what the user may do.

Build the pages that make sense before submissions exist: Home with environment cards driven by the public metadata, and the Environment page with description and entry points into play and watch (leaderboards and the submission form join in Stages 5 and 6).

Write the Flappy Bird renderer: the game world from the state object's overlay fields plus the game UI (score, tick, status) so it reads as a game rather than a debugger view. Wire raw device input (key, click, touch) through the WebSocket as actions. The same renderer module must run from a stored recording without code changes, since live play and replay share renderers by design.

Add the live-session control for the human-slot timeout from [interaction.md](../specs/interaction.md). Default it from the environment metadata, send the resolved value when starting a session, and show the active timeout in the play UI when it can affect the session. For Flappy Bird (a paced environment) this deadline is the per-step noop window; the same control becomes the move clock for a later turn-based environment, with no second mechanism. Also add the play UI's pause control: pausing a live session freezes the pace cadence and the decision clock together until resume, per [interaction.md](../specs/interaction.md). For single-slot Flappy Bird this is a plain pause; the control is wired through the session so it generalizes to later environments.

Build the replay viewer per [recording.md](../specs/recording.md): load a recording by URL, play, pause, step, and scrub. Implement the retention policy from the same spec in the backend: a deployment-configured window (30 days default), a per-user quota, oldest-unpinned-first eviction, and pinning at the end of a session. The post-session feedback prompt appears here but ratings storage lands in Stage 6; until then it is a stub that only offers pinning.

## Spec references

[frontend.md](../specs/frontend.md) (pages, flows, on-demand play; the identity section's GitHub OAuth is deferred, see below), [interaction.md](../specs/interaction.md) (renderer contract, input), [recording.md](../specs/recording.md) (replay, retention, pinning).

## Depends on

Stage 3 (backend API, WebSocket protocol, recordings on disk).

## Deferred work

GitHub OAuth — and with it everything in [frontend.md](../specs/frontend.md) that needs a real GitHub identity (sign-in, an allowlist naming real handles or an org, attribution that means anything outside a deployment's own data) — is deferred out of this stage as future work, not reassigned to a later numbered stage. The spec remains the statement of intent. What this stage builds is the seam OAuth drops into: one identity resolution function in the backend, one identity module and one `/api/me` in the frontend, and the single-username identifier shape used everywhere, so landing OAuth later is a replacement of those pieces, not a refactor of their callers. Until then every deployment is effectively single-user (the mock auto-logon), and later stages that attribute work to users (submissions in Stage 5 onward) key on the same seam.

## Done when

The auto-logged-on mock user starts a Flappy Bird session from the environment page, plays it with the keyboard, sees the active per-step input window in the play UI, pauses and resumes it, and after the session ends opens the replay from a shareable URL and scrubs through it. Starting a session with an overridden timeout sends that value to the backend. A non-allowlisted identity (through the Stage 3 header stub) cannot start a session in either mode but can list and fetch recordings and watch a replay, and the frontend hides the start entry points for it. Eviction removes the oldest unpinned recording when a test user exceeds the quota, and a pinned recording survives.

## Build order

1. Frontend infrastructure: the package and tooling, the schema-package type moves, the API and socket clients, the mock identity with `GET /api/me` and the allowlist gate, the renderer contract and registry, the Home and Environment pages.
2. The Flappy Bird renderer over the contract from 1. The backend pieces of 4 (retention, pinning) only need 1's identity work and can proceed in parallel with 2 and 3.
3. Live session control: the start flows, the session page, the timeout control, pause. Needs 1 and 2 for a playable page.
4. Replay and retention: the viewer over the same renderer, the recordings table and sweep, pinning, the feedback stub. The viewer needs 2; the backend half only needs 1.
5. Testing, CI, and docs: unit suites land with their features; the end-to-end suite and the `frontend-e2e` job close the stage.
6. Keep this file and the stage-04 documents in sync with whatever the implementation confirms or changes, per the [plan rules](README.md).

## Open questions

Resolved during this stage:

- Flappy Bird's `pace_interval_ms` (50 ms, 20 steps/second) was flagged in Stage 2 for tuning with the real renderer. Playtesting confirmed it reads well as a game at 50 ms, so it is **kept unchanged**; the Stage 2 metadata and the regenerated `environments.json` are untouched.
- The Stage 3 idle-timeout default (`SESSION_IDLE_TIMEOUT_MS`, 60 s) and its definition (no attached socket, or in human mode no inbound command) were left tunable for this stage's playtesting. They are **confirmed unchanged**; a paused-and-forgotten session still idles out and the UI presents `idle_timeout` as a normal outcome.
- The end-to-end framework is **Playwright** (Chromium), confirmed and implemented as the Docker-gated `frontend-e2e` job per [stage-04/testing-ci-and-docs.md](stage-04/testing-ci-and-docs.md).
