# Stage 9.1: Backend LLM Proxy

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 1.

## Outcome

The backend exposes an OpenAI-compatible proxy backed by one configured OpenAI-compatible upstream. It authenticates scoped grants, maps stable model aliases, applies rate and budget admission, retries retryable upstream failures, returns terminal errors in a compatible shape, and commits usage and telemetry only for successful logical requests.

The hands-on check uses a test grant and a stub upstream. A retryable failure followed by success produces one charge and one SQLite row. A non-retryable failure and an exhausted retry sequence produce no charge and no row.

## Backend proxy

Create `backend/src/llm/` with a shared request handler and an internal Fastify listener constructed in `backend/src/main.ts`. The listener starts only when `LLM_UPSTREAM_URL` and at least one model alias are configured.

| Route | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | Bearer-authenticated non-streaming chat completion request |
| `POST /internal/tick` | Bearer-authenticated official-call tick marker |

`stream: true` returns `400 streaming_unsupported`. The API does not expose model discovery because `large`, `medium`, and `small` are the complete public vocabulary. Every local error uses `{"error":{"message","type","code"}}`.

The shared handler accepts an authenticated `LlmGrant`, performs admission, calls the upstream service, and sends a successful result to the grant's meter and record sink. Step 2 mounts the same handler at the public development route and adds development grants.

The repository layout contains no standalone LLM service. Delete the reserved `gateway/` directory and update repository documentation that lists it.

## Model aliases

`LLM_MODEL_LARGE`, `LLM_MODEL_MEDIUM`, and `LLM_MODEL_SMALL` map public aliases to upstream model names. A grant carries the allowed alias subset. The proxy validates the requested alias, substitutes the configured upstream name before forwarding, and rewrites the response model back to the alias before returning or recording it.

Provider model names and the upstream credential never reach agents, telemetry, development ledgers, or public APIs.

## Official grants and key registry

`KeyRegistry` is an in-process registry injected into the proxy, orchestrator, and workflow runner:

```ts
type OfficialGrant = {
  kind: 'official'
  scopeId: string
  sessionId: string
  slot: string
  subjectId?: string
  runId?: string
  models: ModelAlias[]
  sessionLimits: LlmLimits
  runLimits?: LlmLimits
}
```

`issueOfficial(grant)` returns `sk-sandbox-` plus 32 random hexadecimal bytes. `authenticate(bearer)` returns the grant or null. `revokeSession(sessionId)` is idempotent and invalidates every key for that session.

Official keys remain in memory because a backend restart reaps the containers that hold them. Successful usage is durable in the grant's SQLite scope. Temporary reservations remain in memory and are released when their request finishes or the backend restarts.

## Successful-call admission and metering

`LlmLimits` contains token, call, and successful-requests-per-minute limits. The official meter queries committed successful usage from the scope's SQLite file and combines it with temporary in-memory reservations.

Admission runs in this order:

1. Authenticate the key.
2. Validate the model alias.
3. Reject streaming.
4. Check the successful-request rate window plus in-flight reservations.
5. Check committed call and token usage plus in-flight reservations.
6. Reserve one logical call and its estimated input and maximum output usage.

Input reservation uses request size at four bytes per token. Output reservation uses `max_tokens` when provided and one quarter of estimated input otherwise. Reservations protect concurrent requests and are never reported as usage.

An eventual success converts the reservation into one committed call using the upstream response's actual input, reasoning, and output token counts. Actual usage is committed in full even when tokenizer estimation causes it to cross the reserved amount; subsequent requests see the updated total, and the successful response is never discarded. A local rejection, non-retryable upstream response, timeout sequence, connection-failure sequence, or exhausted retry sequence releases the reservation and commits nothing. Budget rejection returns `400 budget_exceeded`; rate rejection returns 429.

## Upstream retries and errors

The official OpenAI Node client is configured with `maxRetries: 0` so `UpstreamCaller` owns one explicit retry loop. The loop uses these rules:

- Connection failures, request timeouts, and upstream 408, 409, 429, and 5xx responses are retryable.
- Other upstream 4xx responses are non-retryable and return immediately.
- `LLM_UPSTREAM_MAX_RETRIES` is the maximum number of attempts after the initial request.
- The wait before retry number `n` is `LLM_UPSTREAM_RETRY_INTERVAL_MS * 2^(n - 1)`.
- A bounded `LLM_UPSTREAM_TIMEOUT_MS` applies to each attempt.

All attempts belong to one logical request and one reservation. A successful result is recorded once. Its `latency_ms` covers every upstream attempt and backoff wait. An exhausted sequence returns the final upstream error. Connection and timeout failures use a 502 OpenAI-compatible envelope when no upstream body exists.

## Official telemetry SQLite

`ExecutionTelemetryStore` owns one better-sqlite3 file per execution scope at `data/llm/<scopeId>.sqlite`. A live session uses its session ID as `scopeId`. Every match session in one leaderboard run uses the run ID, so run-level accounting and aggregation query one shared file.

