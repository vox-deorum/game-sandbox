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

Agents request one stable public model alias: `small`, `medium`, or `large`. The proxy maps that alias to its configured upstream model. In successful responses, the proxy keeps standard generated content and usage fields, replaces structured provider model identifiers with the public alias, and removes nonstandard top-level provider metadata. These rewrites never touch generated assistant content or tool arguments. The canonical completion it returns is the same one it records.

The upstream endpoint may itself route to several providers. Game Sandbox does not add provider routing or failover.

Session containers cannot reach the general internet. When LLM access is enabled, their only permitted network endpoint is the backend LLM proxy. See [Execution](execution.md).

The backend uses the OpenAI client retry policy for eligible upstream failures. The deployment sets the retry count, and the client applies its built-in backoff. A failure that cannot be retried, or a sequence that exhausts its retries, returns an OpenAI-compatible error and is not a successful call.

Streaming is unsupported. A rate-limit refusal returns `429 rate_limit_exceeded`. A request over budget returns `400 budget_exceeded`.

## Successful-call accounting

The proxy finalizes each logical request at most once, retries included:

| Outcome | Accounting and telemetry | Response |
| --- | --- | --- |
| Rejected before upstream, or upstream never succeeds | No token usage or call telemetry is committed. Pending capacity is released. | OpenAI-compatible error |
| Upstream succeeds and accounting commits | Actual or estimated usage consumes budget and produces telemetry. | Canonical completion |
| Upstream succeeds but the durable record cannot commit | No partial usage record is committed. Further calls in that scope fail closed until the backend restarts. | `503 meter_unavailable` |
| Upstream succeeds but the completion cannot be normalized or its usage resolved | No usage record is committed and no budget is consumed. The scope stays available and the unaccounted spend is logged. | `500 internal_error` |

For each successful agent call, the backend records:

- Session, tick, and player.
- Model.
- Full accepted prompt and the canonical completion returned to the caller.
- Input, reasoning, and output token counts, with an indication when the backend estimated them.
- End-to-end latency, including retries.

The backend commits accounting before returning a completion.

Before an admitted request can reach the provider, the backing telemetry store completes a write/readback preflight. A preflight failure rejects that request with `503 meter_unavailable`; the next request retries the preflight because no provider spend occurred.

The backend uses the successful response's usage counts when they are valid. Otherwise it estimates input and output tokens from the accepted request and canonical completion. It preserves a reported reasoning-token count when available and uses zero otherwise. Estimated calls and every aggregate derived from them are marked as estimated and consume budget normally.

Telemetry is keyed by execution scope. A live session has its own scope, while all matches in one automated run share a run scope. Recordings retain the links needed to find their successful calls.

Public replay views show summaries of models, tokens, and budget cost. The replay decision table shows an LLM cost column only when the environment metadata declares LLM capability. In a capable environment, empty telemetry displays `None` and unreadable associated telemetry displays the unavailable state. Stored accepted prompts and canonical completions are visible only to an operator or the current owner of the controlling submission. If that submission is deleted, its former owner keeps access to the metadata but not to the request and completion bodies. A recording without an LLM association has an empty telemetry result. If an associated telemetry scope cannot be read, its result is unavailable rather than empty. See [Recording](recording.md) and [Frontend](frontend.md).

## Budgets and limits

### Pricing

Token budgets use weighted units for each model alias. The cost of a successful call is the alias's configured price multiplied by the sum of its input tokens and total completion tokens. Reasoning tokens are already included in total completion tokens and are not charged twice. Deployment prices default to 4 for `large`, 2 for `medium`, and 1 for `small`. A season may set the price of any enabled alias to a positive finite value no greater than 1,000,000. Official automated runs freeze their resolved prices as part of the run policy. Live sessions and development keys use the season's current resolved prices.

The proxy accepts either `max_tokens` or `max_completion_tokens`, but not both. When neither is present, it applies the deployment's default. It rejects a requested maximum above the deployment's hard limit and forwards the resulting maximum to the upstream. Before admission, the proxy reserves the enforced output maximum plus estimated input usage. Neither an explicit nor a default completion limit can bypass the remaining token allowance. A request that does not fit is not retried. It receives a normal budget error the agent can handle, and the game continues.

### Rate limits

Official execution and student development use separate meters. Each player in a session has a weighted token budget and a rate limit. An automated run has no allowance of its own; each of its matches is a new session with a fresh allowance for each player. Creating an automated run freezes its resolved official policy, including enabled aliases, upstream model mappings, and per-player limits. The deployment supplies defaults, and a season may override official and development limits independently.

Budgets, rate limits, and telemetry stay keyed per player rather than per seat, so a seat that covers several players gets one meter for each of them, and its total allowance grows in proportion to its number of decisions. When the leaderboard reduces a seat, it sums LLM usage and weighted cost across the seat's players.

Each admitted request holds one pending unit in its player's sliding rate window. Retries belong to that unit. An eventual success records one rate event at the request's start unless the pending unit has already expired from the window. A request that never succeeds releases the unit without an event. Recorded events and active pending units together determine whether another request is admitted.

Rate events are separate from durable successful-call telemetry. A request that outlives the rate window can lose its rate event and still commit its successful call and token usage. A durable-record failure blocks the request's scope for the rest of the backend process.

Even when durable accounting later fails and the caller receives `503 meter_unavailable`, an upstream-successful request still records its rate event unless its pending unit expired.

### Student development access

The backend also provides an authenticated OpenAI-compatible endpoint for student development. A participant may request or use a development key only while the key's season has an open submission window and effective LLM access. Closing submissions immediately disables existing keys. Calls made with a development key count only against that participant's development meter for the season.

Successful development calls record the participant, model, token counts, estimation status, latency, accepted prompt, and canonical completion under that season. Only the participant and operators can view them. Development calls are never attached to a recording or included in leaderboard usage.

## Determinism and timing

A seed does not make a model response deterministic. Seeded repetitions reduce the effect of stochastic policies but do not remove it.

In an official session, time a hook spends waiting on verified proxy calls is not charged to the player. The discount can reduce a hook's charge only down to the CPU time the hook thread itself used. This applies to the `act`, `chat`, and `learn` hooks and covers retry waits. A valid post-hook proxy reading becomes the next hook's baseline, so the steady-state path needs only one synchronous read per hook. A request still in flight between two hooks is discounted from the later one. If a required reading is unavailable or invalid, the full hook time is charged.

Local agent computation must run on the hook thread. A normal model call also runs there and blocks the hook until it finishes. The template's background-request helper (`sandbox.llm.BackgroundLLM`) may instead keep one plain-text request in flight on a thread the helper owns, allowing the agent to collect the result from a later hook or tick. The helper captures the active player's base URL and key inside the calling hook. Students do not create threads, and the harness provides no submit, poll, or scheduling API.

The hook discount reads total verified proxy time, including a request marked as background. Synchronous requests keep the charging behavior described above.

Once they start, live-session and automated-run timeouts exclude only verified blocking proxy time. A background-marked request never extends either watchdog. Each blocking request's allowance is bounded, so a stuck request or long provider-directed retry wait cannot extend the deadline indefinitely. Idle timeout always uses wall-clock time.

A successful official call is attributed to the player's tick marker that the proxy snapshots when it admits the request. A synchronous request therefore keeps its current tick. A cross-tick background request keeps the tick on which it was admitted even if accounting commits later. Calls admitted during module import, construction, or `reset` are setup calls with null tick attribution and occur before turn timing. The automated board reports successful-call counts and token use by model. See [Leaderboards](leaderboard.md#automated-board).
