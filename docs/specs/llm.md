# LLM API for Agents

Agents may call language models through an OpenAI-compatible API provided by the deployment. The capability is optional and may be disabled by the environment or season.

## What agents see

Agent code reads:

- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`

The same code works locally and on the server. For local development, a participant requests a season-scoped development key from the backend. For a server-run session, the backend creates a temporary key for one session and slot, then revokes it when the container exits. See [Submissions](submission.md).

## Backend proxy and upstream

```text
Agent slot ───────────────┐
                         ├→ backend LLM proxy → configured OpenAI-compatible endpoint
Student development call ┘          │
                                    └→ access checks, metering, and telemetry
```

The backend owns the OpenAI-compatible endpoint exposed to agents and students. It holds the upstream credential, enforces the enabled model tiers and budgets, and forwards requests to one deployment-configured OpenAI-compatible endpoint. Agents request one stable public tier: `small`, `medium`, or `large`. The proxy maps that tier to its configured upstream model. Successful responses retain standard generated content and usage fields, replace structured provider model identifiers with the public tier, and discard nonstandard top-level provider metadata before the same canonical completion is returned and recorded. Generated assistant content and tool arguments are not rewritten as metadata. The upstream may itself be a gateway or multi-provider router. Game Sandbox does not implement provider routing, provider failover, or a separate LLM gateway service.

Session containers cannot reach the general internet. When LLM access is enabled, their only permitted network endpoint is the backend LLM proxy. This keeps model use sanctioned and comparable across participants while preserving the broader rule that agents cannot contact arbitrary outside services. See [Execution](execution.md).

The backend handles upstream reliability. It retries retryable failures with exponential backoff, starting from a deployment-configurable interval and stopping after a deployment-configurable maximum number of retries following the initial attempt. It returns non-retryable upstream errors immediately in an OpenAI-compatible error response. If the retry limit is exhausted, it returns the final failure without turning it into a successful call. Streaming is unsupported. A rate refusal returns `429 rate_limit_exceeded`, an over-budget request returns `400 budget_exceeded`, and an accounting failure after an upstream success returns `503 meter_unavailable`.

## Successful-call accounting

Only a request that receives a successful upstream response can become a committed call with token usage and LLM telemetry. Rejected requests, non-retryable upstream errors, and retry sequences that never succeed consume no token allowance and create no telemetry record. Retries belong to the original request, so a request that eventually succeeds is finalized at most once. A post-upstream processing failure creates no partial success row, but its conservative reservation remains charged as process-lifetime debt under the failure rule below.

The backend uses the successful response's token usage when it is valid. If an otherwise successful OpenAI-compatible response omits valid usage, the backend estimates input and output tokens from the accepted request and canonical completion with its configured tokenizer, uses an exposed reasoning-token count when one exists and zero otherwise, and marks the telemetry and every derived aggregate as estimated. Arbitrary participant strings, including text that resembles a tokenizer special token, are treated as ordinary content. Estimated usage still consumes the token budget.

The backend commits successful-call accounting before returning the completion. Once the upstream succeeds, any later failure before durable accounting completes retains the request's conservative in-memory charge, returns a service error instead of the completion, and blocks further model requests for the affected accounting scope. A successful write-health probe closes the breaker without forgiving that debt; a persistent post-processing failure can open it again on the next request. This prevents a tokenizer, normalization, or storage fault from becoming a way to make repeated unaccounted provider calls.

For each successful agent call, the backend records:

- Session, tick, and slot.
- Model.
- Full accepted prompt and the canonical completion returned to the caller.
- Input, reasoning, and output token counts, with an indication when the backend estimated them.
- End-to-end latency, including retries.

Agent-call telemetry is stored in backend-managed SQLite files keyed by execution scope. A live session has one telemetry file, while every match session in one leaderboard run shares the run's telemetry file. Recordings retain the session and run associations needed to query their successful calls. Public replay views show model, token, and budget-cost summaries. Stored accepted prompts and canonical completions are visible only to an operator or the current owner of the controlling submission. If that submission is deleted, its former owner retains metadata access but not bodies. A recording with no LLM association has an empty telemetry result, while an associated but unreadable telemetry scope is unavailable rather than empty. See [Recording](recording.md) and [Frontend](frontend.md).

## Budgets and limits

Token budgets are enforced in weighted units per model tier. A successful call costs the tier's configured price multiplied by its input tokens plus total completion tokens. Reasoning tokens are already part of total completion tokens and are not charged again. Deployment prices default to 4 for `large`, 2 for `medium`, and 1 for `small`; a season may override any enabled tier with a positive finite price no greater than 1,000,000. Official leaderboard runs freeze the resolved prices with their policy, while live sessions and development keys use the current resolved season prices.

Official execution and student development have separate meters. Each session slot has a weighted token budget and a rate limit; a leaderboard run carries no allowance of its own, and every match in a run is a new session with a fresh per-slot allowance. Creating a leaderboard run freezes its resolved official policy, including enabled tiers, upstream model mappings, prices, and per-slot limits. The deployment provides defaults, and a season may override the official and development limits independently. Each admitted logical request reserves one pending slot of rate capacity, and admission rejects a request when recorded events plus pending slots fill the in-memory sliding window, so a concurrent in-flight call occupies capacity even before its outcome is known. A successful upstream response converts its pending slot into one recorded event stamped at the request's start; rejected requests, non-retryable errors, and exhausted retry sequences release their slot and record none, and the retries within one logical request add at most the single event of the success they reach. A pending slot also expires once its start leaves the window, so a request that outlives the window stops occupying capacity and, on eventual success, retains no event. The rate window therefore bounds successful request starts per minute, matching durable token totals, which contain successful rows only; conservative process-lifetime debt also reduces the remaining allowance after a post-upstream accounting failure.

The proxy accepts either `max_tokens` or `max_completion_tokens`, but not both. It applies a deployment-configured default when neither is present, rejects a requested maximum above the deployment's hard ceiling, and forwards the resulting maximum to the upstream. Admission reserves that enforced output maximum together with estimated input usage, so an explicit or default completion limit cannot bypass the remaining token allowance. A request that does not fit returns a normal, non-retryable budget error that the agent can handle, and the game continues.

The backend also exposes an authenticated OpenAI-compatible endpoint for student development. A participant may request or use a development key for a season only while that season's submission window is open and the season has effective LLM access. Closing submissions immediately stops existing keys. Calls made with a development key are charged only to that season's development meter for that participant. Successful development calls are recorded in a season-keyed SQLite ledger with the participant, model, token counts, whether those counts were estimated, latency, accepted prompt, and canonical completion. That ledger is visible only to the participant and operators. Development calls are never attached to a session recording or included in leaderboard usage.

## Determinism and timing

A seed does not make a model response deterministic. Seeded repetitions reduce the effect of stochastic policies but do not remove it.

In an official session, the chargeable duration of `act`, `chat`, and `learn` excludes verified backend-proxy time, including retry waits. The harness compares the slot's proxy-time snapshots around each hook and charges the remaining elapsed time to the step and episode limits. Chargeable time cannot be less than the calling thread's CPU time. If either snapshot is unavailable or invalid, the full hook time is charged. Model calls and local work must stay on that thread.

Live-session and workflow watchdogs also exclude verified proxy time after they start. Their allowance for an active request is bounded, so a stuck request cannot extend the deadline indefinitely. Idle timeout always uses wall-clock time.

Calls during module import, construction, or `reset` are setup calls with null tick attribution and occur before turn timing. The automated board reports successful-call counts and token use by model. See [Leaderboards](leaderboard.md).
