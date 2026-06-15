# Stage 6.4: Automated Workflow Runner

Status: not started.

Part of [Stage 6](../stage-06-leaderboards.md). This is build-order step 4: the background runner that takes a triggered `iteration_runs` row, executes its scheduled games sequentially on one host through the Stage 3 execution driver, records every run, captures container logs for the admin stream, aggregates timing from the recordings, and drives the run to a terminal state. This is the Docker-gated heart of the stage.

## Position in the pipeline

The admin trigger route (step 3) creates a `pending` run and enqueues it here. The runner: builds the schedule via `buildSchedule` (step 2) from the iteration's config and its active `ready` submissions, persists one `iteration_run_games` row per scheduled game, then executes them in order. It reuses the Stage 3 driver and the Stage 5 submission overlay images — it does not introduce a second execution path. The board computation (step 5) reads the `game_results` this runner writes.

## Execution model

Per [leaderboard.md](../../docs/specs/leaderboard.md):

- **Sequential, single host.** Games run one at a time so wall-clock timing is comparable across agents (the spec's explicit reason; at class scale the serialization cost is small). The runner is concurrency-1 over games within a run, like the Stage 5 validation worker is concurrency-1 over submissions.
- **One container per match.** Each game runs in its own container holding the harness, the environment, and the agent(s), launched through the Stage 3 driver. For a submission seat the runner uses that submission's built overlay image (Stage 5.4); for a `builtin-naive` seat it uses the same built-in agent the watch picker launches. Single-agent Flappy Bird is one agent in the single slot; the multi-submission overlay is Stage 7's concern, but the runner passes the resolved `slots` assignment through so it does not need rework then.
- **Seeds to env and agents.** The scheduled game's seed is passed to both the environment reset and the agents, per [environment.md](../../docs/specs/environment.md), so a deterministic agent reproduces its run exactly on a re-run.
- **Timeouts.** Per-step and per-episode timeouts come from the environment defaults unless the iteration's `overrides` set them (step 1 config). The harness already enforces per-step/per-episode limits; the runner passes the effective values in. A slow or stuck agent trips the timeout and does not block the queue.
- **Recording.** Every game is recorded to the shared recordings store (the same Stage 4 path and JSONL format, written to the volume mounted into the workflow container per [recording.md](../../docs/specs/recording.md)). The runner attaches the resulting `recording_id` to the `iteration_run_games` row (`attachRunGameRecording`), which is the per-row replay link the board exposes. The recording header carries the per-slot attribution (which submission / the Naive agent) already defined by [recording.md](../../docs/specs/recording.md).

## Per-game outcome and the failing-agent rule

When a game finishes, the runner reads the recording it just produced and writes one `game_results` row per participating seat:

- `episode_score` — the environment's leaderboard score for that slot, normalized higher-is-better (Flappy Bird is already higher-is-better; the normalization contract is the environment's, per [leaderboard.md](../../docs/specs/leaderboard.md)). The score comes from the recorded per-step `score` the harness emits (the final/episode score per the environment's rule), not recomputed.
- `mean_decision_ms` — aggregated from the recorded per-agent `decision_ms` timings the harness already writes (Stage 2 `AgentTiming`). The runner aggregates; it does not re-measure. `learn`/`chat`/LLM-wait time folds into the same timing basis as those hooks land (Stages 8/9), per the spec.
- `failed` — true when the agent crashed or timed out. Per the scope, **a failing or timed-out agent is recorded as that agent's result** (a sentinel/worst score for that seat), and the game's other seats and the rest of the iteration continue. A single agent failure never aborts the run. The `iteration_run_games.status` records `failed`/`timed_out` for that game while `game_results.failed` marks the specific seat.

A game whose _container_ fails to start or whose recording is unreadable (an infrastructure fault, not an agent fault) marks the game `failed` with an error but is distinguished from an agent fault in the run log, so the operator can tell "your agent crashed" from "the host hiccuped."

## Logs and progress for the admin stream

As each game runs, the runner emits events the step-3 log-stream route relays: a game-started line (which seats, which seed), the match container's stdout/stderr lines (reusing the Stage 3 line transport so no new log plumbing is invented), and a game-finished line with its status and scores. These are buffered per run so a late console subscriber sees the backlog then the live tail. Game-status transitions (`pending`→`running`→terminal) are written to storage so the admin status view reflects progress even without an attached stream.

## Re-run idempotency and cancellation

- **Re-run replaces.** Triggering a new run for an iteration creates a new `iteration_runs` row and a fresh set of games; the board (step 5) always reads the latest _completed_ run, so a re-run's results supersede the prior run's once it completes, while the prior run's rows remain until then (a failed or in-progress re-run never blanks a good published board). Recordings from a superseded run are eligible for the retention sweep (step 5) once they are no longer the iteration's current run.
- **Deterministic reproduction.** Because seeds are fixed by the schedule and passed through to env and agents, re-running the same config reproduces a deterministic agent's `episode_score` exactly — the stage's "re-running reproduces the scores of deterministic agents" exit criterion.
- **Cancellation.** A cancel request (step 3) sets a cooperative flag the runner checks between games; it stops scheduling further games, marks the in-flight game and the run `cancelled`, and tears down the current container through the driver. Mid-game cancellation is best-effort (let the current game finish or kill the container); the run does not produce a partial board — a cancelled run is not the "latest completed" run.

## Tests

- **Docker-free (Vitest, FakeDriver):** with a fake driver that returns canned recordings, the runner expands a schedule, persists `iteration_run_games`, executes them in order, writes `game_results` with the expected scores/timings parsed from the fake recordings, attaches recording ids, and reaches `completed`; an agent whose fake recording indicates a crash/timeout produces a `failed` `game_results` row without aborting the remaining games; an infrastructure-style driver error marks that game `failed` with an error and the run continues; a cancel flag set mid-schedule stops further games and marks the run `cancelled`; re-running creates a second run and `getLatestCompletedRun` returns it.
- **Docker-gated end-to-end (the real driver, gated like the Stage 5.4 build/load tests):** a small iteration with the worked Flappy Bird example as a submission plus the Naive baseline, two seeds, runs to completion, produces a recording per game with a valid header, and a deterministic example reproduces identical `episode_score` across two runs. This reuses the Stage 5 Docker-gated harness rather than standing up new container plumbing.

## Done when

Triggering a run launches the scheduled games sequentially on one host, records each with a replayable recording, aggregates the harness's score and decision timings into `game_results`, records a failing or timed-out agent as that agent's result without aborting the iteration, streams container logs to the admin console, and reaches a terminal run state. Re-running the same config reproduces deterministic agents' scores and, on completion, becomes the latest completed run the board reads. The board itself is computed in step 5. </content>
