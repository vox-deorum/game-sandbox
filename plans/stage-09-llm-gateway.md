# Stage 9: LLM API

Status: in progress (Steps 1 through 6 complete; remaining build order planned under [stage-09/](stage-09/)).

## Goal

Agents and students call an OpenAI-compatible API owned by the backend. The backend forwards each logical request to one configured OpenAI-compatible upstream, handles retries and terminal errors, enforces separate official and development limits, and meters and records only successful requests.

Agent telemetry is stored in backend-managed SQLite files keyed by execution scope. Public replay views expose model, token, and authoritative budget-cost metadata. Prompt and completion bodies are visible only to the controlling submission's owner and operators. Student development calls use a private season-keyed SQLite ledger and never contribute to recording telemetry or leaderboards. Latency remains internal reliability telemetry and is not shown in frontend surfaces.

## Architecture

```text
Session agent ── internal network ──┐
                                    ├→ backend LLM proxy → one OpenAI-compatible upstream
Student client ── public API ───────┘          │
                                               ├→ official execution-scope SQLite
                                               └→ development season SQLite
```

The backend implements authentication, model-tier mapping, limits, retries, error translation, metering, and telemetry. The configured upstream may be a provider endpoint or an operator-managed gateway. Game Sandbox implements no provider routing, provider failover, or separate gateway service.

Agents request one stable model tier: `small`, `medium`, or `large`. Deployment configuration maps each enabled tier to one upstream model name. Season configuration selects a subset of those tiers and independently overrides official and development limits. Live sessions and development calls use the current effective deployment and season configuration. Creating a leaderboard run resolves and stores its complete official LLM policy, including the enabled tiers, their upstream model mappings, and its per-slot limits, so later workflow matches never fall back to changed deployment defaults or season values.

Streaming requests are rejected with `400 streaming_unsupported`. Authentication, model, rate, and budget failures use OpenAI-compatible error bodies. Budget exhaustion uses the non-retryable `400 budget_exceeded` code so agent fallback logic can continue the episode.

## Reliability and accounting

The backend configures the OpenAI client with `LLM_UPSTREAM_MAX_RETRIES` and a per-request `LLM_UPSTREAM_TIMEOUT_MS`. The client retries connection failures, timeouts, upstream 408, 409, 429, and 5xx responses with its built-in backoff. Other upstream 4xx responses are returned immediately. An exhausted retry sequence returns its final error.

Each admitted inbound request is one logical request across every upstream attempt. Limits exist in exactly two scopes, each with a weighted token budget and a requests-per-minute limit: the agent slot within a session, and the development `(participant, season)` pair. Leaderboard runs have no allowance of their own. Admission creates temporary token and rate-capacity reservations using a tiktoken input estimate and an enforced output maximum. A successful upstream response converts the pending rate capacity into one event timestamped at the logical request's start; a success whose start has already left the sliding window retains no event, since that event could no longer affect admission. If post-processing and the durable write complete, it commits either validated upstream usage or explicitly marked tiktoken estimates, writes one record, and reports latency across all attempts and backoff waits. A rejected request or terminal upstream failure releases every pending reservation, consumes no allowance, and writes no telemetry or development-ledger row. A durable-record failure retains the successful rate event and makes its accounting scope unavailable. Backend retry attempts do not consume additional rate capacity or events.

Successful-call accounting commits before the completion is returned for both official and development traffic. If telemetry or ledger persistence fails after the upstream succeeds, the proxy marks the accounting scope unavailable and returns `503 meter_unavailable`. Further calls for that scope remain blocked until the backend restarts. Completion-normalization and usage-resolution failures release the reservation without marking storage unavailable.

Official hook timing follows the proxy-time contract in Step 3. Setup work has null tick attribution and is outside turn timing. Live-session and workflow watchdogs apply its bounded post-arm discount. Idle timeout remains wall-clock time.

Official limits apply per slot: every agent slot in a live session or workflow match has its own weighted token budget and rate limit, and every workflow match is a new session with a fresh allowance. Token budgets use model prices that default to large:medium:small = 4:2:1. Student development limits apply per participant per season. Deployment defaults exist for both groups, and a season may override limits and model prices.

## Access and isolation

Effective official access requires a configured upstream, an environment with LLM support, and a season with LLM enabled. Live sessions use the current play-open season. Workflow matches use the run's dedicated, fully resolved official LLM policy snapshot.

Each agent slot receives a temporary key scoped to its session, slot, telemetry scope, enabled model tiers, and official limits. Live sessions use their session ID as the telemetry scope. Workflow matches use the leaderboard run ID, so every match in one run shares one SQLite file, and derive their grants only from the run's stored official LLM policy. Teardown first closes the session's keys to new admission, then aborts or drains authenticated requests and awaits their reservation finalizers before aggregation, telemetry cleanup, or lifecycle completion. A per-session internal network exposes only the backend proxy relay to the session container.

An active participant requests a development key from `POST /api/seasons/:seasonId/llm-development-key` while that season's submissions are open and its LLM access is effective. The same conditions are checked for every development completion call. The key is scoped to that participant and season, and rotation invalidates the previous key. The response supplies the public `OPENAI_BASE_URL`, the key, enabled model tiers, resolved model prices, the token budget, and the rate limit.

## Records and surfaces

