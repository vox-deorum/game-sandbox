# Stage 4: Frontend Infrastructure

Status: complete.

Part of [Stage 4](../stage-04-frontend-core.md). This file records the `frontend/` package as implemented: tooling, the shared wire types, the API and WebSocket clients, the mock identity with its backend allowlist gate, the renderer module contract, and the Home and Environment pages. The Flappy Bird renderer, the live-session page, and the replay viewer are implemented in the other stage-04 documents. GitHub OAuth is deliberately absent (see the parent file's deferred-work section); everything here is shaped so OAuth later replaces the identity resolution without touching callers.

## Package and tooling

`frontend/` is in the npm workspace (the root `package.json` `workspaces` array) as `@game-sandbox/frontend`, private, `type: module`, on the root's Node 22 engines pin. The stack, confirmed at stage start and implemented, is Vite with the Vue plugin (`@vitejs/plugin-vue`), Vue 3 (the `<script setup>` SFC style), TypeScript throughout, and `vue-router` 4 in plain library mode for client routing. Vite is pinned to the 5.x already present in the workspace (Vitest's own dependency) rather than pulling in a second major; the Vue plugin's 5.x line supports it.

There is no state-management library. State is Vue's reactivity (`ref`/`reactive`/`provide`/`inject`) plus small explicit stores: the live socket and the replay transport in the other documents are plain classes with subscribe hooks. Adding Pinia later is a contained change.

Tooling mirrors `backend/`. Biome runs through the root config, which excludes `.vue` files: Biome lints only the SFC `<script>` block and would false-flag bindings used only in the `<template>`. `vue-tsc --noEmit` is the strict type check. Biome plus `vue-tsc` are the `check` script, and Vitest runs in jsdom for tests (suite design in [testing-ci-and-docs.md](testing-ci-and-docs.md)). The production build (`frontend/dist/`) is git-ignored.

`npm run dev` is the Vite dev server with `/api` proxied: HTTP and WebSocket (`ws: true`): to the backend on port 8080, so the browser sees one origin and no CORS configuration exists anywhere. In production the backend serves the built bundle from the same origin through `@fastify/static`, with an `index.html` fallback for client-side routes so a hard refresh on `/environments/:id` loads. `npm start` at the repo root builds the frontend and launches the backend serving it, so the whole stack is one process and one command. The backend wires this only when a built bundle is present, so dev (Vite serves it) and the tests (no bundle) are untouched. The directory is configurable through `FRONTEND_DIST`.

Module layout (the other stage-04 documents fill in `renderers/flappy-bird/`, `pages/session/`, and `pages/replay/`):

```
frontend/src/
  main.ts          entrypoint: the Vue app and the vue-router routes
  App.vue          the me-provider wrapper around components/AppShell.vue (header chrome + <RouterView>)
  identity.ts      the mock auto-logon: /api/me fetch, the identity header, the WS user param
  me.ts            the provide/inject identity store: one GET /api/me shared with every page
  api/             typed fetch wrappers per backend route; the session WebSocket client
  renderers/       the renderer contract, the registry, and one module per environment
  pages/           home, environment, session (live play/watch), replay (.vue SFCs)
```

## Shared wire types

The frontend must speak the same wire contract as the backend, from one declaration. `@game-sandbox/schema` already carries hand-written runtime helpers alongside the generated state types: `parseHeader`/`readRecording` live there now, imported by `backend/src/recordings.ts`. So the two backend modules whose shapes the browser needs move there rather than being mirrored:

- The `EnvironmentMeta` interface and its validation guard from `backend/src/environments.ts` (the `EnvironmentRegistry` and the generated-JSON loading stay in the backend).
- The envelope types and the line-classification rule from `backend/src/protocol/index.ts`: the `Command` union, `classifyOutbound`, `parseCommand`, `serializeCommand`, and the `session` envelope shape (the relay itself stays in the backend).

Backend imports update to the new home with no behavior change. The existing tests ride along, including the schema-guard test that keeps the classification rule from rotting; the protocol and schema-guard suites now live in the schema package's Vitest suite. After the move the frontend contains no hand-maintained copy of any wire shape: states and headers come from the generated types, envelopes and metadata from the shared modules.

