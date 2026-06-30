# Frontend

The frontend is a Vue 3, Vite, and TypeScript browser app. It reads environment metadata, hosts live sessions and replays, and calls the backend through typed HTTP and WebSocket clients.

Read [the frontend specification](../specs/frontend.md) for product behavior, [the interaction specification](../specs/interaction.md) for the browser/server boundary, and [the design system](design.md) before changing visuals. Renderer internals live in [Rendering](rendering.md).

## Architecture

```text
Route page
   ├─ feature components
   ├─ composables
   ├─ typed API client
   └─ renderer registry → environment renderer
```

The app uses Vue reactivity and small explicit classes instead of a state-management library. Development is single-origin through Vite's `/api` proxy, so the project has no CORS configuration.

## Package map

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | Create the app, register routes, import global styles and renderers |
| `src/App.vue` | Install the identity provider and app shell |
| `src/pages/` | Route components, named `*Page.vue` |
| `src/components/ui/` | Design-system primitives with the `Ui` prefix |
| `src/components/` | Feature components built from primitives |
| `src/composables/` | Reusable page behavior |
| `src/api/client.ts` | Typed HTTP wrappers |
| `src/api/socket.ts` | Session WebSocket client |
| `src/renderers/` | Renderer contract, registry, PixiJS base, environment modules |
| `src/replay/` | Browser-safe recording parser and replay transport |
| `src/styles/` | Tokens, global element rules, and app-shell layout |
| `src/identity.ts` | Development identity resolution |
| `src/me.ts` | Shared `GET /api/me` state |
| `src/lib/` | Pure formatting helpers |

The global styles load in this order:

1. `tokens.css`
2. `base.css`
3. `app.css`

Feature styles stay scoped to their components and use the semantic tokens.

## Run and test

Run these commands from `frontend/`:

| Command         | Purpose                                                 |
| --------------- | ------------------------------------------------------- |
| `npm run dev`   | Start Vite and proxy `/api` to the backend on port 8080 |
| `npm run check` | Run Biome and `vue-tsc --noEmit`                        |
| `npm test`      | Run Vitest in jsdom                                     |
| `npm run build` | Build `frontend/dist/`                                  |

Start `npm run dev` in `backend/` separately. Docker is needed only when the backend launches a session.

From the repository root, `npm start` builds the frontend and starts the backend on port 8080. The backend serves `frontend/dist/` and falls back to `index.html` for client routes. Requests under `/api` keep normal JSON 404 responses.

After any UI change, update the jsdom and Playwright coverage and run:

```console
uv run python scripts/ci.py frontend-e2e
```

## Navigation

`AppShell.vue` combines two navigation levels:

| Global sidebar | Environment tabs      |
| -------------- | --------------------- |
| Environments   | Overview              |
| Seasons        | Leaderboards          |
| Documentation  | Replays               |
| My Agents      | My Submissions        |
| My Profile     | Manage, for operators |

`useSidebar` owns desktop collapse and the mobile drawer. The ancestor classes that drive shell layout live in `styles/app.css`, because scoped component CSS cannot reliably select the app ancestor.

Use the product terms **Environment** and **Season** in visible copy. They match route and API entity names.

## Development identity

Until OAuth replaces it, `identity.ts` resolves one mock user in this order:

1. `localStorage["sandbox-user"]`
2. `VITE_SANDBOX_USER`
3. `dev-user`

HTTP requests send `x-sandbox-user`. WebSocket upgrades cannot add that header, so the socket uses the `user` query parameter. The backend resolves both through one function.

To test another user, set `VITE_SANDBOX_USER` before starting Vite. To test two users in the same build, set `sandbox-user` separately in each browser context. Add any user that should start sessions to the backend's `SESSION_ALLOWLIST`.

The app shell fetches `GET /api/me` once through `me.ts`. The frontend hides actions the user cannot take, but backend authorization remains the enforcement.

## Typed API boundaries

`api/client.ts` has one wrapper per HTTP route. Expected refusals such as 403 and 409 return typed results instead of throwing. Pages should branch on stable backend error codes, not message text.

`api/socket.ts` classifies each WebSocket frame with the shared protocol rule:

- A top-level `kind` means an event envelope.
- No top-level `kind` means a recording header or state line.

Keep protocol and environment metadata declarations in `@game-sandbox/schema`. Do not create frontend-only copies.

## Renderer integration

The registry maps environment metadata's `renderer` value to a renderer class and thumbnail. Both live play and replay call the same renderer:

```text
Live WebSocket state ─┐
                     ├→ renderer.render(state)
Replay state array ──┘
```

The host provides:

- The mount container.
- Environment metadata.
- Recording header.
- Controlled slot IDs.
- `sendAction` only for a live human owner.

