# Stage 6.8: Testing, CI, and Docs

Status: in progress. The step-level Docker-free suites are in place, and the Stage 6.7 browser journeys now cover released Leaderboards history and the operator console's live run log. The rating browser journey, Docker-gated leaderboard workflow coverage, CI wiring audit, and final documentation pass remain.

Part of [Stage 6](../stage-06-leaderboards.md). This is the cross-cutting companion to build-order steps 1-7, mirroring [Stage 5.7](../stage-05/7-testing-ci-and-docs.md). It does three things. It pulls the per-step test obligations into one suite picture. It slots the Docker-gated workflow path into CI, the same way the Stage 5 build/load leg already is. And it updates the spec, plan, and contributor docs that the direction change touches. This is not a separate phase done at the end. Each step lands its own tests. This file tracks the whole-stage coverage and the doc/CI obligations so nothing falls between steps.

## Test layers

Each step owns its tests (restated here as the coverage contract):

- **Docker-free backend (Vitest, `:memory:`, FakeDriver):**
  - Storage (step 1): the fresh-build schema bootstrap, the season indexes, the one-open-submission invariant, the one-play-open invariant, the config codec (including zero-slot and non-positive-game rejection), session season attribution, trigger-time roster and schedule snapshots, concrete agent refs, automated placements, ratings, both rating prompts (the operator prompt editable after a run, the author prompt surviving resubmission), protected leaderboard recordings, and the operator predicate.
  - Scheduler (step 2): exact `games` semantics, seed round-robin, determinism, edge cases, and rejection of typed zero-slot, empty-seed, non-positive-game, and multi-submission-seat inputs.
  - Admin API, gating, and WebSocket log-stream relay against a stub runner (step 3): public release filtering, separate submit/play targets, `open_season_exists`, `open_play_season_exists`, `empty_schedule`, the force-confirmed destructive config/deps edit, the always-editable rating-prompt route, and `is_operator`.
  - The runner's logic against canned recordings (step 4): execution from persisted games, result aggregation from total `decision_ms + learn_ms` plus acted tick count, the attributable failure rule, the infrastructure failure rule, cancel, and re-run supersession.
  - Weighted board math and retention policy (step 5).
  - Ratings rules, prompts, and the human board including Naive (step 6): server-side own-agent resolution, null-session rejection, unfinished-session rejection, and play-closed write rejection.
- **Docker-free frontend (Vitest, jsdom, mocked fetch):** cover the following (steps 6, 7). The Leaderboards view and history. Separate open submission and play targets on the environment page. Profile placements. The post-session rating UI, including Naive, own-agent exclusion, the play-closed read-only state, and the two prompts rendered next to the right agents. The agent-profile author-prompt editor. The operator console, including the WebSocket log view, the season rating-prompt field, one-open-submission and one-play-open conflict handling, empty-schedule handling, the force-confirmation dialog for destructive config/deps edits, and operator-only gating. Follows the Stage 4/5 no-canvas, no-network pattern.
- **Docker-gated end-to-end (the real Stage 3 driver, gated exactly like the Stage 5.4 build/load tests so the default `npm test` stays Docker-free):** run a small Flappy Bird season with the worked example as a submission, plus the Naive baseline, across two seeds. Trigger it through the runner. It should produce one recording per game and a board. A deterministic example should also reproduce identical scores across two runs (the stage's reproducibility exit criterion). This reuses the Stage 5 Docker harness; it does not stand up new container infrastructure.
- **Frontend browser end-to-end (Playwright through `uv run python scripts/ci.py frontend-e2e`):** add journeys for the released Leaderboards view, history navigation, the rating UI after a watch/play session, and the operator console log stream. Use mocked or seeded backend data as the existing e2e harness allows. This is required for UI work per [AGENTS.md](../../agents.md), and it catches live DOM locator regressions that jsdom cannot.

The full-suite expectation matches the Stage 5 posture. Both `npm run check` gates (backend, frontend) stay clean. The Docker-free suites run in normal CI. The frontend e2e suite is updated and run for UI changes. The Docker-gated leaderboard e2e runs in the same gated lane as the Stage 5 build/load e2e.

## CI

Extend the existing CI definition (the Stage 1 [testing-and-ci](../stage-01/testing-and-ci.md) lanes, as Stage 5 extended them) so that: the new backend and frontend Docker-free suites run on every change; the frontend e2e suite includes the Stage 6 journeys; the Docker-gated leaderboard e2e joins the existing gated lane rather than a new workflow; and lint/type-check cover the new backend modules (admin routes, runner, scheduler, board/rating services) and frontend pages/components. This introduces no new CI concept. It is additive to the lanes Stage 5 left.

## Docs

The direction change in this stage (config-file-plus-CLI to admin UI) touches more than the plan, so the doc work is part of the stage, per [the plan governance](../README.md):

- **Specs (the higher authority):** [leaderboard.md](../../docs/specs/leaderboard.md) and [frontend.md](../../docs/specs/frontend.md) already describe several things: the operator admin UI model, the three season gates (submission, play, release), the two rating prompts (operator season prompt + author per-submission prompt), and the agent-compute timing column (which now states it includes the `learn`/`chat`/LLM-wait time the spec always counted). Keep them aligned if implementation changes any visible product behavior. This matters most for season release status, public play status, ratings of the Naive baseline, the rating prompts, and the public Leaderboards page.
- **Plan:** the [plans README stage overview](../README.md) line for Stage 6 already says "admin UI". Keep it aligned with the parent stage and subplans, especially the one-open-submission invariant, the one-play-open invariant, and submission-closed/play-closed-by-default declared seasons.
- **Contributor docs:** an operator-facing how-to may exist or be expected (declaring a season, designing matches, triggering a run, releasing results). If so, add a short operator guide under `docs/` describing the admin console flow, and replace any CLI-oriented text. The participant-facing submission docs are unchanged.
- **Stage status lines:** flip the Stage 6 parent and each subplan's status from "not started" through "in progress"/"done" as work lands. This is the same discipline Stage 5 followed.

## Done when

Every step's tests are green in the Docker-free suites. The frontend e2e journeys pass. The Docker-gated leaderboard e2e passes in its lane. Both `npm run check` gates are clean. CI runs the new suites in the right lanes. The spec, plan overview, and contributor docs all describe the admin-UI model, with no lingering reference to a leaderboard configuration file or CLI. At that point the Stage 6 parent's "Done when" is demonstrable end to end, and the stage status flips to done.