The move surfaced one implementation detail. The schema package's barrel (`src/index.ts`) eagerly constructs Ajv and reads the schema files with `node:fs` at import time, which cannot run in a browser. So the two new modules are dependency-free (`src/protocol.ts`, `src/environment.ts`), and the package exposes them as subpath exports (`@game-sandbox/schema/protocol`, `@game-sandbox/schema/environment`). The frontend imports the runtime helpers (`classifyOutbound`, `parseCommand`, `serializeCommand`, `isEnvironmentMeta`) from those subpaths, and the pure types (`RecordingHeader`, `StepState`) from the barrel with `import type`, which the bundler erases. The Ajv-backed readers therefore never reach the bundle. The barrel still re-exports both modules for the Node backend, which already loads Ajv. A `vite build` of the frontend confirms the bundle pulls in neither Ajv nor `node:fs`.

The replay step ([replay-and-retention.md](replay-and-retention.md)) added a third dependency-free subpath, `@game-sandbox/schema/version`, for the integer `SCHEMA_VERSION` the browser parser checks against. The barrel re-exports it for the Node side.

## API client and the session socket

`frontend/src/api/` wraps each backend route in a typed function: `getEnvironments()`, `getMe()`, `startSession(input)`, `getSession(id)`, `stopSession(id)`, `listRecordings(filter?)`, plus the recording fetch and pin calls defined in [replay-and-retention.md](replay-and-retention.md). Every request attaches the identity header from `identity.ts`.

Failures the UI must distinguish come back as typed results, not thrown strings: 403 not-allowlisted and 409 already-active. The backend's 409 body carries the active session's id. On `already_active`, the originating configuration modal closes and a standalone confirmation offers `[ Start new ]` and `[ Return ]`, with `[X]` in its header. Return navigates to the active session. Start new terminates the active session, waits for termination, retries the exact pending request, and navigates on success. The confirmation is locked while replacing; failures remain retryable, and another conflict needs another explicit action. Concretely, the error body grew a stable machine `code` (`not_allowlisted`, `already_active`) that the client branches on, plus the `active_session_id` merged into the 409 body. On the backend this is `OrchestratorError` carrying an optional `code` and a `details` object, with `replyError` spreading both into the JSON. The start route validates in order: the request first (400 for an unknown environment or an invalid mode), then the allowlist (403), then the one-per-user rule (409). A malformed start is therefore still a 400 regardless of identity.

The session socket client owns the WebSocket to `/api/sessions/:id/ws`. It classifies each incoming frame with the shared rule (header and state lines versus `result`/`session`/`pause`/`resume` envelopes), exposes them as typed callbacks, and sends validated `Command` envelopes. Reconnection is the client's job: on an unexpected drop it reattaches, and the backend's attach behavior: buffered header, latest state, current status, per [stage-03/transport-and-live-runner.md](../stage-03/transport-and-live-runner.md): makes resumption stateless. How the live page uses it is [live-session-control.md](live-session-control.md).

## Identity: the mock auto-logon

One mock user, signed in automatically: no login page, no logout, no session storage. `identity.ts` resolves the username once: the `VITE_SANDBOX_USER` dev override when set, otherwise `dev-user`, matching the backend stub's fallback. The app shell fetches `GET /api/me` at startup to display "signed in as ⟨user⟩" and learn whether the user may start sessions. Every fetch carries the `x-sandbox-user` header.

The browser WebSocket API cannot set headers, so the socket client appends the identity as a `user` query parameter instead. The backend's `resolveUserId` grows that second source: header when present, else the `user` query parameter on the WS upgrade, else `dev-user`. It is still one function, still the only place identity is decided. When OAuth lands it replaces this resolution with a session cookie (which the browser sends on both fetch and upgrade automatically) and replaces `identity.ts` with the real session, with no caller changes on either side.

New backend route: `GET /api/me` → `{user_id, allowlisted}`. It is the frontend's single source for who-am-I and what-may-I-do, so the OAuth replacement has one obvious place to land.

## The allowlist

The operator-configured allowlist from [frontend.md](../../docs/specs/frontend.md) gates starting live sessions, keyed on the stub identity until OAuth brings real ones. `SESSION_ALLOWLIST` joins `config.ts` as a comma-separated list of user ids, defaulting to `dev-user` so a fresh checkout plays out of the box. `POST /api/sessions` returns 403 with a `not_allowlisted` code for users not on it, in both modes, since starting a watch session also consumes a container. Everything read-only stays open: environments, session rows, spectating an existing session's socket, recordings, and replays. The frontend hides the play and watch entry points when `/api/me` says `allowlisted: false`. The backend check is the enforcement; the UI state is courtesy.

