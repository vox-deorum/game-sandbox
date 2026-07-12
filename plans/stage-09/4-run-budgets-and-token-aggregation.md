# Stage 9.4: Run Budgets and Token Aggregation

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 4: the leaderboard half of metering. Session-scoped budgets already work end to end — step 1 enforces them by summing the scope's telemetry file, step 2 threads the season's numbers into issuance — so what remains is the scope that spans sessions: a per-submission budget across all of a submission's matches in one leaderboard run, plus the aggregation that turns the run's telemetry into the token-by-tier numbers [leaderboard.md](../../docs/specs/leaderboard.md) promises the automated board. By owner decision the run budget is **per submission per run**, not a shared run-wide pool: one hungry agent must not exhaust the tokens its competitors were scheduled to use after it.

**Hands-on result:** a season run under a deliberately tiny budget — the over-budget agent catches its error and finishes honestly, and the run's board rows carry real token totals by tier.

## Why this is its own seam

- Run scope is the one budget that outlives a container, so it cannot live in a slot key alone: it needs the workflow runner (which knows the run and the submission behind each seat) to name it, and the run's shared telemetry file — which step 2 already keys by run id — is exactly the record that spans those sessions.
- Aggregation belongs beside it: both are queries over the same file, read at the same moment in `runGame`, and both end in `game_results`, where a run's numbers become a board. Landing them together makes the test story one closed loop — spend tokens, hit the cap, read the board.

## What to build

### Run scope at the gateway

- The `runScope` field the `KeyRegistry` has accepted since step 1 becomes real: `{runId, subjectId, tokenBudget, callBudget}`, where `subjectId` is the submission behind the seat, or a `builtin` sentinel for the baseline (its own scope for uniformity — it never calls the model today, and a future built-in that does should be bounded like everyone else).
- Every telemetry row inserted under a grant with run scope carries its `subject_id` — the column step 1 reserved — so the run budget is one more sum in the same admission gate as the session budgets: `SELECT SUM(...), COUNT(*) … WHERE subject_id = ?` over the run's file, spanning all the run's sessions, plus the same in-flight reservations, failing with the same non-retryable 400 `budget_exceeded`. An agent cannot tell which scope it exhausted, and does not need to.
- Nothing to clean up when a run finishes: there are no counters, only the file, and cancel/rerun creates a fresh `runId` and hence a fresh file.

### The workflow runner

- `workflow-runner.ts` passes `runScope` at issuance for each agent seat, resolving budgets from the run's frozen `config_snapshot` (`run_token_budget` / `run_call_budget` in the step 2 override schema) with the deployment defaults (`LLM_RUN_TOKEN_BUDGET` / `LLM_RUN_CALL_BUDGET`) as fallback.
- Live watch/play sessions carry no run scope — their bound is the session budget; the run budget is a leaderboard-run concept, exactly as [llm.md](../../docs/specs/llm.md) frames it.

### Token aggregation into the board chain

At `runGame`'s post-exit point, one query per seat over the run's telemetry file — `SELECT model, SUM(input), SUM(output), SUM(reasoning), COUNT(*) … WHERE session_id = ? AND slot = ? GROUP BY model` — the same sums the budget gate enforced against, carried down the existing chain:

- `game_results` gains a nullable `llm_usage` JSON column (`{tier: {input, output, reasoning, calls}}`) via a migration, written through `RecordGameResultInput` beside `agent_compute_ms_total` — the shape [aggregate.ts](../../backend/src/workflow/aggregate.ts) has reserved commentary for since Stage 6. Failed calls contribute exactly what the upstream reported as usage — nothing for locally rejected calls or usage-less upstream errors; no estimated token ever reaches a row or a board.
- `getAutomatedBoard` in `backend/src/storage/kysely/boards.ts` merges per-game usage into a per-agent `token_usage_by_model` on `AutomatedBoardRow`, summed across games the way compute totals already are. Score and efficiency stay uncombined with tokens — the board _reports_ usage next to timing, it never ranks by it.
- The persisted placements (`AutomatedPlacementsTable`, `PlacementInput`, `persistPlacementsForSeason`) carry the same field so released history and agent-profile placements keep their numbers after the run's rows age out, mirroring the `mean_agent_compute_ms` precedent.
- The public board payload in `backend/src/leaderboards/routes.ts` exposes the new field; rendering it is step 5.

### The budget journey, pinned

The stage's "done when" names a specific behavior, and this step owns the test that pins it end to end: a deliberately hungry fixture agent (a test asset, not a shipped example) under a tiny budget exhausts it mid-episode, catches `BadRequestError` per the oracle's fallback pattern, plays on to a natural finish, and is **not** forfeited — budget exhaustion is not a crash, an illegal move, or an overrun, so the forfeit floor stays reserved for genuine failures while the seat's honest (if model-less) finish stands.

### Spec reconciliation in this step

- [llm.md](../../docs/specs/llm.md)'s budgets section is rewritten to the decided semantics: session budgets are per slot (a greedy agent starves only itself, and exhaustion stays attributable to one seat — the `failed_slot` philosophy applied to money), run budgets are per submission per run, rate limits answer 429, budget exhaustion answers a non-retryable 400, and the episode continues either way.
- [leaderboard.md](../../docs/specs/leaderboard.md)'s "aggregates LLM usage by model" sentence stays true, with tiers as the model vocabulary.

## Tests

Docker-free (fake driver, stub upstream):

- Run-scope usage accumulates across two sessions of the same run and subject in the run's one file; a third session's first call over the cap fails with `budget_exceeded`; a different subject in the same run is unaffected; a different run starts a fresh file.
- Session budget and run budget compose: whichever exhausts first blocks the call.
- The runner resolves run budgets override-first, default-second, and issues live-session keys with no run scope.
- The migration adds `llm_usage`; `runGame` writes per-tier sums equal to the file's rows; `getAutomatedBoard` merges multi-game usage per agent; placements persist and reload it; boards for pre-stage seasons read null usage cleanly.
- The hungry-agent journey (stub gateway): exhausts, catches, finishes, scores honestly, no forfeit, and its `game_results` row carries the usage that hit the cap.

Docker-gated:

- One small season run against the real stack with a tiny run budget reproduces the journey — board rows carry token usage by tier, and the run's telemetry file shows the failed calls tick-matched to the over-budget game's recording.

## Done when

- A leaderboard run enforces two nested bounds — per slot per session and per submission per run — with deployment defaults a season may override.
- An agent that spends past either bound receives an ordinary catchable API error and finishes its episode without forfeiting.
- The run's board rows and persisted placements carry token and call totals by tier, summed from the same telemetry file the budgets were enforced against.
- llm.md states the decided semantics.
- All Docker-free tests green; the journey is reproduced once against the real stack in the Docker-gated lane.
