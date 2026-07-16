# Stage 9: LLM API

Status: in progress (Step 1 complete; remaining build order planned under [stage-09/](stage-09/)).

## Goal

Agents and students call an OpenAI-compatible API owned by the backend. The backend forwards each logical request to one configured OpenAI-compatible upstream, handles retries and terminal errors, enforces separate official and development limits, and meters and records only successful requests.

Agent telemetry is stored in backend-managed SQLite files keyed by execution scope. Public replay views expose model, token, and latency metadata. Prompt and completion bodies are visible only to the controlling submission's owner and operators. Student development calls use a private season-keyed SQLite ledger and never contribute to recording telemetry or leaderboards.

## Architecture

```text
Session agent ── internal network ──┐
                                    ├→ backend LLM proxy → one OpenAI-compatible upstream
Student client ── public API ───────┘          │
                                               ├→ official execution-scope SQLite
                                               └→ development season SQLite
```

The backend implements authentication, model aliases, limits, retries, error translation, metering, and telemetry. The configured upstream may be a provider endpoint or an operator-managed gateway. Game Sandbox implements no provider routing, provider failover, or separate gateway service.

Agents request the stable model aliases `large`, `medium`, and `small`. Deployment configuration maps each enabled alias to one upstream model name. Season configuration selects a subset of those aliases and independently overrides official and development limits. Live sessions and development calls use the current effective deployment and season configuration. Creating a leaderboard run resolves and stores its complete official LLM policy, including the enabled aliases, their upstream model mappings, and its per-slot limits, so later workflow matches never fall back to changed deployment defaults or season values.

Streaming requests are rejected with `400 streaming_unsupported`. Authentication, model, rate, and budget failures use OpenAI-compatible error bodies. Budget exhaustion uses the non-retryable `400 budget_exceeded` code so agent fallback logic can continue the episode.

## Reliability and accounting

The backend classifies connection failures, timeouts, upstream 408, 409, 429, and 5xx responses as retryable. It retries them with exponential backoff from `LLM_UPSTREAM_RETRY_INTERVAL_MS` for at most `LLM_UPSTREAM_MAX_RETRIES` attempts after the initial request. Other upstream 4xx responses are returned immediately. An exhausted retry sequence returns its final error.

Each admitted inbound request is one logical request across every upstream attempt and consumes one event in its rate window regardless of its terminal outcome. Limits exist in exactly two scopes, each with token, call, and requests-per-minute limits: the agent slot within a session, and the development `(participant, season)` pair. Leaderboard runs have no allowance of their own. Admission also creates temporary call and token reservations using a tiktoken input estimate and an enforced output maximum. A successful upstream response whose post-processing and durable write complete commits one call and either validated upstream usage or explicitly marked tiktoken estimates, writes one record, and reports latency across all attempts and backoff waits. A rejected request or terminal upstream failure releases its call and token reservations, consumes no call or token budget, and writes no telemetry or development-ledger row. A post-upstream accounting failure writes no partial row but retains its reservation as conservative debt. Backend retry attempts do not consume additional rate events.

Successful-call accounting commits before the completion is returned for both official and development traffic. If normalization, usage resolution, telemetry, or ledger persistence fails after the upstream succeeds, the proxy retains the conservative reservation as in-memory debt for every affected accounting scope, opens those scopes' circuit breakers, and returns `503 meter_unavailable`. Further calls for an affected scope remain blocked until the single-flight recovery loop commits a write-health check and closes the breaker; recovery retains the in-memory debt for the lifetime of the process.

Official limits apply per slot: every agent slot in a live session or workflow match has its own token, call, and rate limits, and every workflow match is a new session with a fresh allowance. Student development limits apply per participant per season. Deployment defaults exist for both groups, and a season may override them independently.

## Access and isolation

Effective official access requires a configured upstream, an environment with LLM support, and a season with LLM enabled. Live sessions use the current play-open season. Workflow matches use the run's dedicated, fully resolved official LLM policy snapshot.

Each agent slot receives a temporary key scoped to its session, slot, telemetry scope, allowed models, and official limits. Live sessions use their session ID as the telemetry scope. Workflow matches use the leaderboard run ID, so every match in one run shares one SQLite file, and derive their grants only from the run's stored official LLM policy. Teardown first closes the session's keys to new admission, then aborts or drains authenticated requests and awaits their reservation finalizers before aggregation, telemetry cleanup, or lifecycle completion. A per-session internal network exposes only the backend proxy relay to the session container.

An active participant requests a development key from `POST /api/seasons/:seasonId/llm-development-key`. The key is scoped to that participant and season, and rotation invalidates the previous key. The response supplies the public `OPENAI_BASE_URL`, the key, allowed model aliases, and resolved development limits.