Each file contains successful calls only:

```sql
CREATE TABLE calls (
  id               INTEGER PRIMARY KEY,
  session_id       TEXT NOT NULL,
  slot             TEXT NOT NULL,
  subject_id       TEXT,
  tick             INTEGER,
  model            TEXT NOT NULL,
  request_json     TEXT NOT NULL,
  completion_json  TEXT NOT NULL,
  input_tokens     INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  output_tokens    INTEGER NOT NULL,
  latency_ms       INTEGER NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX calls_session_slot ON calls (session_id, slot);
CREATE INDEX calls_subject ON calls (subject_id);
CREATE INDEX calls_created_at ON calls (created_at);
```

The proxy stores the full accepted request and full successful completion. Rows contain no failure status or error field. The successful insert is a transaction that commits before the proxy returns the response. Session limits query by `(session_id, slot)`. Run limits query by `subject_id` within the run-scoped file. Successful-request rate windows query `created_at` with the same filters.

Scope IDs are validated opaque identifiers and never interpolated into SQL. `PRAGMA user_version` versions the file schema, and startup applies explicit migrations before queries run. The store manages file creation, prepared statements, connection reuse, and closure. It closes a cached handle before retention deletes the file. Step 5 connects file retention to the session, run, and recording lifecycle and removes orphan files during startup.

`POST /internal/tick` updates the latest marker on the authenticated official grant. `{"phase":"setup"}` sets a null tick. `{"tick":N}` sets the active tick. One grant cannot update another grant's marker.

Step 3 sends the markers. Step 4 queries execution-scope SQLite for game-result aggregation. Step 5 resolves recordings to their session or run scope and serves matching rows through the recording API.

## Configuration

Add these deployment settings in `backend/src/config.ts`:

| Variable | Purpose |
| --- | --- |
| `LLM_INTERNAL_PORT` | Backend proxy port reached through the session relay |
| `LLM_UPSTREAM_URL`, `LLM_UPSTREAM_KEY` | Single OpenAI-compatible upstream and its credential |
| `LLM_MODEL_LARGE`, `LLM_MODEL_MEDIUM`, `LLM_MODEL_SMALL` | Public alias to upstream-model mappings |
| `LLM_UPSTREAM_TIMEOUT_MS` | Timeout for each upstream attempt |
| `LLM_UPSTREAM_MAX_RETRIES` | Retry attempts after the initial request |
| `LLM_UPSTREAM_RETRY_INTERVAL_MS` | Initial exponential-backoff interval |
| `LLM_SESSION_TOKEN_BUDGET`, `LLM_SESSION_CALL_BUDGET`, `LLM_SESSION_RATE_LIMIT_RPM` | Official per-slot session defaults |
| `LLM_RUN_TOKEN_BUDGET`, `LLM_RUN_CALL_BUDGET`, `LLM_RUN_RATE_LIMIT_RPM` | Official per-submission run defaults |

Secrets use the existing secret-loading conventions and never appear in logs or errors.

## Tests

Docker-free backend tests use fake timers and a stub OpenAI-compatible upstream:

- Missing, malformed, unknown, and revoked keys return 401 without reaching the upstream.
- Model aliases map in both directions, and disallowed aliases return `model_not_allowed`.
- Streaming, rate, and budget rejections use the pinned OpenAI-compatible envelope and create no SQLite row.
- First-attempt success commits one call with actual usage and one durable SQLite row.
- Retryable failures followed by success use the exact exponential intervals, commit once, and include retry waits in latency.
- A non-retryable upstream 4xx makes one attempt, returns immediately, releases its reservation, and records nothing.
- Exhausted connection, timeout, 408, 409, 429, and 5xx sequences make the configured number of attempts, return the final error, release the reservation, and record nothing.
- Concurrent reservations prevent the successful-call and token limits from being crossed by simultaneous requests.
- Tick markers are isolated per grant and stamp setup calls with null and acted calls with their current tick.
- Session, run-subject, rate-window, and model aggregation queries return exact sums from successful rows.
- File creation sets the current `user_version`, migrations advance older fixtures, and retention closes cached handles before deletion.
- Full request and completion bodies round-trip through the SQLite row codec.

## Done when

- One backend handler forwards non-streaming requests to one configured OpenAI-compatible upstream.
- The explicit retry loop follows the configured attempt count and exponential intervals.
- Successful logical requests consume one call and write one official SQLite row. Every unsuccessful path consumes no call or token budget and writes no row.
- Official grants enforce model, session, run, and rate boundaries and can be revoked by session.
- SQLite rows contain full successful request and completion bodies and authoritative session, slot, subject, tick, model, token, and latency fields.
- Docker-free tests cover every retry class, reservation release, compatible error shape, and successful-only accounting rule.
