# Stage 9.4: Official Run Budgets and Usage Aggregation

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 4.

## Outcome

Successful official calls consume a per-submission allowance across one leaderboard run. Their call, token, and latency totals are aggregated by model alias into game results, persisted placements, and automated-board payloads. Budget rejections remain catchable agent errors and never create telemetry or cause a forfeit by themselves.

The hands-on check runs two matches under a small per-submission run allowance. Completed calls appear in the run-scoped SQLite file and board totals. The next over-budget request is rejected, the agent falls back to a legal action, and the game finishes normally.

## Run meter

The workflow runner supplies `runId`, `subjectId`, and resolved run limits when it issues each official grant. `subjectId` is the submission ID for a submission seat and a stable built-in subject for a built-in seat.

Every workflow grant uses `scopeId = runId` and carries its `subjectId`. `OfficialUsageMeter` queries successful rows in `data/llm/<runId>.sqlite` by subject for run limits and by `(session_id, slot)` for session limits. Every grant for that subject in successive match sessions shares the run allowance. A different subject or run receives an independent allowance.

Admission checks both scopes before forwarding:

1. The grant's per-slot session limits.
2. The subject's per-run limits.

One temporary reservation is registered in both scopes. An eventual success commits one call and actual upstream usage to both. Every local rejection or terminal upstream failure releases both reservations and commits nothing. If either scope cannot reserve the request, the proxy returns `400 budget_exceeded` and does not call the upstream.

Live watch and play sessions have no run subject. A rerun receives a new run ID, a new scope file, and a fresh allowance.

## Workflow runner

`workflow-runner.ts` resolves official run limits from the run's frozen season configuration with deployment defaults as fallback. `runGame` includes scope ID, session ID, slot, submission subject, and run ID in each official grant.

When the workflow registers a recording, it stores `llm_scope_id = runId` and `llm_session_id = game.id`. Those fields preserve telemetry lookup after workflow rows are pruned.

After the process exits, `runGame` queries `ExecutionTelemetryStore` for rows in the run file matching the workflow game's session ID and slot, grouped by model alias. Successful inserts commit before the proxy returns their responses, so aggregation has no finalize drain.

## Game-result and board data

Add nullable `llm_usage_by_model` JSON to `game_results`:

```ts
type LlmModelUsage = {
  calls: number
  input_tokens: number
  reasoning_tokens: number
  output_tokens: number
  latency_ms: number
}

type LlmUsageByModel = Partial<Record<ModelAlias, LlmModelUsage>>
```

`runGame` writes one `LlmUsageByModel` value per seat beside the existing compute total. Every figure is a sum over successful execution-scope SQLite rows. Reservations, estimates, rejected calls, and terminal upstream failures contribute nothing.

`getAutomatedBoard` sums per-game values into each agent's `llm_usage_by_model`. The data reports successful model use and does not affect score, score spread, timing tie-breaks, or rank.

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
- Local rejection, non-retryable upstream failure, and exhausted retries committing to neither scope.
- Workflow limit resolution from frozen season configuration and deployment defaults.
- Workflow recording registration persisting the run scope and game-session filter IDs.
- Successful execution-scope rows grouping into exact per-model call, token, and latency sums for each seat.
- `game_results`, automated boards, and placements persisting and reloading the same aggregate.
- Null usage reading cleanly for seasons and games without successful LLM calls.
- The hungry agent catching budget exhaustion, finishing naturally, retaining its honest score, and avoiding a forfeit.

Docker integration runs the two-match journey through the real workflow runner and stub upstream. The run-scoped SQLite file, game results, board payload, and persisted placements must agree exactly.

## Done when

- Per-slot session limits and per-submission run limits bound successful official use independently.
- One eventual success consumes one call in both scopes. Every unsuccessful logical request consumes no call or token budget.
- Budget exhaustion is a catchable error, creates no SQLite row, and does not forfeit a game that the agent finishes legally.
- Game results, automated boards, and placements report successful calls, tokens, and model-call latency by alias.
- All reported aggregates equal the successful rows in execution-scope SQLite.
