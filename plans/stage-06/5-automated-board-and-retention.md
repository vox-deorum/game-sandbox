# Stage 6.5: Automated Board and Retention

Status: not started.

Part of [Stage 6](../stage-06-leaderboards.md). This is build-order step 5: turning the `game_results` the runner writes (step 4) into the ranked automated board, persisting per-agent placements for the agent profile, linking a replay to each row, and extending the Stage 4 retention sweep so leaderboard recordings live exactly as long as their iteration is viewable.

## Board computation

The automated board for an iteration is computed from the **latest completed run** (`getLatestCompletedRun`, step 1) so a draft, failed, or in-progress re-run never changes a board out from under a reader. Computation aggregates `game_results` grouped by `agent_ref` (each active submission, plus the Naive baseline as its own row):

- **Rank by mean episode score.** Each agent's score is the mean of its `episode_score` across all its games in the run, where `episode_score` is already the environment's leaderboard score normalized higher-is-better (the normalization is the environment's contract, computed in step 4; this step does not re-normalize). Higher mean ranks higher. Controlled repetitions across seeds (step 2) are exactly what these means average over, so one lucky run does not dominate.
- **Mean wall-clock per decision, as a separate column.** Each agent's `mean_decision_ms` is the mean of its per-game `mean_decision_ms`. Per [leaderboard.md](../../docs/specs/leaderboard.md) this stands **next to** the score column and is **never folded into the ranking number**. The board carries both columns and orders only by score.
- **Failed-agent handling.** An agent whose games include failures still appears, with its failures reflected as that agent's results (the worst/sentinel score from step 4) folded into its mean, so a crashing agent ranks low rather than vanishing. The board may surface a failure count alongside the row so the operator and owner see why a mean is poor.
- **Naive baseline row.** The Naive baseline is always present (step 2 always schedules it), giving every board a fixed comparison point.
- **LLM token columns** are specified by [leaderboard.md](../../docs/specs/leaderboard.md) next to timing, but the telemetry that feeds them is a Stage 9 sidecar. This stage leaves the board shape ready for those columns (the board payload has a place for per-model token breakdown) but computes them empty/absent until Stage 9; this is called out so Stage 9 adds columns, not a new board.

### Stored vs computed

Decision: compute the board on read from `game_results` (cheap at class scale — a grouped aggregate over a single run's rows) rather than materializing a board table, **except** for **placements**, which are persisted. Persisting placements (`iteration_id`, `env_id`, `agent_submission_id`, `rank`, `mean_score`, `mean_decision_ms`, `run_id`) on run completion gives the agent profile (step 7) a direct per-agent read without re-aggregating every iteration's run, and gives history a stable snapshot even though the live aggregate would still match. The placement rows are rewritten when a re-run completes (keyed by `(iteration_id, agent_submission_id)` for the latest completed run), so the profile always reflects the current board. A `getAutomatedBoard(iterationId)` storage/service method returns the ranked rows with each agent's identity, the two columns, failure count, and the per-row replay link below; `listPlacementsByAgent(submissionId | userId, envId)` backs the profile.

## Per-row replay links

Each board row deep-links a representative replay for that agent in the iteration: the row carries a `recording_id` (one of the agent's games — e.g. its best, or most recent, game; pick best-score and state it) resolved from the `iteration_run_games.recording_id` the runner attached. The Leaderboards view (step 7) renders this as a "Replay" link per row using the existing Stage 4 replay viewer route, satisfying the scope's "replays linked from board rows" and the exit criterion that "every run has a replay."

## Visibility

The board is computed for any iteration the caller may see. The public service path only ever serves a `published` iteration's board (the public route filters on visibility, step 3); the admin path serves a draft's board so the operator can verify before publishing. There is one computation; the visibility filter sits at the route, so there is no second "draft board" code path to drift.

## Retention

Per [recording.md](../../docs/specs/recording.md), **leaderboard recordings are kept for as long as their iteration remains viewable**, distinct from live-session recordings (30-day per-user quota, oldest-unpinned-first). Extend the Stage 4 retention sweep ([stage-04/replay-and-retention.md](../stage-04/replay-and-retention.md)) so it distinguishes the two:

- A recording produced by a workflow run (linked from `iteration_run_games.recording_id`) is a **leaderboard recording** and is exempt from the live-session quota/window. It is retained while its iteration is viewable: a `published` iteration, or a `draft` one the operator is still working on. The sweep only reclaims a leaderboard recording when its iteration is no longer viewable — which, given iterations stay viewable as history, is effectively a manual operator delete or a future explicit archival policy, not the time/quota window.
- A recording from a **superseded run** (an earlier run replaced by a later completed re-run, step 4) is no longer the iteration's current board's recording and becomes eligible for reclamation, so repeated re-runs do not accumulate unbounded recordings. The current (latest completed) run's recordings stay.
- Live-session recordings are untouched: they keep the Stage 4 window/quota/pinning behavior. The sweep keys off whether a recording is referenced by a `iteration_run_games` row of a viewable iteration's current run to decide which policy applies, so the two policies coexist in one sweep rather than two competing ones.

## Tests

Vitest, `:memory:`, no Docker (board math and retention are pure over stored rows):

- `getAutomatedBoard` ranks agents by descending mean normalized score over a fixture of `game_results`, with `mean_decision_ms` as a separate column that does not affect order (two agents with equal scores but different timings keep score order); the Naive baseline appears; an agent with failed games has them folded into its mean and a surfaced failure count; the board reads from the latest _completed_ run and ignores a later `running`/`failed` run.
- Placements are persisted on run completion and rewritten when a re-run completes, so `listPlacementsByAgent` reflects the latest board; a superseded run's placements do not linger.
- Each board row resolves a `recording_id` to a replayable Stage 4 recording (the best-score game), and the public board service refuses a draft while the admin service returns it.
- The retention sweep exempts a viewable iteration's current-run leaderboard recordings from the live-session window/quota, reclaims a superseded run's recordings, and leaves live-session recordings on their Stage 4 policy — proven by a fixture mixing all three kinds.

## Done when

The automated board ranks agents by normalized mean episode score with mean decision time as a separate, non-folded column and a persisted placement per agent, every row deep-links a replay, the Naive baseline is always present, and the latest completed run drives the board so re-runs update it cleanly. Leaderboard recordings survive as long as their iteration is viewable while superseded re-run recordings and live-session recordings are reclaimed on their own policies. The board payload is ready for the Stage 9 token columns without further board changes. </content>