Official telemetry files live at `data/llm/<scopeId>.sqlite`. Every successful official call inserts one row containing session, tick, slot, model tier, full request and completion, input, reasoning, and output token counts, whether those counts were estimated, end-to-end latency, and the grant-resolved cost weight and budget cost units charged for that call. Tick markers sent by the harness attribute calls made during each participant hook. Durable scope and session IDs on recording metadata resolve a recording to its rows after producing session or workflow data is pruned.

Each season has a development ledger keyed by participant. Every successful development call records participant, model tier, full request and completion, token counts, whether those counts were estimated, and end-to-end latency. Participants can read only their own usage and rows. Operators can inspect every participant's rows for the season.

The replay API returns public official metadata and stored budget cost units for every successful call, plus the stored whole-recording total. It includes bodies only for the controlling submission's owner and operators. Ordinary and zero-success recordings return an empty telemetry result. Game results store successful usage by model tier and its weighted cost under the run's frozen prices. Automated boards and placements aggregate both values. Development access appears on the My Agents current-season row and in the agent profile's owner-only Development access section. Past-season call history remains available from submission-history rows.

## Spec references

[LLM API](../docs/specs/llm.md), [Execution](../docs/specs/execution.md), [Leaderboards](../docs/specs/leaderboard.md), [Frontend](../docs/specs/frontend.md), [Submissions](../docs/specs/submission.md), and [Recording](../docs/specs/recording.md).

## Depends on

Stage 3 provides orchestration and driver networking. Stage 5 provides submissions, profiles, and recording ownership. Stage 6 provides season configuration, workflows, boards, and the admin editor. Stage 7 provides multi-slot Hearts. Stage 8 provides the `chat` hook integration and the disabled-session Spades regression fixture. Stage 11 provides the semantic Hearts observations and action helpers used by the example. Stage 12 provides Better Auth identities, active-participant authorization, and operator access. Stage 10 is not a dependency.

## Build order

| # | Subplan | Builds | Hands-on result |
| --- | --- | --- | --- |
| 1 | [Backend LLM proxy](stage-09/1-metering-gateway.md) | Shared proxy handler, model-tier mapping, grant registry, successful-only execution-scope SQLite telemetry, retry and error policy, per-slot completed-proxy counter | A test grant calls a stub upstream; retryable failures recover once and terminal failures leave no usage row |
| 2 | [Season access, development keys, and session network](stage-09/2-enablement-keys-and-network.md) | Current live and development resolution, frozen workflow policy, independent limit blocks, slot-key lifecycle, per-participant and per-season development meter and ledger, internal network | A student key works only for its participant and season; a run keeps its original official policy; a container reaches the proxy but not the internet |
| 3 | [Harness credentials and student example](stage-09/3-harness-credentials-and-template-example.md) | Slot credential changes, tick and timing snapshots, template command, Hearts example, student guide | The same agent code runs with a season development key and with an injected session key |
| 4 | [Official usage aggregation](stage-09/4-usage-aggregation.md) | Successful usage aggregation over the run-scoped SQLite file, board and placement storage | A tiny per-slot budget produces a catchable error while completed calls appear on the board |
| 5 | [LLM surfacing APIs](stage-09/5-frontend-api.md) | Recording telemetry with stored budget costs, telemetry retention and cleanup, participant and operator development read APIs | Raw API calls prove empty, public, owner, participant, and operator response boundaries |
| 6 | [LLM usage UI](stage-09/6-frontend-ui.md) | Replay decision costs and authorized inspection, board model usage, My Agents and agent-profile development access, shared call history, operator usage details | Browser checks compare costs, credentials, and anonymous, owner, participant, and operator views |
| 7 | [Testing, CI, and documentation](stage-09/7-testing-ci-and-docs.md) | Full-stack retry, accounting, isolation, privacy, regression, and documentation gates | Docker integration and browser suites pass against one stub OpenAI-compatible upstream |

## Done when

- The backend calls exactly one configured OpenAI-compatible upstream and exposes no provider-routing service.
- Retryable failures follow the OpenAI client's retry policy and configured retry count. Non-retryable errors return immediately. Admission reserves rate capacity, an eventual upstream success retains one rate event, and a terminal failure releases the capacity without recording an event. Only a fully accounted success consumes the model-priced token units and creates one record.
- A leaderboard run stores a fully resolved official LLM policy at creation, and every workflow match uses that policy even if deployment defaults or season configuration later change.
- A student obtains a season-scoped development key, sees a private per-participant and per-season meter and ledger, and does not consume official limits. One successful logical request consumes one event in that pair's rate window across every retry, while terminal failure releases its pending rate capacity.
- A development key authorizes nothing after its season's submission window closes. Reopening submissions restores access under the current effective LLM policy.
- A development-ledger commit failure returns no completion and blocks that participant and season until the backend restarts.
- The template LLM example runs unchanged with development credentials in `.env` and injected slot credentials in a session.
- Session containers reach only the backend LLM proxy, and teardown drains or aborts authenticated work before temporary slot keys and telemetry scopes are retired.
- Official timing limits and watchdogs use the proxy-time discount contract above.
- Replays and automated boards derive successful usage and authoritative budget costs from durable official records, with prompt and completion bodies limited to current owners and operators.
- LLM-disabled sessions execute the unchanged non-LLM path and preserve deterministic recording fixtures.
