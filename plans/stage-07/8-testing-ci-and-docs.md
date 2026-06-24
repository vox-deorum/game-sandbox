# Stage 7.8: Testing, CI, and Docs

Status: not started.

Part of [Stage 7](../stage-07-multi-agent.md). This is the cross-cutting companion to build-order steps 1 through 7, mirroring [Stage 5.7](../stage-05/7-testing-ci-and-docs.md) and [Stage 6.8](../stage-06/8-testing-ci-and-docs.md). It does three things. It pulls the per-step test obligations into one coverage picture. It slots the Docker-gated multi-agent Hearts path into CI, the same gated lane the Stage 5 build and load and the Stage 6 leaderboard e2e already use. And it updates the plan, spec, and contributor docs the stage touches. This is not a separate phase done at the end. Each step lands its own tests; this file tracks the whole-stage coverage and the doc and CI obligations so nothing falls between steps.

## Test layers

Each step owns its tests, restated here as the coverage contract:

- **Docker-free Python (environments package):** the Hearts rules engine, first-trick restrictions, hearts-broken gating, the legal-move set, native penalty scoring, the shoot-the-moon flip, the normalized leaderboard score, and `to_json()` carrying `seat_order_matters: true` (step 1). The template generation sync check and the local example play-through (step 2).
- **Docker-free backend (Vitest, in-memory storage, fake driver):** the scheduler's `P(N, K)` ordered versus `C(N, K)` unordered expansion, the `K = 1` reduction to the Stage 6 schedule, `N < K` baseline-only, determinism, and the worked 26-game and 12-plus-2 counts (step 3). The breaking `slots` start contract: rejection of missing, incompatible, inactive, and wrong-environment slot assignments, and the rule that submitted slots create `session_submissions` rows while built-in and human slots appear only in the recording header `players` (step 4).
- **Docker-free frontend (Vitest, jsdom, mocked fetch, no canvas):** the watch dialog preselection and the disabled Start until every required seat is assigned, the slot-assignment payload shape, and per-agent rating attribution in a shared session (step 6). The Hearts `computeScene` greying, per-slot penalty scores, and replay rendering (step 7).
- **Docker-gated end-to-end (the real Stage 3 driver, gated exactly like the Stage 5 build and load tests so the default test run stays Docker-free):** multi-slot Hearts stepping with per-slot timeouts, two submissions that both ship an `agent` module running in one session without import collision, and a human-slot timeout auto-playing a legal move (step 5). Plus the full stage journey below.
- **Frontend browser end-to-end (Playwright through `uv run python scripts/ci.py frontend-e2e`):** start a multi-agent Hearts watch session from the dialog with all seats assigned and a chosen seed reaching the start payload, then open the replay. This is required for UI work and catches live DOM regressions jsdom cannot.

## The stage journey

The Docker-gated end-to-end path starts a multi-agent Hearts watch session from the dialog and replays it with per-seat attribution. Two different submissions play a full game of Hearts against each other, all seats assigned and a chosen seed reaching the session start payload. One connected human takes a slot against three submissions using the on-screen card UI with illegal cards greyed out, and the human-slot timeout auto-plays a legal move when that slot stalls. A leaderboard season over Hearts produces both boards, with lower native penalties ranked through higher normalized leaderboard scores. The replay renders trick-by-trick turns and per-slot penalty scores correctly. The tests prove the breaking start-shape replacement rather than compatibility with the old one.

## CI

Extend the existing CI definition (the Stage 1 [testing and CI](../stage-01/testing-and-ci.md) lanes, as Stages 5 and 6 extended them) so that the new Python, backend, and frontend Docker-free suites run on every change; the frontend e2e suite includes the Stage 7 Hearts journey; the Docker-gated multi-agent Hearts e2e joins the existing gated lane rather than a new workflow; and lint and type-check cover the new modules. This introduces no new CI concept. It is additive to the lanes Stages 5 and 6 left.

## Docs

- **Specs:** the stage already references [environment.md](../../docs/specs/environment.md), [interaction.md](../../docs/specs/interaction.md), [frontend.md](../../docs/specs/frontend.md), [execution.md](../../docs/specs/execution.md), and [leaderboard.md](../../docs/specs/leaderboard.md). Keep them aligned if implementation changes visible product behavior, especially the unpaced multi-slot loop, on-screen input, the multi-submission session image, and the `slots` start shape.
- **Plan:** keep the [plans README stage overview](../README.md) Stage 7 line aligned with the parent stage and subplans.
- **Contributor docs:** update the [examples and template guide](../../docs/contributors/examples-and-template.md) and any environment or execution contributor docs that the Hearts environment, the multi-submission image, or the multi-slot loop touch.
- **Stage status lines:** flip the Stage 7 parent and each subplan's status from "not started" through "in progress" and "done" as work lands, the same discipline Stages 5 and 6 followed.
- Run `uv run python scripts/ci.py docs` (the strict documentation build) as the doc gate.

## Done when

Every step's tests are green in the Docker-free suites. The frontend e2e Hearts journey passes. The Docker-gated multi-agent Hearts e2e passes in its lane. Both `npm run check` gates are clean. CI runs the new suites in the right lanes. The spec, plan overview, and contributor docs all describe the multi-agent Hearts model and the `slots` start shape, and the strict docs build passes. At that point the Stage 7 parent's "Done when" is demonstrable end to end, and the stage status flips to done.
