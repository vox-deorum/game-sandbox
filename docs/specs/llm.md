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

The backend owns the OpenAI-compatible endpoint exposed to agents and students. It holds the upstream credential, enforces the allowed models and budgets, and forwards requests to one deployment-configured OpenAI-compatible endpoint. That upstream may itself be a gateway or multi-provider router. Game Sandbox does not implement provider routing, provider failover, or a separate LLM gateway service.

Session containers cannot reach the general internet. When LLM access is enabled, their only permitted network endpoint is the backend LLM proxy. This keeps model use sanctioned and comparable across participants while preserving the broader rule that agents cannot contact arbitrary outside services. See [Execution](execution.md).

The backend handles upstream reliability. It retries retryable failures with exponential backoff, starting from a deployment-configurable interval and stopping after a deployment-configurable maximum number of retries following the initial attempt. It returns non-retryable upstream errors immediately in an OpenAI-compatible error response. If the retry limit is exhausted, it returns the final failure without turning it into a successful call.

## Successful-call accounting

Only a request that receives a successful upstream response is metered or recorded. Rejected requests, non-retryable upstream errors, and retry sequences that never succeed consume no token or call budget and create no LLM telemetry record. Retries belong to the original request, so a request that eventually succeeds is counted and recorded once using the successful response's usage.

For each successful agent call, the backend records:

- Session, tick, and slot.
- Model.
- Full prompt and completion.
- Input, reasoning, and output token counts.
- End-to-end latency, including retries.

Agent-call telemetry is stored beside the recording as a versioned sidecar. Public replay views show model, token, and latency summaries. Full prompts and completions are visible only to the agent owner and operators. See [Recording](recording.md) and [Frontend](frontend.md).

## Budgets and limits

Official execution and student development have separate meters. Each live session and leaderboard run has token, call, and rate limits. The deployment provides defaults, and a season may override the official and development limits independently. A call over budget returns a normal, non-retryable API error that the agent can handle, and the game continues.

The backend also exposes an authenticated OpenAI-compatible endpoint for student development. A participant requests a development key scoped to one season, and calls made with that key are charged only to that season's development meter for that participant. Successful development calls are recorded in a season-keyed development ledger with the participant, model, token counts, latency, full prompt, and completion. That ledger is visible only to the participant and operators. Development calls are never attached to a session recording or included in leaderboard usage.

## Determinism and timing

A seed does not make a model response deterministic. Seeded repetitions reduce the effect of stochastic policies but do not remove it.

Time waiting for a model, including backend retries, counts toward the agent's step and episode limits. The automated board reports successful-call timing and token use by model. See [Leaderboards](leaderboard.md).
