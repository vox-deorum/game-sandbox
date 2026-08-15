# Browser end-to-end tests

The end-to-end suite lives under `frontend/e2e/`. It runs Playwright with Chromium against the real backend, which serves the built frontend from the same origin. Both this suite and the `backend-integration` job require a Docker daemon. The Docker-heavy `frontend-e2e` job is too slow for every push, so it has its own manually dispatched workflow at `.github/workflows/e2e.yml`. Run it from the Actions tab with **Run workflow** when a UI change warrants it.

For the wider verification matrix and how this job fits the pipeline, see [Testing](index.md). This page is about the suite itself: how to run it, how its data is set up, and the conventions for adding to it.

## Running it

Each directory under `frontend/e2e/` is a group, and each group is a Playwright project. Run the group that covers your change while you iterate, then run the whole suite before handing the change over.

```console
# Everything. This is what CI runs and what builds the demo fixture.
uv run python scripts/ci.py frontend-e2e

# One group, skipping the long season arcs. Repeat --group to pick several.
uv run python scripts/ci.py frontend-e2e --group hearts

# Every group, still skipping the arcs.
uv run python scripts/ci.py frontend-e2e --fast

# Keep the arcs in a narrowed run, and reuse the bundles from the last run.
uv run python scripts/ci.py frontend-e2e --group spades --include-slow --no-build
```

Once the session image and Chromium are in place, run Playwright directly:

```console
npm run e2e --workspace @game-sandbox/frontend -- --project seasons
npm run e2e:run --workspace @game-sandbox/frontend -- --project seasons   # skip both Vite builds
```

These commands use and erase `partial/` by default. Use the bare, unrestricted `scripts/ci.py frontend-e2e` helper to refresh the demo fixture. See [Data folders](../data/folders.md).

The suite runs serially (`workers: 1`, `fullyParallel: false`) so the real containers and the shared database never contend. One project per group does not change that: every group shares one backend, one database, and one port pair.

## Groups

| Group | Covers | Run it after changing |
| --- | --- | --- |
| `auth` | Sign in, sign out, roster creation, the pending gate, and the ban lifecycle. | `LoginPage.vue`, `ProfilePage.vue`, `AccountMenu.vue`, `me.ts`, `auth.ts` |
| `play` | Live Flappy Bird play, pause and resume, stop, replay, pin, and the season-settings download. | `SessionPage.vue`, `ReplayPage.vue`, `StageFrame.vue`, `useSessionSocket.ts`, `api/socket.ts` |
| `seasons` | Operator season configuration, the LLM controls, and a complete competition workflow. | `LeaderboardsPage.vue`, `SeasonsPage.vue`, `components/admin/`, `lib/standings.ts` |
| `submissions` | The resolve, static, build, and load pipeline: a ready agent watched, and a load failure. | `SubmitAgentForm.vue`, `SubmissionStageTimeline.vue`, `MyAgentsPage.vue`, `AgentProfilePage.vue` |
| `local` | The standalone local bundle against the loopback bridge, with canvas device-pixel-ratio and resize behavior. | `src/local/`, `vite.local.config.ts` |
| `hearts` | Four-seat rendering, the scheduled multi-seat matchup, the LLM journey, human seat play, and replay attribution. | `environments/hearts/renderer/` |
| `spades` | Chat filtering and replay, seat-ranked results on both seat plans, and the partnership matchup. | `environments/spades/renderer/` |
| `crane-reach` | A skirmish watched to game over with exact replay seeking, an army season built from the Season 5 preset with a submitted example agent, and an order composed by clicking the board. | `environments/skirmish_crane/renderer/` |
| `three-branches` | A seeded village watch session with camera and collision interaction plus repeatable replay seeking, and a human visitor journey: keyboard walking, the emote palette, the use preview, broadcast and direct chat, watcher completeness, and the replay transcript. | `environments/three_branches/renderer/` |

A change to something shared, such as `src/renderers/base/`, `components/ui/`, `styles/tokens.css`, or `api/client.ts`, needs the whole suite. A change to `src/renderers/cards/` needs `hearts` and `spades`.

Do not add a test to the `submissions` group if it submits a ready agent to the Flappy Bird Playground season. That group's watch-list assertion finds its agent by the anonymized label `Agent 1`, which is unambiguous only while that agent is the sole ready one.

## The slow tier

Four season arcs carry a `@slow` tag: the Hearts, Spades, Crane Reach, and leaderboards seasons. Each submits real agents, builds a container image per ordered seating, and runs the scheduled games, so each takes minutes. `--group` and `--fast` skip them; `--include-slow` keeps them; a bare run always includes them.

