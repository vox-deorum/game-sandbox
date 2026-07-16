# Stage 9.4: Official Run Budgets and Usage Aggregation

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 4.

## Outcome

Successful official calls consume a per-submission allowance across one leaderboard run. The run freezes its fully resolved LLM policy when it is created, so aliases and limits cannot change while the workflow is in progress. Call, token, and latency totals are aggregated by model alias into game results, persisted placements, and automated-board payloads only after the corresponding game has completed its grant teardown barrier. Budget rejections remain catchable agent errors and never create telemetry or cause a forfeit by themselves.

The hands-on check runs two matches under a small per-submission run allowance. Completed calls appear in the run-scoped SQLite file and board totals. The next over-budget request is rejected, the agent falls back to a legal action, and the game finishes normally.

## Run meter

The workflow runner reads `runId`, `subjectId`, and the resolved model map and limits from the run's frozen policy when it constructs each official grant. `subjectId` is the submission ID for a submission seat and a stable built-in subject for a built-in seat.

Every workflow grant has two accounting scopes. Its session-and-slot scope synchronously reads committed usage by `(session_id, slot)` from `data/llm/<runId>.sqlite`, while its run-subject scope synchronously reads the same file by `subject_id`. Its record sink writes that same file and captures the run ID as the file scope plus the game session, slot, and subject written on every successful row. Every grant constructed for that subject in successive match sessions therefore shares the run allowance. A different subject or run receives an independent allowance.

Admission checks both scopes before forwarding:

1. The session-and-slot accounting scope under the frozen per-slot limits.
2. The run-subject accounting scope under the frozen per-submission limits.

One temporary call-and-token reservation is registered in both scopes. An eventual success commits one call and either validated upstream usage or explicitly marked tokenizer estimates to both. Every local rejection or terminal upstream failure releases both reservations and commits nothing. Any normalization, usage-resolution, or telemetry failure after upstream success retains the conservative reservation as charged in-memory debt and opens both scope circuit breakers, as defined in Step 1. If either scope cannot reserve the request, or either breaker is open, the proxy does not call the upstream.

Live watch and play sessions have no run subject. A rerun receives a new run ID, a new scope file, and a fresh allowance.

## Workflow runner

Run creation resolves the complete official LLM policy against the deployment configuration and stores that result in the run's dedicated `llm_policy_snapshot`, separate from the strict season `config_snapshot`. The frozen policy includes whether official access is enabled, the alias-to-upstream-model mapping, per-slot session limits, and per-submission run limits. `workflow-runner.ts` reads only these stored values. It never falls back to current deployment defaults or re-resolves the season configuration after the run exists. `runGame` constructs each generic `LlmGrant` from the frozen model map, the session-and-slot and run-subject accounting scopes, and an official record sink that captures the run, game session, slot, and subject identifiers.

When the workflow registers a recording, it stores `llm_scope_id = runId` and `llm_session_id = game.id`. Those fields preserve telemetry lookup after workflow rows are pruned.

Each workflow game has one teardown owner covering grant issuance, process launch, execution, and result persistence. Every completion path, including setup or launch failure, normal exit, crash, cancellation, and explicit stop, calls and awaits the same idempotent `revokeSession` barrier. It first closes all of the game's grants to new admission, then aborts active requests where cancellation remains safe, drains requests that have passed that boundary, and awaits every reservation finalizer. Overlapping failure and stop paths await the same barrier.

Only after that full barrier resolves may `runGame` query `ExecutionTelemetryStore` for rows in the run file matching the workflow game's session ID and slot, group them by model alias, or persist a per-game aggregate. A terminal run also awaits the barrier for every game that issued grants before it performs any final run-level telemetry query, placement persistence, or scope cleanup. This ordering applies even when the process never launched or no successful row is expected.

## Game-result and board data

Add nullable `llm_usage_by_model` JSON to `game_results`:

```ts
type LlmModelUsage = {
  calls: number
  estimated_calls: number
  input_tokens: number
  reasoning_tokens: number
  output_tokens: number
  latency_ms: number
}

type LlmUsageByModel = Partial<Record<ModelAlias, LlmModelUsage>>
```

