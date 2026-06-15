# Stage 6.7: Frontend, Leaderboards and Admin Console

Status: not started.

Part of [Stage 6](../stage-06-leaderboards.md). This is build-order step 7: the user-facing surfaces. Two distinct audiences, one subplan because they share the same API client and design primitives: the **public Leaderboards** view (both boards, history, profile placements, board-row replays) and the **operator admin console** (declare/configure/open/close/publish, trigger/re-run with a live log stream). Built on the Stage 4.5 design system and vue-router setup (`frontend/src/main.ts`, plain library-mode router).

## Public: Leaderboards on the environment page

Per [frontend.md](../../docs/specs/frontend.md), the environment page shows the two leaderboards for the current iteration side by side, with links to historical iterations.

- **Both boards side by side** for the environment's current **published** iteration: the automated board (rank, agent, mean normalized score, mean agent compute time as its own column, failure indicator, a "Replay" link per row to the Stage 4 replay viewer) and the human-feedback board (rank, agent, mean rating, count; under-three-ratings agents shown unranked). The two never merge into one number, mirroring the spec.
- **History.** Links to historical published iterations; selecting one shows that iteration's boards (read-only). A dedicated per-environment, per-iteration **Leaderboards page/route** (the spec's "Leaderboards" page) hosts the full side-by-side view and is linkable by URL with the iteration id, so a specific iteration's boards are shareable. The environment page embeds the current iteration's boards and links into this page for history.
- **Agent profile placements.** The agent profile page (Stage 5.6) replaces its Stage 6 placeholder with real **leaderboard placements**: the agent's rank, mean score, and mean agent compute time per iteration it competed in, read from the public placements route (step 3/5), each linking to that iteration's Leaderboards view.
- **Board-row replays.** Each automated-board row deep-links the representative recording (step 5) through the existing replay route, so the spec's "replays linked from board rows" works against the Stage 4 viewer with no new player.
- All public reads hit the public (non-`/admin`) routes from step 3, which only return published iterations, so a draft never appears here.

New routes added to `frontend/src/main.ts`: a Leaderboards route (e.g. `/environments/:envId/leaderboards/:iterationId?`, defaulting to the current published iteration). The renderer/registry imports are unchanged.

## Operator: admin console

A new operator-only console driving the step-3 admin API. Gated in the UI by the `me` answer (the app already fetches `GET /api/me` once via `me.ts`; extend it to report `is_operator` from the step-1 predicate) so the console route and its nav entry render only for operators; the backend gate (step 3) is the real authority, the UI gate is just to avoid showing dead controls.

- **Iteration management.** List the environment's iterations (including drafts), declare a new one, edit its pre-run config: the **match design** (add match configurations, set each one's slot composition of `builtin-naive`/`submission` seats, seeds, and game count), the deps_version (defaulted, overridable only before submissions and runs), and the override blocks (timeouts active; messaging/LLM fields present but labeled "applies in Stage 8/9"). Declaring creates a `draft`, `closed` iteration, so the console should show the operator that opening submissions is a separate action. Built on the Stage 4.5 form primitives (`UiField`/`UiInput`/`UiButton`, status badges, dialogs, and existing layout patterns).
- **Lifecycle controls.** Open/close submissions, publish/unpublish: each a clear button reflecting the two independent axes, with the current state shown (a draft badge, an open/closed badge). Opening handles `409 open_iteration_exists` with a direct message that another iteration is already accepting submissions. Publishing a draft is the action that exposes it on the environment page.
- **Iteration rating prompt.** A small always-editable text field for the operator's iteration-wide rating prompt (the step-3 rating-prompt route), separate from the match-design config editor because it stays editable after runs and publish. The console makes clear this prompt is shown to human raters for every agent and is distinct from each author's own per-agent prompt (set on the agent profile, step 6).
- **Run controls and live log stream.** Trigger the workflow and re-run it; while a run is in progress, a **live log view** subscribes to the step-3 WebSocket log-stream endpoint (reusing the Stage 3 socket conventions where practical) and shows the per-match container lines and per-game status as they arrive, with the buffered backlog on attach so opening mid-run is not blank. A `409 run_in_progress` is surfaced as "a run is already in progress." Cancel is offered for an in-flight run. After completion the console shows the computed boards (a draft's boards are visible here before publish, the verify-before-expose flow).
- **Verify-before-publish.** The console renders the draft iteration's boards (admin board read) so the operator inspects the automated and human boards privately, then publishes. A re-run recomputes them in place; publish/unpublish controls whether the environment page sees them.

New admin route(s) in `frontend/src/main.ts` (e.g. `/environments/:envId/admin`), rendered only when `me.is_operator` is true. New typed client wrappers for `/api/me`'s `is_operator`, the public board/history/placements endpoints, the rating endpoints, and the admin endpoints live in `frontend/src/api/client.ts`, following the existing wrapper style.

## Tests

Frontend Vitest (jsdom, mocked fetch), following the Stage 4/5 unit pattern:

- The public Leaderboards view renders both boards from mocked data side by side, with mean agent compute time as its own column, the Naive baseline row, a per-row replay link, and the human board's three-ratings ranking with under-threshold agents unranked; a draft iteration is never fetched/shown on the public path.
- History links navigate between published iterations and the Leaderboards route resolves a specific iteration by URL.
- The agent profile shows real placements per iteration linking to the right Leaderboards view (replacing the Stage 5 placeholder).
- The admin console route and nav entry render only when `me.is_operator`; declaring creates a closed draft; editing the match design and deps version handles immutable-after-submission/run conflicts; the iteration rating-prompt field saves and stays editable after a run; opening handles `open_iteration_exists`; lifecycle/publish controls call the right admin endpoints; triggering a run subscribes to the WebSocket log stream and renders streamed lines plus the backlog; a `409 run_in_progress` surfaces the in-progress message; a draft's boards render in the console before publish.

## Done when

The environment page shows the current published iteration's two boards side by side with per-row replays and links to historical iterations; the Leaderboards page is URL-linkable per iteration; agent profiles show real placements. The operator console lets an operator declare and configure a closed draft iteration's match design, set the iteration's always-editable rating prompt, open/close submissions under the one-open invariant, trigger and re-run the workflow while watching its container logs stream live over WebSocket, inspect the draft boards, and publish, completing the full operator-driven competition cycle the stage's "Done when" describes, with non-operators seeing none of it.
