# Stage 6.5: Automated Board and Retention

Status: not started.

Part of [Stage 6](../stage-06-leaderboards.md). This is build-order step 5. It turns the `game_results` the runner writes (step 4) into the ranked automated board. It also persists per-agent placements for the agent profile, links a replay to each row, and extends the Stage 4 retention sweep so leaderboard recordings live exactly as long as their iteration is viewable.

## Board computation

The automated board for an iteration is computed from the **latest completed run** (`getLatestCompletedRun`, step 1). A pending, failed, or in-progress re-run therefore never changes a board out from under a reader. The computation aggregates `game_results` grouped by the shared `AgentRef` columns. Each active submission gets a row, and the Naive baseline gets its own row:

- **Rank by mean episode score.** Each agent's score is the mean of its `episode_score` across all its games in the run. The `episode_score` is already the environment's leaderboard score, normalized higher-is-better. That normalization is the environment's contract and is computed in step 4; this step does not re-normalize. A higher mean ranks higher. These means average over the controlled repetitions across seeds (step 2), so one lucky run does not dominate.
- **Mean wall-clock compute per acted tick, as a separate column.** Each agent's `mean_agent_compute_ms` is `sum(agent_compute_ms_total) / sum(acted_tick_count)` across that agent's games in the latest completed run. Step 4 already folded `decision_ms + learn_ms` and later hook timings into one comparable compute total. Summing first and dividing once avoids the classic mean-of-means bug when games have different lengths. If an agent somehow has zero acted ticks, the compute column is null/blank rather than fabricated. Per [leaderboard.md](../../docs/specs/leaderboard.md) this column stands **next to** the score column and is **never folded into the ranking number**. The board carries both columns but orders only by score.
- **Failed-agent handling.** An agent whose games include attributable failures still appears. The final recorded score from each failed game is folded into its mean, and a failure count is surfaced. Infrastructure failures that produced no `game_results` row are not silently converted into an agent score; they stay visible in the run/game status for the operator.
- **Naive baseline row.** The Naive baseline is always present, because step 2 always schedules it. This gives every board a fixed comparison point.
- **LLM token columns** are specified by [leaderboard.md](../../docs/specs/leaderboard.md) next to timing, but the telemetry that feeds them is a Stage 9 sidecar. This stage leaves the board shape ready for those columns: the board payload has a place for a per-model token breakdown. It computes them empty/absent until Stage 9. This is called out so that Stage 9 adds columns rather than a new board.

### Stored vs computed

Decision: compute the board on read from `game_results` rather than materializing a board table. This is cheap at class scale, since it is a grouped aggregate over a single run's rows. The one **exception** is **automated placements**, which are persisted in `automated_placements`. Persisting placements (`iteration_id`, `env_id`, `run_id`, `rank`, `AgentRef` columns, `mean_score`, `mean_agent_compute_ms`, `failure_count`, `recording_id`) on run completion serves two purposes. It gives the agent profile (step 7) a direct per-agent read without re-aggregating every iteration's run. It also gives history a stable snapshot, even though the live aggregate would still match. The placement rows are rewritten when a re-run completes. They are keyed by iteration plus agent ref for the latest completed run, so the profile always reflects the current board. A `getAutomatedBoard(iterationId)` storage/service method returns the ranked rows, each with the agent's identity, the two columns, the failure count, and the per-row replay link described below. `listPlacementsByAgent(agentRef, envId)` backs the profile.

## Per-row replay links

Each board row deep-links a representative replay for that agent in the iteration. The row carries the `recording_id` from the agent's best-score completed game in the latest completed run, with ties broken by the earliest `game_index`. This is resolved from the `iteration_run_games.recording_id` the runner attached, then copied into `automated_placements` on run completion. The Leaderboards view (step 7) renders it as a "Replay" link per row, using the existing Stage 4 replay viewer route. This satisfies the scope's "replays linked from board rows" and the exit criterion that "every run has a replay."

## Release filtering

The board is computed for any iteration the caller may see. The public service path only ever serves a `released` iteration's board, because the public route filters on release status (step 3). The admin path serves an `unreleased` iteration's board so the operator can verify it before releasing. There is one computation, and the release filter sits at the route. So there is no second "unreleased board" code path to drift.

## Retention

Per [recording.md](../../docs/specs/recording.md), **leaderboard recordings are kept for as long as their iteration remains viewable**. This is distinct from live-session recordings, which use a 30-day per-user quota and drop the oldest unpinned first. Extend the Stage 4 retention sweep ([stage-04/replay-and-retention.md](../stage-04/replay-and-retention.md)) so it uses the step-1 `listProtectedLeaderboardRecordingIds()` helper before applying live-session policies:

- A recording id returned by `listProtectedLeaderboardRecordingIds()` is a current-run **leaderboard recording**. It is exempt from the live-session quota/window. It is retained while its iteration is viewable: a `released` iteration, or an `unreleased` one the operator is still working on. Because iterations stay viewable as history, reclaiming current-run leaderboard recordings is effectively a future explicit archival policy, not the time/quota window.
- A recording from a **superseded run** (an earlier run replaced by a later completed re-run, step 4) is no longer protected. It becomes eligible for reclamation, so repeated re-runs do not accumulate unbounded recordings. The current latest completed run's recordings stay protected.
- Live-session recordings are untouched: they keep the Stage 4 window/quota/pinning behavior. The sweep filters protected leaderboard ids out first, then applies the existing window and per-user quota passes to the remaining rows.

## Tests

Vitest, `:memory:`, no Docker (board math and retention are pure over stored rows):

- `getAutomatedBoard` ranks agents by descending mean normalized score over a fixture of `game_results`. `mean_agent_compute_ms` is computed as weighted per-decision time from total compute and acted tick count, and is a separate column that does not affect order (two agents with equal scores but different timings keep score order). The Naive baseline appears. Attributable failed games are folded into the mean with a surfaced failure count. Infrastructure failures without result rows do not become agent rows. Zero acted ticks yields a blank compute value. The board reads from the latest _completed_ run and ignores a later `running`/`failed` run.
- Placements are persisted on run completion and rewritten when a re-run completes, so `listPlacementsByAgent` reflects the latest board. A superseded run's placements do not linger. Submitted-agent and Naive placement rows both round-trip.
- Each board row resolves a `recording_id` to a replayable Stage 4 recording (the best-score completed game, with ties broken by earliest `game_index`). The public board service refuses an unreleased iteration, while the admin service returns it.
- The retention sweep exempts a viewable iteration's current-run leaderboard recordings from the live-session window/quota, reclaims a superseded run's recordings, and leaves live-session recordings on their Stage 4 policy. A fixture mixing all three kinds proves this.

## Done when

The automated board ranks agents by normalized mean episode score. Weighted mean agent compute time is a separate, non-folded column, and each agent has a persisted placement. Every row deep-links the best-score replay. The Naive baseline is always present for runnable schedules. The latest completed run drives the board, so re-runs update it cleanly. Current-run leaderboard recordings survive as long as their iteration is viewable, while superseded re-run recordings and live-session recordings are reclaimed on their own policies. The board payload is ready for the Stage 9 token columns without further board changes.
