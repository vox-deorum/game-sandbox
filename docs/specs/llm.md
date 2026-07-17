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

The backend owns the OpenAI-compatible endpoint exposed to agents and students. It holds the upstream credential, enforces the allowed models and budgets, and forwards requests to one deployment-configured OpenAI-compatible endpoint. Agents use stable public model aliases. Successful responses retain standard generated content and usage fields, replace structured provider model identifiers with the public alias, and discard nonstandard top-level provider metadata before the same canonical completion is returned and recorded. Generated assistant content and tool arguments are not rewritten as metadata. The upstream may itself be a gateway or multi-provider router. Game Sandbox does not implement provider routing, provider failover, or a separate LLM gateway service.

Session containers cannot reach the general internet. When LLM access is enabled, their only permitted network endpoint is the backend LLM proxy. This keeps model use sanctioned and comparable across participants while preserving the broader rule that agents cannot contact arbitrary outside services. See [Execution](execution.md).

The backend handles upstream reliability. It retries retryable failures with exponential backoff, starting from a deployment-configurable interval and stopping after a deployment-configurable maximum number of retries following the initial attempt. It returns non-retryable upstream errors immediately in an OpenAI-compatible error response. If the retry limit is exhausted, it returns the final failure without turning it into a successful call.

## Successful-call accounting

Only a request that receives a successful upstream response can become a committed call with token usage and LLM telemetry. Rejected requests, non-retryable upstream errors, and retry sequences that never succeed consume no call or token allowance and create no telemetry record. Retries belong to the original request, so a request that eventually succeeds is finalized at most once. A post-upstream processing failure creates no partial success row, but its conservative reservation remains charged as process-lifetime debt under the failure rule below.

The backend uses the successful response's token usage when it is valid. If an otherwise successful OpenAI-compatible response omits valid usage, the backend estimates input and output tokens from the accepted request and canonical completion with its configured tokenizer, uses an exposed reasoning-token count when one exists and zero otherwise, and marks the telemetry and every derived aggregate as estimated. Arbitrary participant strings, including text that resembles a tokenizer special token, are treated as ordinary content. Estimated usage still consumes the applicable call and token budgets.

The backend commits successful-call accounting before returning the completion. Once the upstream succeeds, any later failure before durable accounting completes retains the request's conservative in-memory charge, returns a service error instead of the completion, and blocks further model requests for the affected accounting scope. A successful write-health probe closes the breaker without forgiving that debt; a persistent post-processing failure can open it again on the next request. This prevents a tokenizer, normalization, or storage fault from becoming a way to make repeated unaccounted provider calls.

For each successful agent call, the backend records:

- Session, tick, and slot.
- Model.
- Full accepted prompt and the canonical completion returned to the caller.
- Input, reasoning, and output token counts, with an indication when the backend estimated them.
- End-to-end latency, including retries.

Agent-call telemetry is stored in backend-managed SQLite files keyed by execution scope. A live session has one telemetry file, while every match session in one leaderboard run shares the run's telemetry file. Recordings retain the session and run associations needed to query their successful calls. Public replay views show model, token, latency, and estimated-usage summaries. Stored accepted prompts and canonical completions are visible only to the agent owner and operators. See [Recording](recording.md) and [Frontend](frontend.md).

## Budgets and limits

Official execution and student development have separate meters. Each session slot has token, call, and rate limits; a leaderboard run carries no allowance of its own, and every match in a run is a new session with a fresh per-slot allowance. The deployment provides defaults, and a season may override the official and development limits independently. Every authenticated logical request admitted for upstream processing counts once in an in-memory sliding rate window, whether it succeeds or fails. Backend retry attempts do not add rate events. Durable call and token totals contain successful rows only, while conservative process-lifetime debt also reduces the remaining allowance after a post-upstream accounting failure.

The proxy accepts either `max_tokens` or `max_completion_tokens`, but not both. It applies a deployment-configured default when neither is present, rejects a requested maximum above the deployment's hard ceiling, and forwards the resulting maximum to the upstream. Admission reserves that enforced output maximum together with estimated input usage, so an explicit or default completion limit cannot bypass the remaining token allowance. A request that does not fit returns a normal, non-retryable budget error that the agent can handle, and the game continues.

The backend also exposes an authenticated OpenAI-compatible endpoint for student development. A participant requests a development key scoped to one season, and calls made with that key are charged only to that season's development meter for that participant. Successful development calls are recorded in a season-keyed SQLite ledger with the participant, model, token counts, whether those counts were estimated, latency, accepted prompt, and canonical completion. That ledger is visible only to the participant and operators. Development calls are never attached to a session recording or included in leaderboard usage.

## Determinism and timing

A seed does not make a model response deterministic. Seeded repetitions reduce the effect of stochastic policies but do not remove it.

During `act`, `chat`, or `learn`, time waiting for a model, including backend retries, counts toward the agent's step and episode limits. Calls during module import, construction, or `reset` are setup calls with null tick attribution and occur before turn timing. The automated board reports successful-call timing and token use by model. See [Leaderboards](leaderboard.md).
