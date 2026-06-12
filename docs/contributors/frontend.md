# The frontend

The frontend is the browser app outside the container and backend: React with Vite and TypeScript, served on one origin in development. It reads the public environment metadata, hosts live play and replays through per-environment renderers, and signs everyone in as a single mock development user until GitHub OAuth lands (see the [frontend spec](../specs/frontend.md) and the [interaction spec](../specs/interaction.md)). This page covers the package and the pieces the infrastructure step builds; the Flappy Bird renderer, the live-session host, and the replay viewer are filled in by the later Stage 4 steps and documented as they land.

## Package layout

`frontend/` is the `@game-sandbox/frontend` npm workspace, private and `type: module`, on the root's Node 22 pin. It uses Vite with `@vitejs/plugin-react`, React 19, `react-router` 7 in plain library mode, and no state-management library (React hooks plus small explicit classes). There is no CORS configuration anywhere because development is single-origin.

| Path | What it is |
| --- | --- |
| `index.html` / `src/main.tsx` | The Vite entry and the app: the router, the app shell (header with the site name and the signed-in user), and the page routes. |
| `src/identity.ts` | The mock auto-logon: the resolved user id, the request header, and the WebSocket `user` parameter. |
| `src/me.tsx` | The app-shell context that fetches `GET /api/me` once and shares the allowlist answer with every page. |
| `src/api/client.ts` | Typed wrappers per backend route; failures the UI must distinguish (403, 409) come back as typed results. |
| `src/api/socket.ts` | The session WebSocket client: classifies frames with the shared rule, exposes typed callbacks, sends commands, reconnects. |
| `src/renderers/` | The renderer contract (`types.ts`), the registry (`registry.ts`), the registration barrel (`index.ts`), and one module per environment. |
| `src/pages/` | Home, Environment, and the live-session and replay hosts. |

## Running the dev server against a local backend

`npm run dev` starts the Vite dev server. It proxies `/api` (HTTP and WebSocket, `ws: true`) to the backend on port 8080, so the browser sees one origin and the same-origin fetch and socket both reach the backend. Start the backend separately (`npm run dev` in `backend/`, which needs a Docker daemon to actually launch sessions), then open the Vite URL. `npm run check` is Biome plus `tsc --noEmit`; `npm test` runs the Vitest suite in jsdom with no canvas and no network. `npm run build` emits the production bundle to `frontend/dist/` (git-ignored), which the end-to-end suite serves through Vite preview.

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
2. Call `registerRenderer("<renderer-key>", module)` with the environment metadata's `renderer` value, and add an import for the module to `src/renderers/index.ts` (the registration barrel `main.tsx` imports), so it registers on app load.
3. Export a `thumbnail` so the home card and the environment page show the environment's art instead of the placeholder.

Adding an environment's visuals is one frontend module and zero metadata changes.