## The renderer contract and registry

Per [interaction.md](../../docs/specs/interaction.md), each environment registers a frontend module that draws per-step states; live play and replay share it by design. Renderers draw on PixiJS through a shared base class; [rendering.md](../../docs/contributors/environments/rendering.md) is the authority for that infrastructure, and this section records the contract the rest of the frontend depends on. The contract, in `renderers/types.ts`:

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
  internalSize: { width: number; height: number }  // the logical space the renderer draws in
  aspectRatio: number               // width / height; the shape the host lays out around
}
```

Two rules give the architecture its properties.

First, **determinism**. `render(state)` must draw a frame that is a pure function of the passed state, plus the mount-time header and metadata, with no dependence on what was rendered before. So the live page, the replay player, and the scrubber are all the same call with a different state source. The PixiJS scene graph is retained: display objects persist and are mutated: but the visible frame still depends only on the current state (see [rendering.md](../../docs/contributors/environments/rendering.md)).

Second, **the chrome split**. The renderer owns the game frame: the world plus the in-game UI (score, tick, status that belongs inside the game). The hosting page owns the session chrome that must work for every environment: start/stop/pause controls, the status banner, the active-timeout display, and later the feedback prompt. That split is what lets [live-session-control.md](live-session-control.md) and [replay-and-retention.md](replay-and-retention.md) build their hosts once, for all future environments.

A renderer declares the shape it draws in, not a pixel size. `internalSize` is its fixed logical coordinate space, and `aspectRatio` (derived from it) is what the host lays out around: it sizes the stage element and seats the decision log beside a portrait canvas or below a landscape one. Once the host has a nonzero layout rect, the base sets Pixi's CSS screen to that size, uses the current device-pixel ratio for its backing store, and scales the internal space onto it. It repeats that work when the host size or device-pixel ratio changes, without recreating the GPU context. The renderer code only ever speaks internal coordinates. These two fields replace the single `targetCanvasSize` an earlier season carried.

`renderers/registry.ts` maps the metadata `renderer` key (Flappy Bird's is `"flappy-bird"`) to its module. The home-card thumbnail the spec asks for is not in the environment metadata. It comes from the registered module's `thumbnail` export, with a generic placeholder for an environment whose renderer is not registered yet. Adding an environment's visuals is therefore one frontend module and zero metadata changes.

## Pages

Routing: `/` (home), `/environments/:envId`, `/sessions/:id` (live, in [live-session-control.md](live-session-control.md)), `/replays/:id` (in [replay-and-retention.md](replay-and-retention.md)). The app shell (`components/AppShell.vue`) renders the header chrome (site name, signed-in user) around every page. `App.vue` wraps it in the `me.ts` provider, which fetches `GET /api/me` once and `provide`s it, so the header and the pages both `inject` the one allowlist answer. The `/sessions/:id` and `/replays/:id` routes are implemented as the live renderer host and replay viewer. `renderers/index.ts` is the registration barrel `main.ts` imports, and it registers the Flappy Bird renderer module.

The Environment page's play and watch entry points open the shared start form, call the typed `startSession` client, and navigate to the resulting `/sessions/:id`. An `already_active` result closes the form and opens the standalone confirmation described above. The form collects an optional seed for both modes and the human-slot timeout override for human play. The in-session pause and active-timeout display belong to [live-session-control.md](live-session-control.md); this page provides the gated entry points and the navigation seam.

- **Home** lists environments as cards from `GET /api/environments`: display name, the short description, the slot count from `min_slots`/`max_slots`, a human-playable badge from `human_slots`, and the registry thumbnail: exactly the card fields [frontend.md](../../docs/specs/frontend.md) names.
- **Environment page** shows the description and the entry points into play and watch (gated by `allowlisted`), plus the recent-replays list from [replay-and-retention.md](replay-and-retention.md). Leaderboards and the submission form join in Stages 5 and 6; the page renders without them rather than carrying placeholders. [Stage 4.5](../stage-04.5-ui-restructure.md) later reverses the no-placeholders decision at the navigation level (visible coming-soon entries for the future sections); this page-level statement reflects Stage 4 as built.
