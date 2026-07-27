# Browser end-to-end tests

The end-to-end suite lives under `frontend/e2e/`. It runs Playwright with Chromium against the real backend, which serves the built frontend from the same origin. This follows the production path: one server with no proxy. Because the backend launches real session containers, the suite requires a Docker daemon, as does `backend:integration`. The Docker-heavy `frontend-e2e` job is too slow for every push, so it has its own manually dispatched workflow at `.github/workflows/e2e.yml`. Run it from the Actions tab with **Run workflow** when a UI change warrants it.

For the wider verification matrix and how this job fits the pipeline, see [Testing](index.md). This page is about the suite itself: how to run it, how its data is set up, and the conventions to follow when you add to it.

## Running it

```console
# Full job: build frontend + session image, install Chromium, run the suite.
uv run python scripts/ci.py frontend-e2e

# Rebuild both frontend bundles and run the tests (session image already built):
npm run e2e --workspace @game-sandbox/frontend

# Rebuild both frontend bundles and run one spec:
npm run e2e --workspace @game-sandbox/frontend -- leaderboards-admin.spec.ts
```

The suite runs serially (`workers: 1`, `fullyParallel: false`) so the real containers and the shared database never contend.

## One backend, real accounts

`playwright.config.ts` starts two web servers: the `main` backend on port 8090, with `AUTH_ALLOW_INSECURE_DEFAULTS` and local submissions enabled, and the loopback local-play bridge (`e2e/local-play-bridge.py` on port 8091) that serves the standalone local bundle for `local-play.spec.ts`. Identity on the main backend is a Better Auth session cookie, minted by the suite's own fixtures rather than varied per server:

- The bootstrap admin (`admin@example.com` / `admin-dev-password`) is the operator. `e2e/support/auth.ts` holds these credentials, and the `admin` fixture in `e2e/support/fixtures.ts` signs in as this account.
- The fixtures create owners, judges, and spectators as real member accounts instead of varying server configuration. On first use, the `as(handle)` factory in `e2e/support/fixtures.ts` creates a member through the admin roster endpoint and returns a context signed in as that account. A spec can then compose a flow by choosing the appropriate signed-in context.

| Spec | Project | What it covers |
| --- | --- | --- |
| `journey.spec.ts` | main | Live play → pause/resume → stop → replay → pin. |
| `watch.spec.ts` | main | Watch a scripted session; a second context is a controls-less spectator. |
| `submission.spec.ts` | main | The resolve → static → build → load pipeline; a ready agent watched, and a load failure. |
| `leaderboards-admin.spec.ts` | main | Season cards, released history, operator preview, and the full competition arc (below). |
| `hearts.spec.ts` | main | A four-player render check, a mixed LLM and non-LLM scheduled matchup to a released Scoreboard, development-key and telemetry privacy journeys, the watch seat dialog, an on-screen human seat, and per-player replay attribution (below). |
| `spades.spec.ts` | main | Messaging controls and their disabled override, plus a three-agent partnership matchup to a released Scoreboard (below). |
| `auth.spec.ts` | main | Three authentication journeys: the admin signs in, sees the admin navigation, and signs out; the admin creates a user who then signs in and participates; a pending user is gated, an admin approves them on the Users page, and the controls unlock. |
| `local-play.spec.ts` | main | The standalone local bundle against the loopback bridge: a scripted run plus canvas device-pixel-ratio and resize behavior. |

## Manual GitHub OAuth check

GitHub OAuth depends on an external provider, so the frontend Vitest suite covers the button and account-management wiring with mocks. Before releasing a GitHub integration change, run this check against a deployment with `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` configured:

1. Create an email and password user whose email matches the verified primary email of a GitHub account. Sign in with GitHub and confirm the existing user is used, with its status and display name unchanged.
2. Sign in to a different email and password user, open My Profile, and connect a GitHub account with a different verified email. Confirm the account email changes to the GitHub email, the username appears on My Profile and in the account menu, and the old email no longer signs in.
3. Open an agent profile owned by that user and confirm the owner link opens the connected GitHub profile. Confirm leaderboards and recordings do not show the GitHub username.
4. Disconnect GitHub and confirm the username disappears while the changed account email remains. Confirm email and password sign-in still works with that email.
5. Sign in as a GitHub-only user and confirm My Profile does not allow disconnecting the final sign-in method.
6. Confirm that connecting a second GitHub account or a GitHub email already owned by another Game Sandbox user is refused with an inline error.

## A fresh database every run

`e2e/fresh-backend.mjs` launches each backend. Before starting the process, it deletes that server's data directory, including `sandbox.db*` and `recordings/`. The backend then creates a new database: the flat migration rebuilds the schema, and `seedOpenSeasons` recreates the single `Playground` season. This cleanup belongs in the launch command because Playwright starts web servers before its global setup hook. By the time global setup runs, the backend already holds the database file open, which causes `EBUSY` on Windows. The web servers set `reuseExistingServer: false` because a fresh database also requires a fresh server.

Two consequences:

- **No timestamped names.** A new database prevents collisions, so season labels and owner ids can use readable names without a `${Date.now()}` suffix.
- **Slower local reruns.** Starting a fresh backend takes longer than reusing a warm one, but guarantees a clean state.

In CI the checkout is already clean, so the wipe is a no-op there. Sibling directories under `.data/` (the demo snapshot, any `db-backup-*`) are left untouched.

