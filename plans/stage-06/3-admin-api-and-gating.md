# Stage 6.3: Admin HTTP API and Operator Gating

Status: not started.

Part of [Stage 6](../stage-06-leaderboards.md). This is build-order step 3: the operator-only admin HTTP routes that declare and configure iterations, control the submission window and visibility, trigger and re-run the workflow, inspect status, and stream the running workflow's container logs. These routes are the **stable contract** of the stage — the admin console (step 7) is the primary client, but the same routes are scriptable for headless deploys, which is the agreed "admin HTTP API is the contract" decision. No file-based CLI is built.

## Operator gating

Every route here is gated by the `isOperator(identity)` predicate from step 1, resolved from the Stage 4 identity seam (the mock user in dev, the GitHub handle once OAuth lands). A non-operator gets `403 not_operator` before any work. The gate is a single middleware/guard applied to the `/api/admin/*` prefix, not re-implemented per route, so there is one authorization choke point. The public reads (step 7's Leaderboards view, the environment page) do **not** go through this prefix; they use separate public routes that only ever return `published` iterations, so draft data cannot leak through a public endpoint regardless of caller.

## Routes

Under `/api/admin/`, attributing actions to the resolved operator identity:

- **Declare** — `POST /api/admin/environments/:envId/iterations`: create a `draft` iteration for the environment with an initial config (an empty or supplied match design) and `deps_version` defaulted to the current template release. Returns the new iteration. Declaring does not auto-close the previous iteration; closing/visibility are explicit.
- **Configure** — `PUT /api/admin/iterations/:id/config`: replace the iteration's `IterationConfig` through the typed codec from step 1, rejecting an unknown key or malformed match design with `400` and a specific reason. Allowed while `draft`; configuring a published iteration is permitted but flagged in the response so the console can warn (re-running is needed to apply it).
- **Submission window** — `POST /api/admin/iterations/:id/submissions:open` and `:close` (or a single `PATCH` with `{ submission_status }`): flip `submission_status`. Closing is what gates the form before a final workflow run.
- **Visibility** — `POST /api/admin/iterations/:id/publish` and `/unpublish`: flip `visibility`, stamping `published_at` on first publish. Publish is the explicit operator action that exposes the boards on the environment page; unpublish pulls them back to operator-only (useful after a bad re-run).
- **Trigger / re-run** — `POST /api/admin/iterations/:id/runs`: create an `iteration_runs` row and hand it to the workflow runner (step 4), returning the run id immediately (the run executes in the background, like the Stage 5 validation worker — the route never blocks on containers). A second call is the re-run: it starts a fresh run that, on completion, replaces the board. The route refuses to start a run when one is already `running` for the iteration (`409 run_in_progress`) so two concurrent runs cannot interleave on the single host.
- **Cancel** — `POST /api/admin/iterations/:id/runs/:runId:cancel`: request cancellation of an in-progress run; the runner stops scheduling further games and marks the run `cancelled` (step 4 owns the cooperative stop).
- **Status** — `GET /api/admin/iterations/:id`: the full admin view — config, both lifecycle axes, the latest run with its per-game statuses and any errors, and the computed boards even while `draft`. `GET /api/admin/environments/:envId/iterations` lists all iterations including drafts for the history/console picker.
- **Log stream** — `GET /api/admin/iterations/:id/runs/:runId/logs`: a streaming endpoint (Server-Sent Events or a WebSocket, matching whichever transport Stage 3 already uses for session streaming so the frontend reuses one client) that emits the running workflow's per-match container log lines and game-status transitions as they happen, then closes when the run reaches a terminal state. A late subscriber gets the buffered log-so-far then live tail, so opening the console mid-run is not blank. The runner (step 4) is the producer; this route is the subscriber-facing seam.

## Background execution and the runner seam

Triggering a run must not block the HTTP request on Docker, exactly as Stage 5's submit route does not block on the validation pipeline. The route creates the `pending` run row, enqueues it on the in-process workflow runner (step 4), and returns. The runner drives the run to a terminal state, writing `iteration_run_games`/`game_results` and emitting log events the stream route relays. On backend startup, any run left `running` by a process death is reconciled to `failed` (a partial leaderboard run is not silently resumed; the operator re-runs), mirroring Stage 5's startup recovery posture but choosing fail-closed for the heavier workflow.

## Tests

Backend Vitest with a fake/stub runner and `:memory:` storage, no Docker:

- Every `/api/admin/*` route returns `403 not_operator` for a non-operator identity and proceeds for an operator; the dev mock user is an operator.
- Declare creates a `draft` iteration with the current `deps_version`; configure round-trips a valid `IterationConfig` and `400`s an invalid one with a specific reason.
- Open/close flips `submission_status` and publish/unpublish flips `visibility` and stamps `published_at` once; the public iteration read never returns a `draft`.
- Triggering a run creates a run row and returns its id without invoking Docker inline (the stubbed runner records the enqueue); a second trigger while a run is `running` returns `409 run_in_progress`; cancel marks the run `cancelled` through the runner stub.
- The status route returns the admin view including a draft's boards; the list route includes drafts for operators.
- The log-stream route relays the stub runner's emitted lines to a subscriber and closes on terminal status; a subscriber attaching after some lines were emitted receives the buffered backlog then the tail.
- Startup reconciles a leftover `running` run to `failed`.

The Docker-backed end-to-end of an actual run is covered by step 4; this step's tests use a stub runner so the routes, gating, and streaming are proven Docker-free.

## Done when

An operator can, over HTTP, declare and configure an iteration, open and close its submissions, trigger and re-run its workflow (non-blocking, with a `409` against concurrent runs), publish and unpublish it, inspect its full status, and subscribe to a run's live log stream — all refused to non-operators and all keeping draft data off the public routes. The runner itself is a stub here; step 4 makes the trigger actually launch containers. </content>