## Records and surfaces

Official telemetry files live at `data/llm/<scopeId>.sqlite`. Every successful official call inserts one row containing session, tick, slot, model alias, full request and completion, input, reasoning, and output token counts, whether those counts were estimated, and end-to-end latency. Tick markers sent by the harness attribute calls made during each participant hook. Durable scope and session IDs on recording metadata resolve a recording to its rows after producing session or workflow data is pruned.

Each season has a development ledger keyed by participant. Every successful development call records participant, model alias, full request and completion, token counts, whether those counts were estimated, and end-to-end latency. Participants can read only their own usage and rows. Operators can inspect every participant's rows for the season.

The replay API returns public official metadata for every successful call and includes bodies only for the controlling submission's owner and operators. The automated board aggregates successful official usage by model alias. The participant profile exposes development-key rotation, remaining development allowance, and the participant's private development ledger.

## Spec references

[LLM API](../docs/specs/llm.md), [Execution](../docs/specs/execution.md), [Leaderboards](../docs/specs/leaderboard.md), [Frontend](../docs/specs/frontend.md), [Submissions](../docs/specs/submission.md), and [Recording](../docs/specs/recording.md).

## Depends on

Stage 3 provides orchestration and driver networking. Stage 5 provides submissions, profiles, and recording ownership. Stage 6 provides season configuration, workflows, boards, and the admin editor. Stage 7 provides multi-slot Hearts. Stage 8 provides the `chat` hook integration and the disabled-session Spades regression fixture. Stage 11 provides the semantic Hearts observations and action helpers used by the example. Stage 12 provides Better Auth identities, active-participant authorization, and operator access. Stage 10 is not a dependency.

## Build order

| # | Subplan | Builds | Hands-on result |
| --- | --- | --- | --- |
| 1 | [Backend LLM proxy](stage-09/1-metering-gateway.md) | Shared proxy handler, model aliases, grant registry, successful-only execution-scope SQLite telemetry, retry and error policy | A test grant calls a stub upstream; retryable failures recover once and terminal failures leave no usage row |
| 2 | [Season access, development keys, and session network](stage-09/2-enablement-keys-and-network.md) | Current live and development resolution, frozen workflow policy, independent limit blocks, slot-key lifecycle, per-participant and per-season development meter and ledger, internal network | A student key works only for its participant and season; a run keeps its original official policy; a container reaches the proxy but not the internet |
| 3 | [Harness credentials and student example](stage-09/3-harness-credentials-and-template-example.md) | Slot credential changes, tick markers, template command, Hearts example, student guide | The same agent code runs with a season development key and with an injected session key |
| 4 | [Official usage aggregation](stage-09/4-usage-aggregation.md) | Successful usage aggregation over the run-scoped SQLite file, board and placement storage | A tiny per-slot budget produces a catchable error while completed calls appear on the board |
| 5 | [LLM usage surfaces](stage-09/5-frontend-surfacing.md) | Replay metadata, owner debug view, board tokens, participant development-key and ledger view, operator ledger view | Browser checks prove public, owner, participant, and operator visibility boundaries |
| 6 | [Testing, CI, and documentation](stage-09/6-testing-ci-and-docs.md) | Full-stack retry, accounting, isolation, privacy, regression, and documentation gates | Docker integration and browser suites pass against one stub OpenAI-compatible upstream |

## Done when

- The backend calls exactly one configured OpenAI-compatible upstream and exposes no provider-routing service.
- Retryable failures follow the configured exponential schedule. Non-retryable errors return immediately. Every admitted logical request consumes one rate event, while only an eventual success consumes call and token limits and creates one record.
- A leaderboard run stores a fully resolved official LLM policy at creation, and every workflow match uses that policy even if deployment defaults or season configuration later change.
- A student obtains a season-scoped development key, sees a private per-participant and per-season meter and ledger, and does not consume official limits. One admitted logical request consumes one event in that pair's rate window across every retry and terminal outcome.
- A development-ledger commit failure returns no completion, retains conservative debt, and blocks that participant and season until the automatic recovery loop verifies writable storage and closes the breaker without forgiving debt in the running process.
- The template LLM example runs unchanged with development credentials in `.env` and injected slot credentials in a session.
- Session containers reach only the backend LLM proxy, and teardown drains or aborts authenticated work before temporary slot keys and telemetry scopes are retired.
- Replays, owner debug views, and automated boards derive their data from successful official SQLite rows with the required visibility boundaries.
- LLM-disabled sessions execute the unchanged non-LLM path and preserve deterministic recording fixtures.
