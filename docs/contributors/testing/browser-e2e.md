# Browser end-to-end tests

The end-to-end suite lives under `frontend/e2e/`. It runs Playwright with Chromium against the real backend, which serves the built frontend from the same origin. The suite and the `backend-integration` job require a Docker daemon. Being Docker-heavy makes the `frontend-e2e` job too slow for every push, so it has its own manually dispatched workflow at `.github/workflows/e2e.yml`. Run it from the Actions tab with **Run workflow** when a UI change warrants it.

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

Once the session image and Chromium are in place, drive Playwright directly:

```console
npm run e2e --workspace @game-sandbox/frontend -- --project seasons
npm run e2e:run --workspace @game-sandbox/frontend -- --project seasons   # skip both Vite builds
```

These write the throwaway database, including the form with no `--project`. Only the bare `scripts/ci.py frontend-e2e` builds the fixture `npm run demo` serves, so reach for it when you want that fixture refreshed.

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
| `crane-reach` | A skirmish watched to game over with exact replay seeking, and a full-variant army season. | `environments/skirmish_crane/renderer/` |

A change to something shared, such as `src/renderers/base/`, `components/ui/`, `styles/tokens.css`, or `api/client.ts`, needs the whole suite. A change to `src/renderers/cards/` needs `hearts` and `spades`.

Nothing that submits a ready agent into the Flappy Bird Playground season may join the `submissions` group. That group's watch-list assertion finds its agent by the anonymized label `Agent 1`, which is only unambiguous while its agent is the sole ready one.

## The slow tier

Four season arcs carry a `@slow` tag: the Hearts, Spades, Crane Reach, and leaderboards seasons. Each submits real agents, builds a container image per ordered seating, and runs the scheduled games, so each is minutes on its own. `--group` and `--fast` skip them; `--include-slow` keeps them; a bare run always includes them.

The configuration applies no filter of its own. A default that hid `@slow` would let a bare `npm run e2e` quietly produce a demo database with no released seasons in it.

## Suite setup

`playwright.config.ts` starts the main backend on port 8090 and the loopback local-play bridge on port 8091. The suite uses the bootstrap admin as its operator and creates owners, judges, and spectators as real member accounts through `e2e/support/fixtures.ts`.

Every group project depends on the `season-fixture` setup project, which gives the retained Playground season its local settings before any journey creates activity. Playwright runs a setup project once per run rather than once per dependent project, so selecting several groups still pays for it once. Do not pass `--no-deps`: the `play` group asserts against exactly those settings.

Shared helpers stay at `e2e/support/`, and the submission fixtures at `e2e/fixtures/`, so a spec reaches them with `../support/` and `../fixtures/`. Neither moves into a group.

## Manual GitHub OAuth check

GitHub OAuth depends on an external provider, so the frontend Vitest suite covers the button and account-management wiring with mocks. Before releasing a GitHub integration change, run this check against a deployment with `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` configured:

1. Create an email and password user whose email matches the verified primary email of a GitHub account. Sign in with GitHub and confirm the existing user is used, with its status and display name unchanged.
2. Sign in to a different email and password user, open My Profile, and connect a GitHub account with a different verified email. Confirm the account email changes to the GitHub email, the username appears on My Profile and in the account menu, and the old email no longer signs in.
3. Open an agent profile owned by that user and confirm the owner link opens the connected GitHub profile. Confirm leaderboards and recordings do not show the GitHub username.
4. Disconnect GitHub and confirm the username disappears while the changed account email remains. Confirm email and password sign-in still works with that email.
5. Sign in as a GitHub-only user and confirm My Profile does not allow disconnecting the final sign-in method.
6. Confirm that connecting a second GitHub account or a GitHub email already owned by another Game Sandbox user is refused with an inline error.

## A fresh database every run

`e2e/fresh-backend.mjs` starts each backend with a fresh data directory, first deleting the one directory it is launched with. This keeps local runs independent and lets tests use readable, stable names. Sibling directories under `.data/` are left untouched, including the demo snapshot and any manual backup directory a contributor keeps there.

## This data is the demo's fixture

`npm run demo` copies `frontend/e2e/.data/main/` to `demo/` and serves that copy. The e2e suite creates the source data, including recordings, submissions, and real sign-in accounts, so the demo and browser tests exercise the same workflows. After changing the data a journey creates, run `npm run demo -- --rerun-e2e` to rebuild the source fixture before starting the demo.

Only a complete run writes `.data/main/`, and a run has to claim that directory before it can touch it. `playwright.config.ts` defaults to `.data/partial/`, and `scripts/ci.py frontend-e2e` overrides it to `main` only when no narrowing flag is set. Everything else, a `--group` run or a hand-typed `playwright test`, lands in `partial`.

The default has to be the throwaway one because the backend wipes whichever directory it is launched with. If `main` were the default, running a single group would replace a complete fixture with that group's data, and `npm run demo` would then serve it without noticing.

## Naming and shared helpers

Shared identities live in `e2e/support/names.ts` and shared API flows in `e2e/support/api.ts`. Reuse them instead of repeating request and assertion code.

- **Seasons** use short, themed labels without years, such as `Updraft Open` and `Thermals Cup`. Give each test a distinct label: the suite shares one database during a run, so duplicates make assertions ambiguous.
- **Agents** use their owner id as the public handle linked from the leaderboard and as the key in `/agents/<owner>`. Use realistic handles such as `ada-lovelace` and `grace-hopper`. Limit each owner to one test purpose so its profile remains unambiguous.
- **Raters** are active (`normal`) member accounts created by the `as` fixture. The Human Ratings board ranks an agent only after at least three distinct people rate it.

## Adding a test or fixture

- Put the spec in the group whose area it covers, or add a group by creating a directory under `e2e/` and putting a spec in it. That is the whole procedure: a group is any directory holding at least one `*.spec.ts`, and both `playwright.config.ts` and `scripts/ci.py` discover them that way, so neither holds a list to update. `support/` and `fixtures/` are not groups because they hold no specs.
- Tag a test `@slow` when it submits agents and runs a scheduled season. Anything cheaper belongs in the default tier, where contributors will actually run it.
- Prefer the jsdom suite under `frontend/test/`. A browser test earns its place by needing a real container, a real socket, a second browser context, a painted canvas, a real download, or real navigation and cookies. Assertions about text, disabled controls, validation, and markup structure belong in jsdom, where they run in milliseconds.
- Add identities to `support/names.ts` and flows to `support/api.ts`; keep specs declarative.
- A new agent fixture is a folder under `fixtures/submission/` with a `manifest.json` (mirror `good/manifest.json`) and an `agent.py` exposing a callable `Agent` with `reset`/`act`.
- Assert DOM facts such as visible controls, a painted canvas, and board rows. Never assert pixels: font and GPU differences between runners would make the suite unreliable.
- Update the relevant Playwright journeys with any UI change, as [Testing](index.md#browser-end-to-end) requires.
