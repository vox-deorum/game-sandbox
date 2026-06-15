# Stage 6.3: Admin HTTP API and Operator Gating

Status: not started.

Part of [Stage 6](../stage-06-leaderboards.md). This is build-order step 3: the operator-only admin HTTP routes that declare and configure iterations, control the submission window and visibility, trigger and re-run the workflow, inspect status, and stream the running workflow's container logs. These routes are the **stable contract** of the stage. The admin console (step 7) is the primary client, but the same routes are scriptable for headless deploys, which is the agreed "admin HTTP API is the contract" decision. No file-based CLI is built.

## Operator gating

Every route here is gated by the `isOperator(identity)` predicate from step 1, resolved from the Stage 4 identity seam (the mock user in dev, the GitHub handle once OAuth lands). A non-operator gets `403 not_operator` before any work. The gate is a single middleware/guard applied to the `/api/admin/*` prefix, not re-implemented per route, so there is one authorization choke point. The public reads (step 7's Leaderboards view, the environment page) do **not** go through this prefix; they use separate public routes that only ever return `published` iterations, so draft data cannot leak through a public endpoint regardless of caller.

## Routes

Under `/api/admin/`, attributing actions to the resolved operator identity:

- **Declare**: `POST /api/admin/environments/:envId/iterations`: create a `draft`, `closed` iteration for the environment with an initial config (an empty or supplied match design) and `deps_version` defaulted to the current template release. Returns the new iteration. Declaring does not auto-close the previous open iteration; closing and opening are explicit, and the one-open-iteration-per-environment invariant is preserved by the submission-window route.
- **Configure**: `PUT /api/admin/iterations/:id/config`: replace the iteration's `IterationConfig` through the typed codec from step 1, rejecting an unknown key or malformed match design with `400` and a specific reason. Allowed only while the iteration has no runs; once any run exists, return `409 iteration_has_runs` so historical `config_snapshot` rows remain the only source of truth for run execution. Published iterations can still be unpublished or re-published, but their config is immutable after a run.
- **Dependency version**: `PATCH /api/admin/iterations/:id/deps-version`: set `deps_version` before any submissions exist for the iteration and before any run exists. If submissions exist, return `409 iteration_has_submissions`; if runs exist, return `409 iteration_has_runs`. This keeps all submissions in the iteration on one dependency set.
- **Rating prompt**: `PUT /api/admin/iterations/:id/rating-prompt`: set or clear the operator's iteration-wide rating prompt (`setIterationRatingPrompt`, step 1). Unlike config and deps-version, it is editable at any point in the iteration's life, before or after submissions, runs, and publish, because it is display-only human-feedback guidance that never affects workflow execution. The author's per-submission prompt is a participant action and lives on the public/owner side (step 6), not here.
- **Submission window**: `POST /api/admin/iterations/:id/submissions:open` and `:close`: flip `submission_status`. Opening returns `409 open_iteration_exists` if another iteration for the same environment is already open. Closing is what gates the form before a final workflow run.
- **Visibility**: `POST /api/admin/iterations/:id/publish` and `/unpublish`: flip `visibility`, stamping `published_at` on first publish. Publish is the explicit operator action that exposes the boards on the environment page; unpublish pulls them back to operator-only (useful after a bad re-run).
- **Trigger / re-run**: `POST /api/admin/iterations/:id/runs`: create an `iteration_runs` row, snapshotting `config`, `deps_version`, and `requested_by`, then hand it to the workflow runner (step 4), returning the run id immediately. The run executes in the background, like the Stage 5 validation worker; the route never blocks on containers. A second call is the re-run: it starts a fresh run that, on completion, replaces the board. The route refuses to start a run when one is already `running` for the iteration (`409 run_in_progress`) so two concurrent runs cannot interleave on the single host.
- **Cancel**: `POST /api/admin/iterations/:id/runs/:runId:cancel`: request cancellation of an in-progress run; the runner stops scheduling further games and marks the run `cancelled` (step 4 owns the cooperative stop).
- **Status**: `GET /api/admin/iterations/:id`: the full admin view, including config, both lifecycle axes, the latest run with its per-game statuses and any errors, and the computed boards even while `draft`. `GET /api/admin/environments/:envId/iterations` lists all iterations including drafts for the history/console picker.
- **Log stream**: `GET /api/admin/iterations/:id/runs/:runId/logs/ws`: a WebSocket endpoint matching the app's existing session-streaming transport. It emits the running workflow's per-match container log lines and game-status transitions as they happen, then sends a terminal event and closes when the run reaches a terminal state. A late subscriber gets the buffered log-so-far then live tail, so opening the console mid-run is not blank. The runner (step 4) is the producer; this route is the subscriber-facing seam.

## Public routes

Public board and history reads are separate from `/api/admin/*` and filter out drafts at the route boundary:

- `GET /api/environments/:envId/iterations`: list published iterations for the environment, newest first, for history links.
- `GET /api/environments/:envId/leaderboards`: return the current published iteration and both boards, or an empty current-board payload when nothing is published yet.
- `GET /api/environments/:envId/iterations/:iterationId/leaderboards`: return both boards for a specific published iteration; return `404` for drafts or unknown iterations.
- `GET /api/environments/:envId/agents/:ownerId/placements`: return automated placements for the agent profile, including the Naive-free submitted-agent rows only.

## Background execution and the runner seam

Triggering a run must not block the HTTP request on Docker, exactly as Stage 5's submit route does not block on the validation pipeline. The route creates the `pending` run row with immutable config/deps snapshots, enqueues it on the in-process workflow runner (step 4), and returns. The runner drives the run to a terminal state, writing `iteration_run_games`/`game_results` and emitting log events the WebSocket route relays. On backend startup, any run left `running` by a process death is reconciled to `failed` (a partial leaderboard run is not silently resumed; the operator re-runs), mirroring Stage 5's startup recovery posture but choosing fail-closed for the heavier workflow.

## Tests

Backend Vitest with a fake/stub runner and `:memory:` storage, no Docker:

- Every `/api/admin/*` route returns `403 not_operator` for a non-operator identity and proceeds for an operator; the dev mock user is an operator.
- Declare creates a `draft`, `closed` iteration with the current `deps_version`; configure round-trips a valid `IterationConfig` and `400`s an invalid one with a specific reason.
- Updating config after a run returns `409 iteration_has_runs`; updating `deps_version` after a submission returns `409 iteration_has_submissions`; updating `deps_version` after a run returns `409 iteration_has_runs`; setting the rating prompt succeeds even after a run exists (it is not gated by the immutability rules).
- Open/close flips `submission_status`, opening while another iteration is open returns `409 open_iteration_exists`, and publish/unpublish flips `visibility` and stamps `published_at` once; the public iteration and leaderboard reads never return a `draft`.
- Triggering a run snapshots config/deps/requested_by, creates a run row, and returns its id without invoking Docker inline (the stubbed runner records the enqueue); a second trigger while a run is `running` returns `409 run_in_progress`; cancel marks the run `cancelled` through the runner stub.
- The status route returns the admin view including a draft's boards; the list route includes drafts for operators.
- The public history and leaderboard routes return only published iterations and `404` a draft-specific board read.
- The WebSocket log-stream route relays the stub runner's emitted lines to a subscriber and closes on terminal status; a subscriber attaching after some lines were emitted receives the buffered backlog then the tail.
- Startup reconciles a leftover `running` run to `failed`.

The Docker-backed end-to-end of an actual run is covered by step 4; this step's tests use a stub runner so the routes, gating, and streaming are proven Docker-free.

## Done when

An operator can, over HTTP, declare and configure a closed draft iteration, explicitly open or close its submissions under the one-open invariant, trigger and re-run its workflow (non-blocking, with a `409` against concurrent runs), publish and unpublish it, inspect its full status, and subscribe to a run's live WebSocket log stream. Public routes expose only published history and boards. The runner itself is a stub here; step 4 makes the trigger actually launch containers.