The configuration applies no filter of its own. Hiding `@slow` by default would make a complete run omit the released seasons the demo fixture needs.

## Suite setup

`playwright.config.ts` starts the main backend on port 8090 and the loopback local-play bridge on port 8091. The suite uses the bootstrap admin as its operator and creates owners, judges, and spectators as real member accounts through `e2e/support/fixtures.ts`.

Every group project depends on the `season-fixture` setup project, which gives the retained Playground season its local settings before any journey creates activity. Playwright runs a setup project once per run rather than once per dependent project, so selecting several groups still pays for it once. Do not pass `--no-deps`: the `play` group asserts against exactly those settings.

Keep shared helpers in `e2e/support/` and submission fixtures in `e2e/fixtures/`, so specs reach them through `../support/` and `../fixtures/`. Neither directory belongs in a group.

## Manual GitHub OAuth check

GitHub OAuth depends on an external provider, so the frontend Vitest suite covers the button and account-management wiring with mocks. Before releasing a GitHub integration change, run this check against a deployment with `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` configured:

1. Create an email and password user whose email matches the verified primary email of a GitHub account. Sign in with GitHub and confirm the existing user is used, with its status and display name unchanged.
2. Sign in to a different email and password user, open My Profile, and connect a GitHub account with a different verified email. Confirm the account email changes to the GitHub email, the username appears on My Profile and in the account menu, and the old email no longer signs in.
3. Open an agent profile owned by that user and confirm the owner link opens the connected GitHub profile. Confirm leaderboards and recordings do not show the GitHub username.
4. Disconnect GitHub and confirm the username disappears while the changed account email remains. Confirm email and password sign-in still works with that email.
5. Sign in as a GitHub-only user and confirm My Profile does not allow disconnecting the final sign-in method.
6. Confirm that connecting a second GitHub account or a GitHub email already owned by another Game Sandbox user is refused with an inline error.

## A fresh data directory every run

`e2e/fresh-backend.mjs` deletes the selected data directory before the backend starts, leaving sibling directories untouched. This keeps runs independent and lets tests use readable, stable names. See [Data folders](../data/folders.md).

## The demo source fixture

The e2e suite creates the demo source fixture, including recordings, submissions, and real sign-in accounts. After changing journey-created data, run `npm run demo -- --rerun-e2e` before starting the demo.

The bare unrestricted helper run rebuilds `main/` by default. Narrowed and direct runs cannot replace it by default, which protects the complete demo fixture from a partial run.

## Naming and shared helpers

Shared identities live in `e2e/support/names.ts` and shared API flows in `e2e/support/api.ts`. Reuse them instead of repeating request and assertion code.

- **Seasons** use short, themed labels without years, such as `Updraft Open` and `Thermals Cup`. Give each test a distinct label: the suite shares one database during a run, so duplicates make assertions ambiguous.
- **Agents** use their owner id as the public handle linked from the leaderboard and as the key in `/agents/<owner>`. Use realistic handles such as `ada-lovelace` and `grace-hopper`. Limit each owner to one test purpose so its profile remains unambiguous.
- **Raters** are active (`normal`) member accounts created by the `as` fixture. The Human Ratings board ranks an agent only after at least three distinct people rate it.

## Adding a test or fixture

- Put the spec in the group whose area it covers. To add a group, create a directory under `e2e/` and put a spec in it. A group is any directory holding at least one `*.spec.ts`; both `playwright.config.ts` and `scripts/ci.py` discover groups this way, so neither has a list to update. `support/` and `fixtures/` are not groups because they hold no specs.
- Tag a test `@slow` when it submits agents and runs a scheduled season. Anything cheaper belongs in the default tier, where contributors will actually run it.
- Prefer the jsdom suite under `frontend/test/`. A browser test earns its place by needing a real container, a real socket, a second browser context, a painted canvas, a real download, or real navigation and cookies. Assertions about text, disabled controls, validation, and markup structure belong in jsdom, where they run in milliseconds.
- Add identities to `support/names.ts` and flows to `support/api.ts`; keep specs declarative.
- A new submission fixture is a folder under `fixtures/submission/` with a `manifest.json` (mirror `good/manifest.json`) and an `agent.py` exposing a callable `Agent` with `reset`/`act`.
- Assert DOM facts such as visible controls, a painted canvas, and board rows. Never assert pixels: font and GPU differences between runners would make the suite unreliable.