The renderer provides `internalSize`, derived `aspectRatio`, `render(state)`, and `destroy()`. Spectators and replays mount without input capability. See [Rendering](rendering.md) for the complete contract and the add-a-renderer checklist.

## Live session page

`SessionPage.vue` composes:

| Composable or component | Owns |
| --- | --- |
| `useSessionSocket` | Connection, session state, result, pause, stop, input |
| `useRendererMount` | Renderer lifecycle |
| `usePinning` | Recording pin |
| `DecisionLog` | Per-slot action history |
| `SessionRatings` | Post-session feedback |

The page mounts the renderer after the recording header arrives. A late attachment receives the buffered header, latest state, and current status immediately.

Capabilities come from identity and session mode:

- A human-session owner controls the assigned human slots.
- A scripted-session owner gets pause and stop controls, but no game input.
- Everyone else is a spectator.

Pause state comes from backend echoes, never local optimism. An ended session loads its final facts and decision log from the stored recording and does not open a socket.

## Submissions and watch runs

`SubmitAgentForm.vue` appears only for the profile owner when a submission season is open.

The form:

1. Collects a repository URL and optional ref.
2. Requires a reachability check for the exact current input.
3. Submits and polls the returned submission.
4. Renders `resolve → static → build → load` through `SubmissionStageTimeline`.
5. Shows the exact failing-stage detail.

The local-folder field exists only when both `import.meta.env.DEV` and the backend capability enable it.

`AgentProfilePage.vue` shows one owner's history for one environment, including superseded submissions, validation checks, placements, and recent replays. The owner also sees the submission form, author prompt editor, and owner-only LLM debug surface.

`WatchAgentPicker.vue` lists:

1. The built-in Naive agent.
2. Ready submissions from the play-open season.

The picker reads `GET /api/environments/:envId/watch-agents`, a viewer-specific response. Regular users receive an anonymous number and `unrated`, `rated`, or `own` state. Operators additionally receive owner and source details. Unrated agents use the primary **Rate** action; rated and owned agents use secondary **Watch again** actions. A 409 active-session response navigates to the existing session.

A watch run starts through `startSession`, whose payload is a per-slot `slots` assignment keyed by slot id, each slot naming its `kind` (`human`, `builtin-agent`, or `submission`) and a `submission_id` for submitted seats. A single-slot environment starts immediately with that one seat. A multi-seat environment opens `SeatAssignmentDialog.vue` with the clicked agent preselected into every seat: the dialog seats one agent, built-in Naive or a ready submission, in each required seat, collects the seed, and stays startable because no seat is ever empty. Play-with-agents routes through the same seat grid with seat 0 held by the human and a per-row control to move that single human seat.

## Ratings and author prompts

`SessionRatings.vue` loads viewer-appropriate agent names, the season prompt, author prompts, prior ratings, and read-only state in one request. It mounts only after session termination, directly above the stage, and uses the motion tokens for its downward reveal.

The UI mirrors backend rules:

- The user's own agent is visible but cannot be rated.
- The built-in agent is rateable only in a mixed session.
- A closed play window displays saved ratings without controls.
- Writes are available only to allowlisted users.
- While play is open, non-operators see anonymous submitted-agent attribution on the live session and replay surfaces. The stored recording header remains canonical, and the identified display returns when play closes.

The author's rating prompt is set in `SubmitAgentForm.vue`. The form prefills it from any existing value and saves it against the submission-open season as soon as the submission is accepted, so leaving the page mid-validation never drops it. It is editable only while that submission window stays open; once submissions close it locks, even if play is still open. The prompt is presentation metadata, separate from the validated submission artifact, and is surfaced read-only beneath each agent on the human-feedback board and once per season in the agent profile's submission history.

## Replay viewer

`ReplayPage.vue` fetches JSONL and parses it with `replay/parse.ts`. The browser parser stays dependency-free because the schema package's full recording reader uses Node file access.

The parser checks `schema_version` and reports when a replay needs a newer viewer. The supported version comes from `@game-sandbox/schema/version`.

`replay/transport.ts` controls the current state index. `useReplayTransport` exposes it to Vue and adds keyboard behavior:

| Key          | Action              |
| ------------ | ------------------- |
| Space        | Play or pause       |
| Left / Right | Step                |
| Home / End   | First or last state |

The `UiSlider` scrubber and `?t=<tick>` deep link both update the same index. Every operation ends with `renderer.render(states[index])`.

## Styleguide

`StyleguidePage.vue` shows design tokens and every primitive variant and state. The route exists only in development and is dynamically imported, so production builds do not include it.

A new primitive variant is incomplete until it appears on `/styleguide`. See [the design system](design.md).
