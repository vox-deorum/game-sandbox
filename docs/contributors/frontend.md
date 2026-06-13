# The frontend

The frontend is the browser app outside the container and backend: Vue 3 with Vite and TypeScript, served on one origin in development. It reads the public environment metadata, hosts live play and replays through per-environment renderers, and signs everyone in as a single mock development user until GitHub OAuth lands (see the [frontend spec](../../specs/frontend.md) and the [interaction spec](../../specs/interaction.md)). This page covers the package, the live-session host, and the replay viewer; the renderer contract and the PixiJS infrastructure every renderer inherits have their own authority in [rendering.md](rendering.md).

The frontend is built on a design system — semantic CSS tokens plus a small set of Vue primitives under `components/ui/`. [design.md](design.md) is the authority for that: the tokens, the primitives, the accessibility baseline, and the rule that new UI is assembled from documented primitives rather than ad hoc CSS. This page covers package mechanics and does not duplicate it.

## Package layout

`frontend/` is the `@game-sandbox/frontend` npm workspace, private and `type: module`, on the root's Node 22 pin. It uses Vite with `@vitejs/plugin-vue`, Vue 3 (the `<script setup>` SFC style), `vue-router` 4 in plain library mode, and no state-management library (Vue reactivity plus small explicit classes). There is no CORS configuration anywhere because development is single-origin.

| Path | What it is |
| --- | --- |
| `index.html` / `src/main.ts` | The Vite entry and the app: the Vue app, the vue-router routes, and the three style-layer imports (`tokens`, `base`, `app`). |
| `src/App.vue` / `src/components/AppShell.vue` | `App.vue` wraps the shell in the `me.ts` provider; `AppShell.vue` is the three-zone top bar (site name plus `AppNav.vue` on the left, signed-in readout on the right) around the routed page. |
| `src/styles/` | The global stylesheet: `tokens.css` (design tokens), `base.css` (reset, element defaults, focus and reduced-motion), `app.css` (the app-shell layout). See [design.md](design.md). |
| `src/identity.ts` | The mock auto-logon: the resolved user id, the request header, and the WebSocket `user` parameter. |
| `src/me.ts` | The `provide`/`inject` store that fetches `GET /api/me` once, shares the allowlist answer, and exposes `whenSettled()` so a page can await identity without polling. |
| `src/api/client.ts` | Typed wrappers per backend route; failures the UI must distinguish (403, 409) come back as typed results. |
| `src/api/socket.ts` | The session WebSocket client: classifies frames with the shared rule, exposes typed callbacks, sends commands, reconnects. |
| `src/renderers/` | The renderer contract (`types.ts`), the PixiJS base class (`base/`), the registry (`registry.ts`), the registration barrel (`index.ts`), and one module per environment (`flappy-bird/`). See [rendering.md](rendering.md). |
| `src/replay/` | The dependency-free recording parser (`parse.ts`) and the replay transport controller (`transport.ts`). |
| `src/components/ui/` | The design-system primitives, `Ui` prefix (`UiButton`, `UiCard`, `UiField`, `UiDialog`, `UiSlider`, …). See [design.md](design.md). |
| `src/components/` | Feature components built on the primitives: `AppShell`, `AppNav`, `StartForm`, `RunMetadata`, `RecentReplays`, `DecisionLog`. |
| `src/composables/` | Page logic more than one page needs: `useEnvironmentMeta`, `useSessionSocket`, `useRendererMount`, `usePinning`, `useReplayTransport`. |
| `src/lib/` | Pure helpers with no reactivity: `format.ts` (`formatDate`, `slotLabel`, `formatAction`). |
| `src/pages/` | Route components, PascalCase with a `Page` suffix: `HomePage`, `EnvironmentPage`, `SessionPage`, `ReplayPage`, and the dev-only `StyleguidePage`. |

## Running the dev server against a local backend

`npm run dev` starts the Vite dev server. It proxies `/api` (HTTP and WebSocket, `ws: true`) to the backend on port 8080, so the browser sees one origin and the same-origin fetch and socket both reach the backend. Start the backend separately (`npm run dev` in `backend/`, which needs a Docker daemon to actually launch sessions), then open the Vite URL. `npm run check` is Biome plus `vue-tsc --noEmit` (Biome lints the `.ts` files and the SFC `<script>` blocks are excluded from Biome, so `vue-tsc` is what type-checks the templates); `npm test` runs the Vitest suite in jsdom with no canvas and no network. `npm run build` emits the production bundle to `frontend/dist/` (git-ignored), which the end-to-end suite serves through Vite preview.

## Launching the whole stack with one command

In production the frontend is not a separate server: the backend serves the built bundle from the same origin through `@fastify/static`, with an `index.html` fallback for client-side routes (`/environments/:id`, `/sessions/:id`, `/replays/:id`) so a hard refresh or a shared deep link loads. `npm start` at the repo root builds `frontend/dist/` and launches the backend serving it on `:8080` — one command for the whole stack (a Docker daemon is still required to actually run sessions). The backend wires static serving only when a built bundle is present, so the dev server (Vite serves the app) and the tests (no bundle) are untouched; the directory it serves is the repo's `frontend/dist/` by default, overridable with `FRONTEND_DIST`.

## The mock identity, and acting as another user

There is one user, signed in automatically, with no login page and no logout. `identity.ts` resolves the id once: the `VITE_SANDBOX_USER` environment override when set, otherwise `dev-user`, matching the backend stub's fallback. Every API request carries it as the `x-sandbox-user` header; the WebSocket API cannot set a header on its upgrade, so the socket client appends the same id as a `user` query parameter, and the backend's `resolveUserId` reads either source. This is the one place the frontend decides identity, so OAuth later replaces this module with the real session and no caller changes.

