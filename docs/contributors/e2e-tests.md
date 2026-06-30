# Browser end-to-end tests

The end-to-end suite lives under `frontend/e2e/` and runs Playwright (Chromium) against the **real** backend, which serves the **built** frontend from the same origin — the production path, one server, no proxy. Because the backend launches real session containers, the suite needs a Docker daemon, the same gate as `backend:integration`. It is wired into CI as the `frontend-e2e` job.

For the wider verification matrix and how this job fits the pipeline, see [Testing](test.md). This page is about the suite itself: how to run it, how its data is set up, and the conventions to follow when you add to it.

## Running it

```console
# Full job: build frontend + session image, install Chromium, run the suite.
uv run python scripts/ci.py frontend-e2e

# Just the tests (frontend bundle and session image already built):
npm run e2e --workspace @game-sandbox/frontend

# One spec, from the frontend workspace:
cd frontend && npx playwright test leaderboards-admin.spec.ts
```

The suite runs serially (`workers: 1`, `fullyParallel: false`) so the real containers and the shared database never contend.

## Two backends

`playwright.config.ts` starts two backends from the same built bundle, so the allowlist case has a context where the auto-logged user is _not_ allowlisted:

| Project | Port | Data dir | Allowlist | Local submissions |
| --- | --- | --- | --- | --- |
| `main` | 8090 | `frontend/e2e/.data/main` | `dev-user` + the rating judges | enabled |
| `restricted` | 8091 | `frontend/e2e/.data/restricted` | nobody | disabled |

| Spec | Project | What it covers |
| --- | --- | --- |
| `journey.spec.ts` | main | Live play → pause/resume → stop → replay → pin. |
| `watch.spec.ts` | main | Watch a scripted session; a second context is a controls-less spectator. |
| `submission.spec.ts` | main | The resolve → static → build → load pipeline; a ready agent watched, and a load failure. |
| `leaderboards-admin.spec.ts` | main | Season cards, released history, operator preview, and the full competition arc (below). |
| `hearts.spec.ts` | main | A four-seat render check, a scheduled multi-seat matchup to a released Scoreboard, the watch seat dialog, an on-screen human seat, and per-seat replay attribution (below). |
| `allowlist.spec.ts` | restricted | Hidden entry points and a rejected direct start for a non-allowlisted user. |

## A fresh database every run

Each backend is launched through `e2e/fresh-backend.mjs`, which deletes that server's data directory (its `sandbox.db*` and `recordings/`) **before** starting the backend process, so the backend boots a brand-new database: the flat migration rebuilds the schema and `seedOpenSeasons` recreates the single `Playground` season. The wipe lives in the launch command, not a global-setup hook, because Playwright starts its web servers before global setup — by then the backend already holds the db file open (which on Windows throws `EBUSY`). The web servers use `reuseExistingServer: false`, because a reused backend would still hold the old database — a fresh database means a fresh server.

Two consequences:

- **No timestamped names.** Tests used to suffix `${Date.now()}` onto season labels and owner ids to dodge collisions on a reused database. With a guaranteed-fresh database that is unnecessary, so names can read like real data instead (see below).
- **Slower local re-runs** than reusing a warm backend — the deliberate cost of a clean slate.

In CI the checkout is already clean, so the wipe is a no-op there. Sibling directories under `.data/` (the demo snapshot, any `db-backup-*`) are left untouched.

## This data is the demo's fixture

`npm run demo` (`scripts/demo.py`) does **not** seed its own data — it snapshots `frontend/e2e/.data/main/` into a `demo/` copy and serves that. So the e2e run _is_ the demo's data builder: better-named, more complete e2e data is a better demo. This is why the leaderboards arc populates real agents, an automated scoreboard, human ratings, and rating prompts, and why the names are meaningful.

The demo builds that database only when it is missing, so after changing a spec or the data it produces, force a rebuild with `npm run demo -- --rerun-e2e`: it discards any existing fixture and reruns the suite before launching, regardless of the prior run's result.

## Naming and shared helpers

Shared identities live in `e2e/support/names.ts`; shared API flows in `e2e/support/api.ts`. Reuse them instead of re-deriving fetch-and-assert boilerplate.

- **Seasons** are short, themed, year-free labels (`Updraft Open`, `Thermals Cup`, …). Give each test that declares a season a **distinct** label — the suite shares one database within a run, so a duplicate label makes a label-based assertion ambiguous.
- **Agents** are identified by their **owner id**, which is the public handle the leaderboard links to and the `/agents/<owner>` profile is keyed on. Use real-looking handles (`ada-lovelace`, `grace-hopper`, …). Keep a given owner to one test's purpose so its profile stays unambiguous.
- **Raters** must be on the `main` backend's session allowlist (set in `playwright.config.ts`). An agent needs **≥3 distinct raters** before the Human Ratings board assigns it a rank.

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

