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

The backend owns the OpenAI-compatible endpoint used by agents and students. It holds the upstream credential, enforces enabled model aliases and budgets, and forwards requests to one OpenAI-compatible endpoint configured for the deployment.

Agents request one stable public model alias: `small`, `medium`, or `large`. The proxy maps that alias to its configured upstream model. In successful responses, the proxy keeps standard generated content and usage fields, replaces structured provider model identifiers with the public alias, and removes nonstandard top-level provider metadata. It returns and records the same canonical completion. It does not rewrite generated assistant content or tool arguments as metadata.

The upstream endpoint may be a gateway or a router for several providers. Game Sandbox does not provide its own provider routing, provider failover, or separate LLM gateway service.

Session containers cannot reach the general internet. When LLM access is enabled, their only permitted network endpoint is the backend LLM proxy. This keeps model use sanctioned and comparable across participants while preserving the broader rule that agents cannot contact arbitrary outside services. See [Execution](execution.md).

The backend handles upstream reliability. It retries eligible failures with exponential backoff. Both the initial backoff interval and maximum number of retries after the first attempt are deployment settings. The backend immediately returns an OpenAI-compatible error response for a failure that cannot be retried. When all retries fail, it returns the final failure and does not count the request as successful.

Streaming is unsupported. A rate-limit refusal returns `429 rate_limit_exceeded`. A request over budget returns `400 budget_exceeded`. An accounting failure after an upstream success returns `503 meter_unavailable`.

## Successful-call accounting

Only a request with a successful upstream response can become a committed call with token usage and LLM telemetry. Rejected requests, upstream errors that cannot be retried, and retry sequences that never succeed consume no token allowance and create no telemetry record. Retries remain part of the original request, so an eventual success is finalized at most once. A processing failure after upstream success creates no partial success row, but its conservative reservation remains charged for the life of the process under the failure rule below.

The backend uses the token counts from a successful response when they are valid. If an otherwise successful OpenAI-compatible response lacks valid usage, the backend estimates input and output tokens from the accepted request and canonical completion with its configured tokenizer. It uses the reported reasoning-token count when available and zero otherwise. The telemetry and every aggregate derived from it are marked as estimated. All participant strings are treated as ordinary content, including text that resembles a special tokenizer token. Estimated usage still consumes the token budget.

The backend commits accounting for a successful call before returning its completion. If any later step fails before accounting is durable, the backend keeps the request's conservative in-memory charge, returns a service error instead of the completion, and blocks further model requests in the affected accounting scope. A successful storage health check removes the block without forgiving that charge. If the processing failure persists, the next request can trigger the block again. This prevents tokenizer, normalization, or storage failures from enabling repeated provider calls that are never counted.

For each successful agent call, the backend records:

- Session, tick, and player.
- Model.
- Full accepted prompt and the canonical completion returned to the caller.
- Input, reasoning, and output token counts, with an indication when the backend estimated them.
- End-to-end latency, including retries.

Agent-call telemetry is stored in backend-managed SQLite files keyed by execution scope. A live session has one telemetry file. All match sessions in one leaderboard run share the run's telemetry file. Recordings retain the session and run links needed to find their successful calls.

Public replay views show summaries of models, tokens, and budget cost. Stored accepted prompts and canonical completions are visible only to an operator or the current owner of the controlling submission. If that submission is deleted, its former owner keeps access to metadata but loses access to request and completion bodies. A recording without an LLM association has an empty telemetry result. If an associated telemetry scope cannot be read, its result is unavailable rather than empty. See [Recording](recording.md) and [Frontend](frontend.md).

## Budgets and limits

Token budgets use weighted units for each model alias. The cost of a successful call is the alias's configured price multiplied by the sum of its input tokens and total completion tokens. Reasoning tokens are already included in total completion tokens and are not charged twice. Deployment prices default to 4 for `large`, 2 for `medium`, and 1 for `small`. A season may set the price of any enabled alias to a positive finite value no greater than 1,000,000. Official leaderboard runs freeze their resolved prices as part of the run policy. Live sessions and development keys use the season's current resolved prices.

Official execution and student development use separate meters. Each player in a session has a weighted token budget and a rate limit. A leaderboard run has no allowance of its own. Each match in the run is a new session with a fresh allowance for each player. Creating a leaderboard run freezes its resolved official policy, including enabled aliases, upstream model mappings, prices, and per-player limits. The deployment supplies defaults, and a season may override official and development limits independently.

Budgets, rate limits, and telemetry stay keyed per player rather than per seat, so a seat that covers several players gets one meter for each of its players and therefore a proportionally larger total allowance, matching its proportionally larger number of decisions. When the leaderboard reduces a seat, it sums LLM usage and weighted cost across the seat's players.

Each admitted request reserves one pending unit of rate capacity. The proxy rejects a new request when recorded events and pending units fill its in-memory sliding window. A concurrent request in progress therefore uses capacity before its result is known. A successful upstream response turns its pending unit into one recorded event, timestamped at the request's start. Rejected requests, errors that cannot be retried, and exhausted retry sequences release their pending units without recording an event. All retries for one request can produce at most the single event for an eventual success.

A pending unit expires when its start time leaves the rate window. A request that lasts longer than the window stops using capacity and records no event if it later succeeds. The rate window therefore limits successful request starts per minute and matches durable token totals, which include successful rows only. Conservative charges kept after accounting failures also reduce the remaining allowance for the life of the process.

The proxy accepts either `max_tokens` or `max_completion_tokens`, but not both. When neither is present, it applies the deployment's default. It rejects a requested maximum above the deployment's hard limit and forwards the resulting maximum to the upstream. Before admission, the proxy reserves the enforced output maximum plus estimated input usage. Neither an explicit nor a default completion limit can bypass the remaining token allowance. A request that does not fit receives a normal budget error that the agent can handle, with no retry, and the game continues.

The backend also provides an authenticated OpenAI-compatible endpoint for student development. A participant may request or use a development key only while that season's submission window is open and the season has effective LLM access. Closing submissions immediately disables existing keys. Calls made with a development key count only against that participant's development meter for the season.

Successful development calls are recorded in a SQLite ledger keyed by season. Each record includes the participant, model, token counts, whether the counts were estimated, latency, accepted prompt, and canonical completion. Only that participant and operators can view the ledger. Development calls are never attached to a session recording or included in leaderboard usage.

## Determinism and timing

A seed does not make a model response deterministic. Seeded repetitions reduce the effect of stochastic policies but do not remove it.

In an official session, chargeable time for `act`, `chat`, and `learn` excludes verified time in the backend proxy, including retry waits. The harness compares the player's proxy-time readings before and after each hook, then charges the remaining elapsed time to the step and episode limits. Chargeable time cannot be less than the calling thread's CPU time. If either reading is unavailable or invalid, the full hook time is charged. Model calls and local work must remain on that thread.

Live-session and leaderboard-run timeouts also exclude verified proxy time after they start. The extra allowance for an active request is bounded, so a stuck request cannot extend the deadline indefinitely. Idle timeout always uses wall-clock time.

Calls during module import, construction, or `reset` are setup calls with null tick attribution and occur before turn timing. The automated board reports successful-call counts and token use by model. See [Leaderboards](leaderboard.md).