To act as a different user (for example to exercise the allowlist), set `VITE_SANDBOX_USER` when starting the dev server, and add that id to the backend's `SESSION_ALLOWLIST` if it should be able to start sessions. The app shell fetches `GET /api/me` to display the signed-in id and to learn whether the user may start sessions; the Environment page hides the play and watch entry points when `allowlisted` is false, but the backend's 403 is the real enforcement.

## The renderer contract and registry

Each environment registers a frontend module that draws per-step states, and live play and replay share it by design. Renderers draw on PixiJS through a shared base class; [rendering.md](rendering.md) is the authority for the contract, the base class, the sizing-and-scaling model, and how a retained scene graph stays deterministic. The essentials the rest of this page leans on:

- A renderer is handed a `RendererContext` once at mount (the `container`, the environment `meta`, the recording `header`, the `controlledSlots`, and an optional `sendAction`) and returns a `RendererInstance` (`render(state)` per step, `destroy()` once).
- A `RendererModule` exports `mount(ctx)`, a `thumbnail` for the home cards, and the shape it draws in — `internalSize` (its fixed logical coordinate space) plus the derived `aspectRatio`. The host reads `aspectRatio` to size the stage and place the decision log beside a portrait canvas or below a landscape one; the base class scales the internal space onto the real rect and resizes in place when the rect changes.
- Two rules: **determinism** (`render(state)` draws a frame that is a pure function of state, so live, replay, and the scrubber are one call with a different source) and **the chrome split** (the renderer owns the game frame; the host owns the session chrome that works for every environment).

`registry.ts` maps the metadata `renderer` key to its module; the home-card thumbnail comes from the registered module's `thumbnail`, with a placeholder for an unregistered environment. Adding an environment's visuals is one frontend module and zero metadata changes — the full recipe is in [rendering.md](rendering.md).

The first renderer, `renderers/flappy-bird/`, is the reference implementation: it declares a `288 × 512` internal space, keeps a pure `computeScene(state)` (unit-tested in jsdom) feeding a retained PixiJS reconciler in `update(state)`, and wires Space / ArrowUp / W and pointer-or-touch to the flap action for the live owner only. See [rendering.md](rendering.md#the-flappy-bird-renderer).

## The live-session host

`pages/SessionPage.vue` is composed from small composables: `useSessionSocket` owns the socket and the chrome state it derives (connection, status, paused, end reason, final result, the pause/stop/input actions); `useRendererMount` owns the canvas; `usePinning` owns the pin toggle. The page fetches the session row, awaits identity through `me.whenSettled()`, mounts the renderer when the header arrives (immediately — attach replays the buffered header, latest state, and status), and draws each state. The renderer owns the game frame; the page owns the session chrome that works for every environment: the status strip on `UiStatusBadge` and `UiButton`, the pause/resume toggle, the stop button (sent in-band as the `stop` command), the active-timeout display, the decision log, and the end-of-session card (`UiCard`) with the replay link and pin. The start form (`components/StartForm.vue`) opens in a `UiDialog` from the environment hub's Play/Watch entry points and collects an optional seed and the human-slot timeout override before `POST /api/sessions`.

Capabilities derive from identity and mode, not separate flags: the owner of a human session controls the human slots and gets a live `sendAction`; the owner of a scripted session gets controls but no input; anyone else is a spectator. Pause state is never tracked locally — the UI reflects the `pause`/`resume` echoes the backend broadcasts, so it cannot disagree with the container. The active-timeout display reads the metadata: a paced environment shows its per-step input window (50 ms / 20 steps per second for Flappy Bird), an unpaced one its move clock.

The **decision log** (`components/DecisionLog.vue`) shows the agent's per-tick action — `StepState.agents[slot].action`, already in the state stream, so it needs no new transport. It is a two-column `Tick | Decision` table that follows the latest tick, shared with the replay page (where it follows the scrubber instead). An already-ended session is a historical view: it hydrates the final facts and the decision log from the stored recording and never opens a socket.

## The replay viewer and transport

`pages/ReplayPage.vue` fetches a recording's JSONL by URL and parses it in the browser with `replay/parse.ts`. The schema package's Ajv-backed `readRecording` cannot run in the bundle (it reads schema files with `node:fs`), so `parse.ts` mirrors its behavior with structural casts — the backend is authoritative and already shaped the lines — and keeps the one check that earns its keep: a header `schema_version` this viewer does not understand surfaces as the friendly "this replay needs a newer viewer" message. The supported version comes from the dependency-free `@game-sandbox/schema/version` subpath, so there is still one declaration. A `vite build` confirms the bundle pulls in neither Ajv nor `node:fs`.

`replay/transport.ts` is a plain controller over the parsed state array, wrapped by the `useReplayTransport` composable, which mirrors its state into a ref and adds the keyboard map (space toggles play, the arrows step, Home and End jump). The renderer's purity rule makes every operation the same call — render state _i_ — so play (advancing on the pace interval, or a fixed cadence when unpaced), pause, step, and scrub are all just moving the index and rendering the state under it. The scrubber is `UiSlider` (Reka UI, located by its `slider` role); a `?t=⟨tick⟩` deep link seeks on load. The viewer mounts the same renderer module live play uses, with no `sendAction` and no controlled slots (draw-only by construction), shares the metadata block and pin toggle with the session page, and shows the same decision log replayed from the recorded states.

## The styleguide route

`pages/StyleguidePage.vue` renders the token swatches and every `components/ui/` primitive in every variant and state. It is the working surface for design review and the definition of done for a primitive: a variant that is not shown there does not exist. The route is registered in `main.ts` only when `import.meta.env.DEV` is true, and the page loads through a dynamic import, so production builds carry neither the route nor the code (a `vite build` confirms the styleguide chunk's absence). See [design.md](design.md).