`hearts.spec.ts` is the suite's coverage of Hearts, the four-seat, turn-based environment. It exists alongside the flappy specs rather than replacing them: Hearts is a separate environment, so its seasons hold their own per-environment open-submission and open-play windows and never collide with the flappy Playground. The shared `support/api.ts` helpers that name an environment (`declareSeason`, `submitLocal`, `submitReadyAgent`, `activeWindows`) take an environment id that defaults to Flappy Bird, so the flappy specs are unchanged and this spec passes `hearts`.

The first test is a render check: it starts a four-seat, all-Naive session (no human seat, so it runs itself) against the seeded Hearts Playground's open play window and asserts the Hearts renderer paints its `canvas.renderer-canvas`. This is the only place the live Hearts renderer is exercised in a browser; the rest of its coverage is the jsdom scene test.

The second test drives a whole Hearts season, and is what enriches the demo with a populated Hearts Scoreboard. It borrows the Playground's windows (closing them, restoring them in a `finally`), declares the season, and submits the four `examples/hearts/*` reference agents, each a different strategy (`duck`, `moonshot`, `assassin`, `closer`) under its own owner. Because the example folders are diff-only overlays without their own `manifest.json`, the spec stages each agent's `agent.py` into a temp folder with a generated manifest and submits that, so the agents are submitted directly without a compose step. It then configures one match with two submission seats and two Naive seats, runs the workflow from the operator console, and asserts the released Scoreboard ranks all four agents and the Naive baseline. No human ratings are seeded, so it asserts the Human Ratings board's empty state.

That match is the most expensive shape the suite runs: Hearts sets `seat_order_matters`, so two submission seats over four ready agents expand to twelve ordered seatings plus the appended Naive baseline, thirteen real four-seat container games, several of which compose a multi-submission session image first. It carries a correspondingly wide `test.setTimeout`. As with the flappy arc, the cheapest lever if CI time becomes a problem is fewer submitted agents.

The third test drives the multi-seat watch flow through the browser to prove a chosen seed reaches the start payload. It opens the Hearts overview, clicks the Naive row's Watch button to open the seat-assignment dialog (a multi-seat environment opens the dialog rather than starting immediately), checks that all four seat dropdowns default to the Naive baseline, types a chosen seed, and starts. It intercepts the `POST /api/sessions` request and asserts the request body's `seed` equals the chosen value, then asserts the live session's renderer canvas paints. The intercepted request is the authoritative proof the seed rode the wire rather than being defaulted.

The fourth test covers an on-screen human seat. It starts a live human-versus-agents session through the API (the connected `dev-user` controls `player_0`, three Naive agents fill the rest) with a fixed seed whose deal gives `player_0` the 2 of clubs, so the human leads the opening trick where only the 2♣ is legal and every other card is greyed. Because greying is canvas pixels, the assertions are DOM-observable consequences instead: the decision log starts empty, a click on a greyed card (which the renderer never wires clickable) leaves it empty, and a click on the legal 2♣ grows it. The live log attributes every row to the controlled view seat, so the honest signal is the row-count advance rather than a per-row seat label; the human sits at `player_0`, the seed's opening leader and the seat the current host renders as controlled. The clicks map the renderer's fixed 960x720 internal card geometry onto the canvas through its rendered bounding box, so they target real card positions rather than guessing.

The fifth test covers per-seat replay attribution. It submits one example agent under its own owner, plays a scripted four-seat hand (the submitted agent in seat 0, Naive in the rest) to completion through the API, then opens the finalized recording in the replay viewer. It asserts the per-slot attribution line shows all four seats (one reading the owner's-agent label, the rest the Naive agent) and that trick-by-trick playback works, stepping the transport forward and watching the position readout advance. `dev-user` is the default operator, so the replay shows real owner labels rather than the blind-anonymized form a non-operator sees on a playable season.

## Adding a test or fixture

- Add identities to `support/names.ts` and flows to `support/api.ts`; keep specs declarative.
- A new agent fixture is a folder under `fixtures/submission/` with a `manifest.json` (mirror `good/manifest.json`) and an `agent.py` exposing a callable `Agent` with `reset`/`act`.
- Assert DOM facts (controls present, canvas painted, board rows), never pixels — the suite must not flake on font or GPU differences across runners.
- Any UI change that renames text, moves a control, or alters a flow must update both the jsdom tests under `frontend/test/` and the relevant journeys here.