Add this column directly to the flat initial application schema. Stage 9 adds no forward application-database migration because the project has no persistent production database yet; contributors recreate older local databases when this schema lands.

`runGame` writes one `LlmUsageByModel` value per seat beside the existing compute total. Calls, tokens, and latency are sums over successful execution-scope SQLite rows. `estimated_calls` counts rows whose `usage_estimated` value is 1, so boards and persisted placements do not present fallback token counts as provider-reported usage. Reservations, rejected calls, terminal upstream failures, and exceptional in-memory debt without a row contribute no telemetry aggregate.

`getAutomatedBoard` sums per-game values into each agent's `llm_usage_by_model`, including `estimated_calls`. The data reports successful model use and does not affect score, score spread, timing tie-breaks, or rank.

`AutomatedPlacementsTable`, `PlacementInput`, and `persistPlacementsForSeason` store the same aggregate so released history and agent profiles retain model usage after workflow rows are pruned. Board and placement readers accept null for seasons without LLM usage.

## Budget-exhaustion journey

Add a test-only hungry agent that requests a completion on every turn and uses a legal deterministic fallback for `budget_exceeded`. Configure its run allowance so successful calls in the first match leave too little room for a request in the second match.

The rejected request reaches no upstream, consumes no budget, creates no SQLite row, and does not mark the seat failed. The agent completes the game with its fallback action. The game result and board equal the successful rows produced before exhaustion.

## Tests

Docker-free workflow and storage tests cover:

- Successful usage accumulating across two sessions for one run and subject.
- Independent counters for another subject in the same run and the same subject in another run.
- Session and run reservations composing atomically, with the first unavailable scope returning `budget_exceeded`.
- A retryable sequence that succeeds committing once to both scopes.
- Valid upstream usage and tokenizer-estimated usage aggregating into the same token totals while only estimated rows increment `estimated_calls`.
- Local rejection, non-retryable upstream failure, and exhausted retries committing to neither scope.
- A post-upstream accounting failure retaining conservative debt and opening both the session and run circuit breakers before any second request reaches the upstream.
- Run creation persisting a fully resolved official LLM policy, and workflow games continuing to use it after deployment defaults or the season configuration change.
- Workflow recording registration persisting the run scope and game-session filter IDs.
- Normal exit, crash, setup or launch failure, cancellation, and explicit stop closing grant admission, aborting or draining active requests, and awaiting reservation finalizers before the first telemetry query or per-game aggregate write.
- Concurrent teardown callers sharing one idempotent barrier, with delayed successful writes included in the aggregate and no telemetry write occurring after aggregation.
- Terminal run aggregation, placement persistence, and scope cleanup waiting for every game barrier that issued grants.
- Successful execution-scope rows grouping into exact per-model call, estimated-call, token, and latency sums for each seat.
- `game_results`, automated boards, and placements persisting and reloading the same aggregate.
- Null usage reading cleanly for seasons and games without successful LLM calls.
- The hungry agent catching budget exhaustion, finishing naturally, retaining its honest score, and avoiding a forfeit.

Docker integration runs the two-match journey through the real workflow runner and stub upstream. The run-scoped SQLite file, game results, board payload, and persisted placements must agree exactly.

## Done when

- Per-slot session limits and per-submission run limits bound successful official use independently.
- One eventual success consumes one call in both scopes. Every unsuccessful logical request consumes no call or token budget.
- Budget exhaustion is a catchable error, creates no SQLite row, and does not forfeit a game that the agent finishes legally.
- A run uses the fully resolved official LLM policy stored at run creation and never current deployment defaults.
- Every workflow exit path closes admission and awaits active-request and reservation settlement before querying telemetry or persisting usage aggregates.
- Game results, automated boards, and placements report successful calls, estimated-call counts, tokens, and model-call latency by alias.
- All reported aggregates equal the successful rows in execution-scope SQLite.
