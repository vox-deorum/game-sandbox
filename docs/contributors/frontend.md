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
| `src/environmentCatalog.ts` | Application-lifetime environment metadata cache |
| `src/renderers/` | Renderer contract, registry, PixiJS base, environment modules |
| `src/replay/` | Browser-safe recording parser and replay transport |
| `src/styles/` | Tokens, global element rules, and app-shell layout |
| `src/auth.ts` | The Better Auth Vue client |
| `src/me.ts` | Shared `GET /api/me` state |
| `src/composables/useSiteConfig.ts` | Shared `GET /api/config` site name for the brand and title |
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

## Identity and session

The app carries the Better Auth session cookie automatically on same-origin requests; no request sends an identity header or query parameter.

A `/login` page offers email and password sign-in and, when the deployment configures GitHub OAuth, a "Sign in with GitHub" button. Sign-out goes through the account menu.

`me.ts` fetches `GET /api/me` once at load into `{ user | null }`, with a derived `status`. The `canParticipate` and `isAdmin` helpers gate the UI from that status. The frontend hides actions the user cannot take, but backend authorization remains the enforcement.

`environmentCatalog.ts` is the shared application-lifetime read of public environment metadata. Consumers call `loadEnvironmentCatalog()` or `environmentMeta()` instead of issuing page-local `GET /api/environments` requests. Concurrent callers share one in-flight request, a successful catalog remains cached for later navigation, and a rejected request is discarded so another navigation can retry. Tests call `resetEnvironmentCatalog()` to isolate cache and retry cases.

## Typed API boundaries

`api/client.ts` has one wrapper per HTTP route. Expected refusals such as 403 and 409 return typed results instead of throwing. Pages should branch on stable backend error codes, not message text.

`api/socket.ts` classifies each WebSocket frame with the shared protocol rule:

- A top-level `kind` means an event envelope.
- No top-level `kind` means a recording header or state line.

Keep protocol and environment metadata declarations in `@game-sandbox/schema`. Do not create frontend-only copies.

## Documentation page

`DocsPage.vue` renders the student guides in the app. The backend serves the raw markdown under `docs/students/` through `GET /api/docs/manifest`, `GET /api/docs/index`, and `GET /api/docs/pages/*`; the page fetches the navigation manifest once, then the current page, and renders it with `DocsMarkdown.vue`. The landing at `/docs` is the students index, or a deployment's `DOCS_INDEX_FILE` override (see [Configuration](configuration.md)).

The guides are authored for MkDocs, so `docs/markdown.ts` reproduces two MkDocs behaviors when rendering with markdown-it: heading ids use the python-markdown slug, and relative `.md` links are rewritten relative to the page. A link to another student guide becomes an in-app route and navigates without a reload; a link to a doc the site does not serve, such as a specification page, opens its source on GitHub. Only the `students/` subtree is served; a page fetch is path-sanitized to that subtree.

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

`StageFrame.vue` owns the renderer-and-log grid shared by `SessionPage.vue` and `ReplayPage.vue`. Its slots cover the renderer overlay and status, the beside-log position, and below-stage content; its layout switches between portrait and landscape using the renderer aspect ratio. The pages keep their transports separate: the live page still owns sockets and commands, while the replay page still owns its immutable state array and playback transport.

Live and replay attribution use the pure `unknown`, `masked`, or `visible` policy from `lib/anonymity.ts`. Incomplete identity, season, or recording facts remain `unknown`, and presentation treats that state as masked until all facts establish visibility. Anonymous-number requests begin only after the policy reaches `masked`, so unresolved live state cannot briefly reveal canonical submission ownership or trigger a numbering read before masking is known.

## Submissions and watch runs

`SubmitAgentForm.vue` appears only for the profile owner when a submission Season is open.

The form:

1. Collects a repository URL and optional ref.
2. Requires a reachability check for the exact current input.
3. Submits and polls the returned submission.
4. Renders `resolve → static → build → load` through `SubmissionStageTimeline`.
5. Shows the exact failing-stage detail.

The local-folder field exists only when both `import.meta.env.DEV` and the backend capability enable it.

`AgentProfilePage.vue` shows one owner's history for one environment, including superseded submissions, validation checks, placements, and recent replays. The owner also sees the submission form, author prompt editor, and owner-only LLM debug surface.

For the owner, the page places a compact current-Season summary above the submission controls. It matches the non-superseded submission by `season_id`, shows the submission time and lifecycle status when one exists, and otherwise says **Not submitted yet**. A failed validation remains a submitted attempt. The public Season label loads independently of the profile, so a failed metadata request leaves the profile usable and falls back to `Season <short id>`. When no Season accepts submissions, this summary is the single closed-window message.

`SubmitAgentForm.vue` emits once when the backend accepts the pending submission and again when polling reaches a terminal validation status. `AgentProfilePage.vue` reloads after both events. The first reload changes the summary to pending immediately, while the second makes the final validation result and stored checks visible.

The optional `?season=<seasonId>` query makes My Submissions a Season-level destination. The page watches the query and the asynchronously loaded profile and Season data. A matching historical Season expands, then its stable `tabindex="-1"` target receives focus and scrolls into view. The current submission-open Season targets the summary even when it has no submission. An unknown Season id has no effect.

`MyAgentsPage.vue` reads authenticated `GET /api/my/agents`. The backend derives the caller through `requireUser`, accepts no owner identifier, and permits a pending user to inspect the same summary. The response groups rows by `env_id`; each group has a nullable `current_season` and at most three `previous_seasons`. A Season summary contains `id`, nullable `label`, `created_at`, `release_status`, an exact active-submission summary (`id`, `status`, and `submitted_at`) or `null`, and nullable `mean_score`.

The backend builds this response with batched reads for all of the caller's submissions, relevant Seasons, and `listPlacementsByUser(userId)`. Within a Season, the displayed attempt is only the non-superseded row. Score resolution examines every attempt by that user in that Season, because a later resubmission may supersede the submission that earned the latest released placement. A placement is returned only while its Season is released. Previous Seasons use the storage layer's canonical newest-first ordering, `created_at` followed by its existing row-order tie-break, exclude the current Season, and are limited to three after filtering to submitted Seasons.

My Agents includes an environment when it has either a submission-open Season or submission history. It renders the current Season first and previous Seasons after it, with explicit submitted/not-submitted, status, date, and released-score states. Each interactive `UiCard` is covered by one descriptive `RouterLink` to `/environments/:envId/agents/:ownerId?season=:seasonId`; do not add a separate profile link inside the card. Score rendering must distinguish `null` from zero so zero and negative results remain visible.

Backend and storage tests cover authentication, pending-user reads, ownership isolation, active-attempt selection per Season, deterministic three-Season history, release filtering, and a score earned before resubmission. API-client contract tests pin the summary DTO. Frontend unit tests cover My Agents loading, error and signed-out states, every score state, whole-card links, current-Season profile states, metadata fallback, both form refresh events, and asynchronous deep-link behavior. The Playwright submission journey covers both pages and follows a Season card into My Submissions. Run `uv run python scripts/ci.py frontend-e2e` after these UI changes.

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
- Writes are available only to active (`normal` or `admin`) users.
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