## This data is the demo's fixture

`npm run demo` (`scripts/demo.py`) does not seed its own data. It copies the complete `frontend/e2e/.data/main/` tree to `demo/` and serves the copy. The database, recordings, submission archives, and LLM telemetry move together, keeping replay and download sidecars attached to their database rows. The e2e suite therefore builds the demo data. Its leaderboard journeys create meaningful names, real agents, automated scoreboards, human ratings, model usage, and rating prompts. The copied database also contains the Better Auth accounts created by the fixtures, so demo users sign in through the real `/login` page instead of using mocked identity. These accounts include the bootstrap admin and `ada-lovelace`.

The demo builds that database only when it is missing, so after changing a spec or the data it produces, force a rebuild with `npm run demo -- --rerun-e2e`: it discards any existing fixture and reruns the suite before launching, regardless of the prior run's result.

## Naming and shared helpers

Shared identities live in `e2e/support/names.ts`, and shared API flows live in `e2e/support/api.ts`. Reuse them instead of repeating request and assertion code.

- **Seasons** use short, themed labels without years, such as `Updraft Open` and `Thermals Cup`. Give each test a distinct season label because the suite shares one database during a run, making duplicate labels ambiguous in assertions.
- **Agents** use their owner id as the public handle linked from the leaderboard and as the key in `/agents/<owner>`. Use realistic handles such as `ada-lovelace` and `grace-hopper`. Limit each owner to one test purpose so its profile remains unambiguous.
- **Raters** are active (`normal`) member accounts created by the `as` fixture. The Human Ratings board ranks an agent only after at least three distinct people rate it.

## The competition arc

The last test in `leaderboards-admin.spec.ts` drives a whole season against real data, and is the richest fixture the demo serves. In order, it:

1. Borrows the env's single open submission/play windows from the seeded `Playground` season (closing them there, restoring them in a `finally`), and declares the `Updraft Open` season.
2. Submits three agents with distinct flight behaviours (`fixtures/submission/{glider,flapper,good}`) under three owners, and waits for each to build to `ready`.
3. Sets the operator's season rating prompt and one agent author's prompt.
4. Configures a one-submission-seat match and runs the automated workflow from the operator console, tailing the live log to completion (the scheduler runs each ready agent and appends a Naive baseline).
5. Opens the play window, then seeds each agent's ratings from all four judges over finished watch sessions, with one rating also driven through the post-session panel in the browser.
6. Releases the season and asserts the public boards: a populated Scoreboard and a fully ranked Human Ratings board.

Because it does several real builds plus a multi-agent run, it carries a wide `test.setTimeout`. If CI time becomes a problem, the cheapest lever is fewer submitted agents (two still produce a ranking).

## Hearts: example agents and a scheduled matchup

`hearts.spec.ts` covers Hearts, a four-player, turn-based environment with its own seasons and per-environment windows, so it cannot collide with the Flappy Bird `Playground` season. The shared `support/api.ts` helpers default to Flappy Bird; the Hearts spec passes `hearts` explicitly.

Its tests, in order: a render check that an all-Naive session paints `canvas.renderer-canvas` (the only browser test for the live Hearts renderer; a jsdom scene test provides the rest), the season journey below, a seat-assignment dialog check that proves a chosen seed reaches the intercepted `POST /api/sessions` body, an on-screen human seat that plays a fixed-seed opening trick through canvas clicks and asserts decision-log growth instead of pixels, and a per-player replay attribution check over a finished four-player recording viewed as the operator.

The season journey is what enriches the demo with a populated Hearts Scoreboard. It submits Oracle plus one non-LLM strategy under distinct owners, reading only `agent.py` from the checked-in `oracle`, `moonshot`, and `duck` example directories: a staging helper hand-assembles each temporary submission from that file plus the checked-in base, harness, and template files, never composed output or published branches, so publication selection does not gate this coverage. The season enables the local OpenAI-compatible stub's `small` alias (launched by `fresh-backend.mjs`, no external service or credential), exercises development credentials, runs one match design with two submission seats and two Naive seats, and asserts the released Scoreboard, model usage for Oracle only, and telemetry privacy in Oracle's workflow replay. Hearts sets `seat_order_matters`, so two submission seats expand to both ordered seatings plus the appended Naive baseline: three real four-seat container games, the minimum roster that proves expansion and produces a real ranking.

## Spades: example agents, messaging, and a partnership matchup

`spades.spec.ts` covers the four-player partnership environment. It verifies the browser chat controls while messaging is enabled and confirms that a season override removes both the composer and the read-only log. Its season journey stages `agent.py` from the checked-in `counter`, `daredevil`, and `signaler` example directories through the same staging helper as Hearts, submits the three agents under separate owners, schedules partnership games with two submission seats and two Naive seats, then releases the season and checks the Scoreboard and empty Human Ratings board.

## Adding a test or fixture

- Add identities to `support/names.ts` and flows to `support/api.ts`; keep specs declarative.
- A new agent fixture is a folder under `fixtures/submission/` with a `manifest.json` (mirror `good/manifest.json`) and an `agent.py` exposing a callable `Agent` with `reset`/`act`.
- Assert DOM facts such as visible controls, a painted canvas, and board rows. Never assert pixels because font and GPU differences between runners would make the suite unreliable.
- Update the journeys here with any UI change, as [Testing](index.md#browser-end-to-end) requires.
