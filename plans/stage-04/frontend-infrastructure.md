# Stage 4: Frontend Infrastructure

Part of [Stage 4](../stage-04-frontend-core.md). This file stands up the `frontend/` package: tooling, the shared wire types, the API and WebSocket clients, the mock identity with its backend allowlist gate, the renderer module contract, and the Home and Environment pages. The Flappy Bird renderer, the live-session page, and the replay viewer build on these pieces in the other stage-04 documents. GitHub OAuth is deliberately absent — see the parent file's deferred-work section; everything here is shaped so OAuth later replaces the identity resolution without touching callers.

## Package and tooling

`frontend/` joins the npm workspace (added to the root `package.json` `workspaces` array) as `@game-sandbox/frontend`, private, `type: module`, on the root's Node 22 engines pin. Confirming the parent file's proposed defaults at stage start: Vite with the React plugin (`@vitejs/plugin-react`), React 19, TypeScript throughout, and `react-router` 7 in plain library mode for client routing. Vite is pinned to the 5.x already present in the workspace (Vitest's own dependency) rather than pulling a second major; the React plugin's 4.x line supports it. No state-management library: React hooks plus small explicit stores (the live socket and the replay transport in the other documents are plain classes with subscribe hooks); adding a library later is a contained change. Tooling mirrors `backend/`: Biome through the root config, strict `tsc --noEmit` as the check (these two are the `check` script), Vitest in jsdom for tests (suite design in [testing-ci-and-docs.md](testing-ci-and-docs.md)). The production build (`frontend/dist/`) is git-ignored.

`npm run dev` is the Vite dev server with `/api` proxied — HTTP and WebSocket (`ws: true`) — to the backend on port 8080, so the browser sees one origin and no CORS configuration exists anywhere. Serving the built bundle from the backend is a deployment concern deferred exactly like the backend's own `dist/` build; nothing in the layout prevents adding `@fastify/static` later.

Module layout (the other stage-04 documents fill in `renderers/flappy-bird/`, `pages/session/`, and `pages/replay/`):

```
frontend/src/
  main.tsx         entrypoint: router, app shell (header with site name and the signed-in user)
  identity.ts      the mock auto-logon: /api/me fetch, the identity header, the WS user param
  api/             typed fetch wrappers per backend route; the session WebSocket client
  renderers/       the renderer contract, the registry, and one module per environment
  pages/           home, environment, session (live play/watch), replay
```

## Shared wire types

The frontend must speak the same wire contract as the backend, from one declaration. `@game-sandbox/schema` already carries hand-written runtime helpers alongside the generated state types (`parseHeader`/`readRecording` live there now, imported by `backend/src/recordings.ts`), so the two backend modules whose shapes the browser needs move there rather than being mirrored:

- The `EnvironmentMeta` interface and its validation guard from `backend/src/environments.ts` (the `EnvironmentRegistry` and the generated-JSON loading stay in the backend).
- The envelope types and the line-classification rule from `backend/src/protocol/index.ts`: the `Command` union, `classifyOutbound`, `parseCommand`, `serializeCommand`, and the `session` envelope shape (the relay itself stays in the backend).

Backend imports update to the new home with no behavior change, and the existing tests, including the schema-guard test that keeps the classification rule from rotting, ride along (the protocol and schema-guard suites now live in the schema package's Vitest suite). After the move the frontend contains no hand-maintained copy of any wire shape: states and headers come from the generated types, envelopes and metadata from the shared modules.

One implementation detail the move surfaced: the schema package's barrel (`src/index.ts`) eagerly constructs Ajv and reads the schema files with `node:fs` at import time, which cannot run in a browser. So the two new modules are dependency-free (`src/protocol.ts`, `src/environment.ts`) and the package exposes them as subpath exports (`@game-sandbox/schema/protocol`, `@game-sandbox/schema/environment`). The frontend imports the runtime helpers (`classifyOutbound`, `parseCommand`, `serializeCommand`, `isEnvironmentMeta`) from those subpaths and the pure types (`RecordingHeader`, `StepState`) from the barrel with `import type`, which the bundler erases, so the Ajv-backed readers never reach the bundle. The barrel still re-exports both modules for the Node backend, which already loads Ajv. A `vite build` of the frontend confirms the bundle pulls in neither Ajv nor `node:fs`.

## API client and the session socket

`frontend/src/api/` wraps each backend route in a typed function: `getEnvironments()`, `getMe()`, `startSession(input)`, `getSession(id)`, `stopSession(id)`, `listRecordings(filter?)`, plus the recording fetch and pin calls defined in [replay-and-retention.md](replay-and-retention.md). Every request attaches the identity header from `identity.ts`. Failures the UI must distinguish come back as typed results, not thrown strings: 403 not-allowlisted, and 409 already-active, with the backend's 409 body carrying the active session's id so the UI can offer "rejoin" instead of a dead end. Concretely, the error body grew a stable machine `code` (`not_allowlisted`, `already_active`) the client branches on, plus the `active_session_id` merged into the 409 body. On the backend this is `OrchestratorError` carrying an optional `code` and a `details` object, and `replyError` spreading both into the JSON; the start route validates the request first (400 for an unknown environment or an invalid mode), then the allowlist (403), then the one-per-user rule (409), so a malformed start is still a 400 regardless of identity.

The session socket client owns the WebSocket to `/api/sessions/:id/ws`: it classifies each incoming frame with the shared rule (header and state lines versus `result`/`session`/`pause`/`resume` envelopes), exposes them as typed callbacks, and sends validated `Command` envelopes. Reconnection is the client's job: on an unexpected drop it reattaches, and the backend's attach behavior (buffered header, latest state, current status, per [stage-03/transport-and-live-runner.md](../stage-03/transport-and-live-runner.md)) makes resumption stateless. How the live page uses it is [live-session-control.md](live-session-control.md).

## Identity: the mock auto-logon

One mock user, signed in automatically — no login page, no logout, no session storage. `identity.ts` resolves the username once (the `VITE_SANDBOX_USER` dev override when set, otherwise `dev-user`, matching the backend stub's fallback), and the app shell fetches `GET /api/me` at startup to display "signed in as ⟨user⟩" and learn whether the user may start sessions. Every fetch carries the `x-sandbox-user` header. The browser WebSocket API cannot set headers, so the socket client appends the identity as a `user` query parameter instead, and the backend's `resolveUserId` grows that second source: header when present, else the `user` query parameter on the WS upgrade, else `dev-user` — still one function, still the only place identity is decided. When OAuth lands it replaces this resolution with a session cookie (which the browser sends on both fetch and upgrade automatically) and replaces `identity.ts` with the real session; no caller changes on either side.

New backend route: `GET /api/me` → `{user_id, allowlisted}`. It is the frontend's single source for who-am-I and what-may-I-do, so the OAuth replacement has one obvious place to land.

## The allowlist

The operator-configured allowlist from [frontend.md](../../specs/frontend.md) gates starting live sessions, keyed on the stub identity until OAuth brings real ones. `SESSION_ALLOWLIST` joins `config.ts`: a comma-separated list of user ids, defaulting to `dev-user` so a fresh checkout plays out of the box. `POST /api/sessions` returns 403 with a `not_allowlisted` code for users not on it — both modes, since starting a watch session also consumes a container. Everything read-only stays open: environments, session rows, spectating an existing session's socket, recordings, and replays. The frontend hides the play and watch entry points when `/api/me` says `allowlisted: false`; the backend check is the enforcement, the UI state is courtesy.

## The renderer contract and registry

Per [interaction.md](../../specs/interaction.md), each environment registers a frontend module that draws per-step states; live play and replay share it by design. The contract, in `renderers/types.ts`:

```ts
interface RendererContext {
  container: HTMLElement            // the region the renderer owns
  meta: EnvironmentMeta             // pace interval, slots, display name
  header: RecordingHeader           // environment, schema_version, seed
  controlledSlots: readonly string[]            // empty when spectating or replaying
  sendAction?: (slot: string, action: unknown) => void  // absent outside live human play
}
interface RendererInstance {
  render(state: StepState): void
  destroy(): void
}
interface RendererModule {
  mount(ctx: RendererContext): RendererInstance
  thumbnail: string                 // static asset URL for the home cards
}
```

Two rules give the architecture its properties. First, **purity**: `render(state)` must draw entirely from the passed state (plus the mount-time header and metadata) with no accumulated history, so the live page, the replay player, and the scrubber are all the same call with a different state source. Second, **the chrome split**: the renderer owns the game frame — world plus in-game UI (score, tick, status that belongs inside the game) — while the hosting page owns the session chrome that must work for every environment: start/stop/pause controls, the status banner, the active-timeout display, and later the feedback prompt. That split is what lets [live-session-control.md](live-session-control.md) and [replay-and-retention.md](replay-and-retention.md) build their hosts once, for all future environments.

`renderers/registry.ts` maps the metadata `renderer` key (Flappy Bird's is `"flappy-bird"`) to its module. The home-card thumbnail the spec asks for is not in the environment metadata; it comes from the registered module's `thumbnail` export, with a generic placeholder for an environment whose renderer is not registered yet — so adding an environment's visuals is one frontend module and zero metadata changes.

## Pages

Routing: `/` (home), `/environments/:envId`, `/sessions/:id` (live, in [live-session-control.md](live-session-control.md)), `/replays/:id` (in [replay-and-retention.md](replay-and-retention.md)). The app shell renders the header chrome (site name, signed-in user) around every page, and fetches `GET /api/me` once into a small context (`me.tsx`) that the header and the pages both read, so the allowlist answer is fetched in one place. The `/sessions/:id` and `/replays/:id` routes exist now as thin placeholders that those two later documents replace with the renderer host and the replay viewer; `renderers/index.ts` is the registration barrel `main.tsx` imports, where each environment's renderer module gets pulled in (empty until the Flappy Bird renderer step).

The Environment page's play and watch entry points are wired through the typed `startSession` client and navigate to the resulting `/sessions/:id`; an already-active result navigates to the existing session instead of dead-ending (the rejoin path). The richer start UX (the human-slot timeout override field, mode nuances, the in-session pause and active-timeout display) belongs to [live-session-control.md](live-session-control.md); this page provides the gated entry points and the navigation seam.

- **Home** lists environments as cards from `GET /api/environments`: display name, the short description, the slot count from `min_slots`/`max_slots`, a human-playable badge from `human_slots`, and the registry thumbnail — exactly the card fields [frontend.md](../../specs/frontend.md) names.
- **Environment page** shows the description and the entry points into play and watch (gated by `allowlisted`), plus the recent-replays list from [replay-and-retention.md](replay-and-retention.md). Leaderboards and the submission form join in Stages 5 and 6; the page renders without them rather than carrying placeholders.
