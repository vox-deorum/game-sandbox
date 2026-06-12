# The frontend

The frontend is the browser app outside the container and backend: Vue 3 with Vite and TypeScript, served on one origin in development. It reads the public environment metadata, hosts live play and replays through per-environment renderers, and signs everyone in as a single mock development user until GitHub OAuth lands (see the [frontend spec](../specs/frontend.md) and the [interaction spec](../specs/interaction.md)). This page covers the package, the renderer contract and the Flappy Bird renderer, the live-session host, and the replay viewer.

## Package layout

`frontend/` is the `@game-sandbox/frontend` npm workspace, private and `type: module`, on the root's Node 22 pin. It uses Vite with `@vitejs/plugin-vue`, Vue 3 (the `<script setup>` SFC style), `vue-router` 4 in plain library mode, and no state-management library (Vue reactivity plus small explicit classes). There is no CORS configuration anywhere because development is single-origin.

| Path | What it is |
| --- | --- |
| `index.html` / `src/main.ts` | The Vite entry and the app: the Vue app and the vue-router routes. |
| `src/App.vue` / `src/components/AppShell.vue` | `App.vue` wraps the shell in the `me.ts` provider; `AppShell.vue` is the header chrome (site name, signed-in user) around the routed page. |
| `src/identity.ts` | The mock auto-logon: the resolved user id, the request header, and the WebSocket `user` parameter. |
| `src/me.ts` | The `provide`/`inject` store that fetches `GET /api/me` once and shares the allowlist answer with every page. |
| `src/api/client.ts` | Typed wrappers per backend route; failures the UI must distinguish (403, 409) come back as typed results. |
| `src/api/socket.ts` | The session WebSocket client: classifies frames with the shared rule, exposes typed callbacks, sends commands, reconnects. |
| `src/renderers/` | The renderer contract (`types.ts`), the registry (`registry.ts`), the registration barrel (`index.ts`), and one module per environment (`flappy-bird/`). |
| `src/replay/` | The dependency-free recording parser (`parse.ts`) and the replay transport controller (`transport.ts`). |
| `src/components/` | Shared components: the app shell and the session start form. |
| `src/pages/` | Home, Environment, the live-session host (`session.vue`), and the replay viewer (`replay.vue`). |

## Running the dev server against a local backend

`npm run dev` starts the Vite dev server. It proxies `/api` (HTTP and WebSocket, `ws: true`) to the backend on port 8080, so the browser sees one origin and the same-origin fetch and socket both reach the backend. Start the backend separately (`npm run dev` in `backend/`, which needs a Docker daemon to actually launch sessions), then open the Vite URL. `npm run check` is Biome plus `vue-tsc --noEmit` (Biome lints the `.ts` files and the SFC `<script>` blocks are excluded from Biome, so `vue-tsc` is what type-checks the templates); `npm test` runs the Vitest suite in jsdom with no canvas and no network. `npm run build` emits the production bundle to `frontend/dist/` (git-ignored), which the end-to-end suite serves through Vite preview.

## Launching the whole stack with one command

In production the frontend is not a separate server: the backend serves the built bundle from the same origin through `@fastify/static`, with an `index.html` fallback for client-side routes (`/environments/:id`, `/sessions/:id`, `/replays/:id`) so a hard refresh or a shared deep link loads. `npm start` at the repo root builds `frontend/dist/` and launches the backend serving it on `:8080` — one command for the whole stack (a Docker daemon is still required to actually run sessions). The backend wires static serving only when a built bundle is present, so the dev server (Vite serves the app) and the tests (no bundle) are untouched; the directory it serves is the repo's `frontend/dist/` by default, overridable with `FRONTEND_DIST`.

## The mock identity, and acting as another user

There is one user, signed in automatically, with no login page and no logout. `identity.ts` resolves the id once: the `VITE_SANDBOX_USER` environment override when set, otherwise `dev-user`, matching the backend stub's fallback. Every API request carries it as the `x-sandbox-user` header; the WebSocket API cannot set a header on its upgrade, so the socket client appends the same id as a `user` query parameter, and the backend's `resolveUserId` reads either source. This is the one place the frontend decides identity, so OAuth later replaces this module with the real session and no caller changes.

To act as a different user (for example to exercise the allowlist), set `VITE_SANDBOX_USER` when starting the dev server, and add that id to the backend's `SESSION_ALLOWLIST` if it should be able to start sessions. The app shell fetches `GET /api/me` to display the signed-in id and to learn whether the user may start sessions; the Environment page hides the play and watch entry points when `allowlisted` is false, but the backend's 403 is the real enforcement.

## The renderer contract and registry

Each environment registers a frontend module that draws per-step states, and live play and replay share it by design. The contract lives in `renderers/types.ts`:

- `RendererContext` is everything a renderer is handed once at mount: the `container` element it owns, the environment `meta`, the recording `header`, the `controlledSlots` (empty when spectating or replaying), and an optional `sendAction` (absent outside live human play).
- `RendererInstance` is the mounted renderer: `render(state)` per step, and `destroy()` once.
- `RendererModule` is what an environment exports: `mount(ctx)` and a `thumbnail` URL for the home cards.

Two rules give the architecture its properties. First, purity: `render(state)` must draw entirely from the passed state plus the mount-time header and metadata, with no accumulated history, so the live page, the replay player, and the scrubber are the same call with a different state source. Second, the chrome split: the renderer owns the game frame (the world plus in-game UI such as score, tick, and status that belongs inside the game), while the hosting page owns the session chrome that must work for every environment (the start/stop/pause controls, the status banner, the active-timeout display, and later the feedback prompt).

`registry.ts` maps the metadata `renderer` key to its module. The home-card thumbnail comes from the registered module's `thumbnail`, with a generic placeholder for an environment whose renderer is not registered yet.

## Adding a renderer for a new environment

This is the page future environments land on. To give an environment its visuals:

1. Write a module under `src/renderers/<env>/` that satisfies `RendererModule`, drawing only from the per-step state, the header, and the metadata. Keep any logic (scene computation) separate from the actual drawing so it is testable as plain functions in jsdom.
2. Call `registerRenderer("<renderer-key>", module)` with the environment metadata's `renderer` value, and add an import for the module to `src/renderers/index.ts` (the registration barrel `main.ts` imports), so it registers on app load.
3. Export a `thumbnail` so the home card and the environment page show the environment's art instead of the placeholder.

Adding an environment's visuals is one frontend module and zero metadata changes.

## The Flappy Bird renderer

`renderers/flappy-bird/` is the first real renderer and the template for the rule above. It splits into a pure `scene.ts` and a thin `paint.ts`:

- `computeScene(state, config)` turns one `StepState` into a `Scene` — a list of drawing primitives (sky, pipes, ground, the bird) plus the in-game HUD (the big score, the pipe counter, and a paced time/tick readout) — reading only the overlay's unnormalized screen coordinates plus the mount-time config. It is pure, so the same state always yields the same scene; that is the property the replay scrubber relies on, and it makes the logic unit-testable in jsdom with no canvas.
- `paint(ctx, scene)` is a trivial switch that rasterizes the scene into a 2D canvas. Real pixels are the end-to-end suite's job; jsdom has no canvas, so the module tolerates a null 2D context and simply skips painting under unit tests.

Input is raw device input, wired only for the owner of a live human session (the context's `sendAction` present and `player_0` among the `controlledSlots`): keydown (Space, ArrowUp, W; auto-repeat ignored), pointerdown, and touchstart each send one flap as `sendAction("player_0", 1)`, which the session host wraps in an `input` command. A spectator or the replay viewer mounts the same module with no `sendAction` and gets a draw-only renderer with every input path inert.

## The live-session host

`pages/session.vue` fetches the session row, connects the socket client, and mounts the environment's renderer when the header arrives (which is immediately — attach replays the buffered header, latest state, and status). The renderer owns the game frame; the page owns the session chrome that works for every environment: the status banner, the pause/resume toggle, the stop button (sent in-band as the `stop` command), the active-timeout display, and the end-of-session card with the replay link and the pin stub. The start form (`components/StartForm.vue`, opened from the environment page's Play/Watch entry points) collects an optional seed and the human-slot timeout override before `POST /api/sessions`.

Capabilities derive from identity and mode, not separate flags: the owner of a human session controls the human slots and gets a live `sendAction`; the owner of a scripted session gets controls but no input; anyone else is a spectator. Pause state is never tracked locally — the UI reflects the `pause`/`resume` echoes the backend broadcasts, so it cannot disagree with the container. The active-timeout display reads the metadata: a paced environment shows its per-step input window (50 ms / 20 steps per second for Flappy Bird), an unpaced one its move clock.

## The replay viewer and transport

`pages/replay.vue` fetches a recording's JSONL by URL and parses it in the browser with `replay/parse.ts`. The schema package's Ajv-backed `readRecording` cannot run in the bundle (it reads schema files with `node:fs`), so `parse.ts` mirrors its behavior with structural casts — the backend is authoritative and already shaped the lines — and keeps the one check that earns its keep: a header `schema_version` this viewer does not understand surfaces as the friendly "this replay needs a newer viewer" message. The supported version comes from the dependency-free `@game-sandbox/schema/version` subpath, so there is still one declaration. A `vite build` confirms the bundle pulls in neither Ajv nor `node:fs`.

`replay/transport.ts` is a plain controller over the parsed state array. The renderer's purity rule makes every operation the same call — render state _i_ — so play (advancing on the pace interval, or a fixed cadence when unpaced), pause, step, and scrub are all just moving the index and rendering the state under it. A `?t=⟨tick⟩` deep link seeks on load. The viewer mounts the same renderer module live play uses, with no `sendAction` and no controlled slots (draw-only by construction), and shows a pin toggle when the signed-in user owns the recording.
