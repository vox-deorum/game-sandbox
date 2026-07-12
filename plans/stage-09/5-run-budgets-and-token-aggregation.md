# Stage 9.5: Run Budgets and Token Aggregation

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md). This is build-order step 5: the leaderboard half of metering. Session-scoped budgets already work end to end — step 1 enforces them per key, step 2 threads the season's numbers into issuance — so what remains is the scope that spans sessions: a per-submission budget across all of a submission's matches in one leaderboard run, plus the aggregation that turns the step 4 telemetry into the token-by-model numbers [leaderboard.md](../../docs/specs/leaderboard.md) promises the automated board. By owner decision the run budget is **per submission per run**, not a shared run-wide pool: one hungry agent must not exhaust the tokens its competitors were scheduled to use after it. The hands-on surface at the end of this step is a season run under a deliberately tiny budget: the over-budget agent catches its error and finishes honestly, and the run's board rows carry real token totals by model.

## Why this is its own seam

Run scope is the one budget that outlives a container, so it cannot live in a slot key alone — it needs the workflow runner (which knows the run and the submission behind each seat) and the gateway's cross-session counters to agree. And the aggregation belongs beside it because both consume the same drained telemetry at the same moment in `runGame`, and both end in the same table: `game_results` is where a run's numbers become a board. Landing enforcement and aggregation together makes the step's test story one closed loop — spend tokens, hit the cap, read the board.

## What to build

### Run scope at the gateway

The `runScope` field the `KeyRegistry` has accepted since step 1 becomes real: `{runId, subjectId, tokenBudget, callBudget}`, where `subjectId` is the submission behind the seat, or a `builtin` sentinel for the baseline (which gets its own scope for uniformity; it never calls the model today, and if a future built-in does, it should be bounded like everyone else). The registry keeps one counter per `(runId, subjectId)`, shared by every key issued with that scope across all the run's matches, checked in the same pre-call gate as the session budgets and failing with the same non-retryable 400 `budget_exceeded` — an agent cannot tell which scope it exhausted, and does not need to. Counters are dropped at `finishRun` (and on cancel/rerun, which create a fresh `runId` anyway). They are in-memory like the keys: a backend restart aborts the run it was executing, so persistent counters would meter nothing.

### The workflow runner

`workflow-runner.ts` passes `runScope` at issuance for each agent seat, resolving budgets from the run's frozen `config_snapshot` (`run_token_budget` / `run_call_budget` in the step 2 override schema) with the deployment defaults (`LLM_RUN_TOKEN_BUDGET` / `LLM_RUN_CALL_BUDGET`) as fallback. Live watch/play sessions carry no run scope — their bound is the session budget; the run budget is a leaderboard-run concept, exactly as [llm.md](../../docs/specs/llm.md) frames it.

### Token aggregation into the board chain

At `runGame`'s post-exit drain (shared with the step 4 sidecar write), read the registry's per-grant, per-model counters — the authoritative usage record the budgets were enforced against; the sidecar rows are the audit trail, never the source of a board number — into per-seat token and call totals **by model**, and carry them down the existing chain:

- `game_results` gains a nullable `llm_usage` JSON column (`{model: {input, output, reasoning, calls}}`) via a migration, written through `RecordGameResultInput` beside `agent_compute_ms_total` — the shape [aggregate.ts](../../backend/src/workflow/aggregate.ts) has reserved commentary for since Stage 6. Failed calls contribute exactly what the upstream reported as usage — nothing for locally rejected calls, and nothing when an upstream error reported none; no estimated token ever reaches a counter, a row, or a board.
- `getAutomatedBoard` in `backend/src/storage/kysely/boards.ts` merges per-game usage into a per-agent `token_usage_by_model` on `AutomatedBoardRow`, summed across games the way compute totals already are. Score and efficiency stay uncombined with tokens — the board _reports_ usage next to timing, it never ranks by it.
- The persisted placements (`AutomatedPlacementsTable`, `PlacementInput`, `persistPlacementsForSeason`) carry the same field so released history and agent-profile placements keep their numbers after the run's rows age out, mirroring the `mean_agent_compute_ms` precedent.

The public board payload in `backend/src/leaderboards/routes.ts` exposes the new field; rendering it is step 6.

### The budget journey, pinned

The stage's "done when" names a specific behavior — an agent that exceeds its budget receives a catchable error and finishes its episode — and this step owns the test that pins it end to end: a deliberately hungry fixture agent (a test asset, not a shipped example) under a tiny budget exhausts it mid-episode, catches `BadRequestError` per the oracle's fallback pattern, plays on to a natural finish, and is **not** forfeited — budget exhaustion is not a crash, an illegal move, or an overrun, so the forfeit floor stays reserved for genuine failures while the seat's honest (if model-less) finish stands.

### Spec reconciliation in this step

[llm.md](../../docs/specs/llm.md)'s budgets section is rewritten to the decided semantics: session budgets are per slot (a greedy agent starves only itself, and exhaustion stays attributable to one seat, the `failed_slot` philosophy applied to money), run budgets are per submission per run, rate limits answer 429, budget exhaustion answers a non-retryable 400, and the episode continues either way. [leaderboard.md](../../docs/specs/leaderboard.md)'s "aggregates LLM usage by model" sentence is already true and stays.

## Tests

Docker-free (fake driver, stub upstream):

- Run-scope counters accumulate across two sessions of the same run and subject; a third session's first call over the cap fails with `budget_exceeded`; a different subject in the same run is unaffected; a different run starts fresh; `finishRun` clears the scope.
- Session budget and run budget compose: whichever exhausts first blocks the call.
- The runner resolves run budgets override-first, default-second, and issues live-session keys with no run scope.
- The migration adds `llm_usage`; `runGame` writes per-model sums matching the registry's counters, which in turn equal the sum of the rows' reported usage; `getAutomatedBoard` merges multi-game usage per agent; placements persist and reload it; boards for pre-stage seasons read null usage cleanly.
- The hungry-agent journey (stub gateway): exhausts, catches, finishes, scores honestly, no forfeit, and its `game_results` row carries the usage that hit the cap.

Docker-gated: one small season run against the real stack with a tiny run budget reproduces the journey — board rows carry token usage by model, and the over-budget game's recording and sidecar show the failed calls.

## Done when

A leaderboard run enforces two nested bounds — per-slot-per-session and per-submission-per-run — with deployment defaults a season may override, and an agent that spends past either receives an ordinary catchable API error and finishes its episode without forfeiting. The run's board rows and persisted placements carry token and call totals by model, summed from the same counters the budgets were enforced against, and llm.md states the decided semantics. All Docker-free tests green; the journey is reproduced once against the real stack in the Docker-gated lane.
