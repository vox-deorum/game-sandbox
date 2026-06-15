# Stage 6.8: Testing, CI, and Docs

Status: not started.

Part of [Stage 6](../stage-06-leaderboards.md). This is the cross-cutting companion to build-order steps 1–7, mirroring [Stage 5.7](../stage-05/7-testing-ci-and-docs.md): it pulls the per-step test obligations into one suite picture, slots the Docker-gated workflow path into CI the way the Stage 5 build/load leg already is, and updates the spec/plan/contributor docs the direction change touches. It is not a separate phase done at the end — each step lands its own tests; this file is where the whole-stage coverage and the doc/CI obligations are tracked so nothing falls between steps.

## Test layers

Each step owns its tests (restated here as the coverage contract):

- **Docker-free backend (Vitest, `:memory:`, FakeDriver):** storage (step 1 — migration, config codec, two-axis lifecycle, runs/games/results, ratings, operator predicate), scheduler (step 2 — balanced expansion, determinism, edge cases), admin API + gating + log-stream relay against a stub runner (step 3), the runner's logic against canned recordings (step 4 — scheduling, result aggregation, failing-agent rule, cancel, re-run supersession), board math + retention policy (step 5), ratings rules + human board (step 6).
- **Docker-free frontend (Vitest, jsdom, mocked fetch):** the Leaderboards view and history, profile placements, the post-session rating UI, and the operator console including the streamed log view and operator-only gating (steps 6, 7). Follows the Stage 4/5 no-canvas, no-network pattern.
- **Docker-gated end-to-end (the real Stage 3 driver, gated exactly like the Stage 5.4 build/load tests so the default `npm test` stays Docker-free):** a small Flappy Bird iteration with the worked example as a submission plus the Naive baseline, two seeds, triggered through the runner, produces a recording per game and a board, and a deterministic example reproduces identical scores across two runs (the stage's reproducibility exit criterion). This reuses the Stage 5 Docker harness; it does not stand up new container infrastructure.

The full-suite expectation matches the Stage 5 posture: both `npm run check` gates (backend, frontend) stay clean, the Docker-free suites run in normal CI, and the Docker-gated leaderboard e2e runs in the same gated lane as the Stage 5 build/load e2e.

## CI

Extend the existing CI definition (the Stage 1 [testing-and-ci](../stage-01/testing-and-ci.md) lanes, as Stage 5 extended them) so: the new backend and frontend Docker-free suites run on every change; the Docker-gated leaderboard e2e joins the existing gated lane rather than a new workflow; and lint/type-check cover the new backend modules (admin routes, runner, scheduler, board/rating services) and frontend pages/components. No new CI concept is introduced — this is additive to the lanes Stage 5 left.

## Docs

The direction change in this stage (config-file-plus-CLI → admin UI) touches more than the plan, so the doc work is part of the stage, per [the plan governance](../README.md):

- **Specs (the higher authority, revised in this change set):** [leaderboard.md](../../docs/specs/leaderboard.md) — replace the "configuration file and CLI … no admin UI" model with the operator admin UI, the admin HTTP API contract, iteration visibility (draft/published), and re-runs; keep the boards, normalization, sequential-host, and per-container rules intact. [frontend.md](../../docs/specs/frontend.md) — add the operator admin console to the pages list and note operator gating; the Leaderboards page and feedback sections already match. These edits land with this stage, and the plan parent already records the change prominently.
- **Plan:** the [plans README stage overview](../README.md) line for Stage 6 is updated to say "admin UI" rather than "operator CLI," so the overview and the stage file agree.
- **Contributor docs:** if an operator-facing how-to exists or is expected (declaring an iteration, designing matches, triggering a run, publishing), add a short operator guide under `docs/` describing the admin console flow, replacing any CLI-oriented text. The participant-facing submission docs are unchanged.
- **Stage status lines:** flip the Stage 6 parent and each subplan's status from "not started" through "in progress"/"done" as work lands, the same discipline Stage 5 followed.

## Done when

Every step's tests are green in the Docker-free suites and the Docker-gated leaderboard e2e passes in its lane; both `npm run check` gates are clean; CI runs the new suites in the right lanes; and the spec, plan overview, and contributor docs all describe the admin-UI model with no lingering reference to a leaderboard configuration file or CLI. At that point the Stage 6 parent's "Done when" is demonstrable end to end and the stage status flips to done. </content>
