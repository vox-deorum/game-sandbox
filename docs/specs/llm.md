# LLM API for Agents

Agents may call language models through an OpenAI-compatible API provided by the deployment. The capability is optional and may be disabled by the environment or season.

## What agents see

Agent code reads:

- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`

The same code works locally and on the server. For local development, a participant requests a season-scoped development key from the backend. For a server-run session, the backend creates a temporary key for one session and player, then revokes it when the container exits. See [Submissions](submission.md).

## Backend proxy and upstream

```text
Agent call ───────────────┐
                         ├→ backend LLM proxy → configured OpenAI-compatible endpoint
Student development call ┘          │
                                    └→ access checks, metering, and telemetry
```

The backend owns the endpoint used by agents and students. It holds the upstream credential, enforces enabled model aliases and budgets, and forwards admitted requests to the deployment's configured OpenAI-compatible endpoint.

Agents request one stable public model alias: `small`, `medium`, or `large`. The proxy maps that alias to its configured upstream model. In successful responses, the proxy keeps standard generated content and usage fields, replaces structured provider model identifiers with the public alias, and removes nonstandard top-level provider metadata. It returns and records the same canonical completion. It does not rewrite generated assistant content or tool arguments as metadata.

The upstream endpoint may itself route to several providers. Game Sandbox does not add provider routing or failover.

Session containers cannot reach the general internet. When LLM access is enabled, their only permitted network endpoint is the backend LLM proxy. See [Execution](execution.md).

The backend retries eligible upstream failures with exponential backoff. The deployment sets the initial interval and retry count. A failure that cannot be retried, or a sequence that exhausts its retries, returns an OpenAI-compatible error and is not a successful call.

Streaming is unsupported. A rate-limit refusal returns `429 rate_limit_exceeded`. A request over budget returns `400 budget_exceeded`. An accounting failure after an upstream success returns `503 meter_unavailable`.

## Successful-call accounting

The proxy finalizes one logical request at most once, including all of its retries:

| Outcome | Accounting and telemetry | Response |
| --- | --- | --- |
| Rejected before upstream, or upstream never succeeds | No token usage or call telemetry is committed. Pending capacity is released. | OpenAI-compatible error |
| Upstream succeeds and accounting commits | Actual or estimated usage consumes budget and produces telemetry. | Canonical completion |
| Upstream succeeds but accounting cannot commit | No partial success row is written. The conservative in-memory charge remains and further calls in that scope fail closed. | `503 meter_unavailable` |

The backend commits accounting before returning a completion. A successful storage health check reopens a blocked scope without forgiving its conservative charge.

The backend uses valid usage counts from the successful response. Otherwise it estimates input and output tokens from the accepted request and canonical completion. It preserves a reported reasoning-token count when available and uses zero otherwise. Estimated calls and every aggregate derived from them are marked as estimated and consume budget normally.

For each successful agent call, the backend records:

- Session, tick, and player.
- Model.
- Full accepted prompt and the canonical completion returned to the caller.
- Input, reasoning, and output token counts, with an indication when the backend estimated them.
- End-to-end latency, including retries.

Telemetry is keyed by execution scope. A live session has its own scope, while all matches in one leaderboard run share a run scope. Recordings retain the links needed to find their successful calls.

Public replay views show summaries of models, tokens, and budget cost. Stored accepted prompts and canonical completions are visible only to an operator or the current owner of the controlling submission. If that submission is deleted, its former owner keeps access to metadata but loses access to request and completion bodies. A recording without an LLM association has an empty telemetry result. If an associated telemetry scope cannot be read, its result is unavailable rather than empty. See [Recording](recording.md) and [Frontend](frontend.md).

## Budgets and limits

Token budgets use weighted units for each model alias. The cost of a successful call is the alias's configured price multiplied by the sum of its input tokens and total completion tokens. Reasoning tokens are already included in total completion tokens and are not charged twice. Deployment prices default to 4 for `large`, 2 for `medium`, and 1 for `small`. A season may set the price of any enabled alias to a positive finite value no greater than 1,000,000. Official leaderboard runs freeze their resolved prices as part of the run policy. Live sessions and development keys use the season's current resolved prices.

Official execution and student development use separate meters. Each player in a session has a weighted token budget and a rate limit. A leaderboard run has no allowance of its own. Each match in the run is a new session with a fresh allowance for each player. Creating a leaderboard run freezes its resolved official policy, including enabled aliases, upstream model mappings, prices, and per-player limits. The deployment supplies defaults, and a season may override official and development limits independently.

Budgets, rate limits, and telemetry stay keyed per player rather than per seat, so a seat that covers several players gets one meter for each of its players and therefore a proportionally larger total allowance, matching its proportionally larger number of decisions. When the leaderboard reduces a seat, it sums LLM usage and weighted cost across the seat's players.

Each admitted request holds one pending unit in its player's sliding rate window. Retries belong to that unit. An eventual success records one rate event at the request's start unless the pending unit has already expired from the window. A request that never succeeds releases the unit without an event. Recorded events and active pending units together determine whether another request is admitted.

Rate events are separate from durable successful-call telemetry. A request that outlives the rate window can lose its rate event and still commit its successful call and token usage. Conservative charges after accounting failures reduce the remaining token allowance for the life of the process.

An upstream-successful request records its rate event, unless the pending unit expired, even when durable accounting later fails and the caller receives `503 meter_unavailable`.

The proxy accepts either `max_tokens` or `max_completion_tokens`, but not both. When neither is present, it applies the deployment's default. It rejects a requested maximum above the deployment's hard limit and forwards the resulting maximum to the upstream. Before admission, the proxy reserves the enforced output maximum plus estimated input usage. Neither an explicit nor a default completion limit can bypass the remaining token allowance. A request that does not fit receives a normal budget error that the agent can handle, with no retry, and the game continues.

The backend also provides an authenticated OpenAI-compatible endpoint for student development. A participant may request or use a development key only while that season's submission window is open and the season has effective LLM access. Closing submissions immediately disables existing keys. Calls made with a development key count only against that participant's development meter for the season.

Successful development calls record the participant, model, token counts, estimation status, latency, accepted prompt, and canonical completion under that season. Only the participant and operators can view them. Development calls are never attached to a recording or included in leaderboard usage.

## Determinism and timing

A seed does not make a model response deterministic. Seeded repetitions reduce the effect of stochastic policies but do not remove it.

In an official session, chargeable time for `act`, `chat`, and `learn` excludes verified time in the backend proxy, including retry waits. Calling-thread CPU time remains chargeable. If the proxy-time readings around a hook are unavailable or invalid, the full hook time is charged. Model calls and local work must remain on that thread.

Live-session and leaderboard-run timeouts also exclude verified proxy time after they start. The extra allowance for an active request is bounded, so a stuck request cannot extend the deadline indefinitely. Idle timeout always uses wall-clock time.

Calls during module import, construction, or `reset` are setup calls with null tick attribution and occur before turn timing. The automated board reports successful-call counts and token use by model. See [Leaderboards](leaderboard.md).
