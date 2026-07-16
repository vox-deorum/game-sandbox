# Stage 9.1: Backend LLM Proxy

Status: complete.

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

`LLM_MODEL_LARGE`, `LLM_MODEL_MEDIUM`, and `LLM_MODEL_SMALL` map public aliases to upstream model names. A grant carries its resolved alias-to-upstream-model map. The proxy validates the requested alias against that map, substitutes its upstream name before forwarding, and constructs the returned and recorded completion from the standard OpenAI-compatible response fields. It rewrites the top-level model and structured moderation-model fields to the public alias, preserves generated content and tool arguments unchanged, and drops the deprecated backend fingerprint and nonstandard top-level provider metadata. Live and development grant construction uses the current effective map, while workflow grant construction uses the map frozen in `season_runs.llm_policy_snapshot`.

Provider model identifiers from protocol metadata and the upstream credential never reach agents, telemetry, development ledgers, or public APIs. Compatible terminal error fields replace the configured upstream model name with the public alias. Generated assistant content remains opaque model output and is not rewritten as metadata redaction.

## Official grants and key registry

`KeyRegistry` is an in-process registry constructed with the proxy. Step 2 injects that same process-owned registry into the orchestrator and workflow runner when those launch paths begin issuing grants:

```ts
type LlmAccountingScope = {
  key: string
  limits: LlmLimits
  readCommittedUsage: () => LlmUsage
}

type LlmGrant = {
  kind: 'official' | 'development'
  models: Partial<Record<ModelAlias, string>>
  accountingScopes: LlmAccountingScope[]
  recordSink: LlmRecordSink
}

type OfficialKeyEntry = {
  sessionId: string
  grant: LlmGrant
  tick: OfficialTickMarkerRef
}
```

Official identities do not become fields the shared handler interprets. Grant construction captures session, slot, telemetry scope, and optional run subject in the committed-usage readers and `recordSink`. Every committed-usage reader is synchronous and reads the same durable store and dimensions that the grant's record sink updates, so a grant cannot observe usage from a different accounting source. Step 2 grant factories construct those readers and the sink from one execution or development scope rather than wiring them independently. The grant also creates one mutable `OfficialTickMarkerRef`; the official record sink captures that reference and reads its current setup-or-tick value when it builds a telemetry row. `KeyRegistry` stores the same reference in an `OfficialKeyEntry` so lifecycle revocation and marker updates remain official-key concerns.

`issueOfficial(sessionId, grant, tick)` returns `sk-sandbox-` plus 32 random hexadecimal bytes. `authenticateGrant(bearer)` returns the entry's generic grant for the chat-completion handler, while `authenticateOfficial(bearer)` returns the full official entry for `/internal/tick` and rejects development keys. `revokeSession(sessionId)` is idempotent and invalidates every official entry for that session.

Official keys remain in memory because a backend restart reaps the containers that hold them. Successful usage is durable in the grant's SQLite scope. Temporary reservations and conservative debt are process-lifetime state. Reservations are released when their request finishes or the backend restarts, and debt disappears only when that backend process exits.

## Successful-call admission and metering

`LlmLimits` contains token, call, and logical-requests-per-minute limits. The shared handler does not encode official session or run identities. Each authenticated grant supplies one or more accounting scopes, and each scope contains a stable accounting key, its limits, and a committed-usage reader. The grant separately supplies the one durable record sink used after success. Official grants construct accounting keys for the slot within a session and, when applicable, the submission within a run. Step 2 constructs one development key for the participant within the season.

Call and token accounting combines committed successful usage from each scope's SQLite store with temporary in-memory reservations and conservative charged debt. Rate accounting uses an in-memory sliding window for each accounting key. Committed-usage reads, all scope checks, and the reservation mutation run in one synchronous event-loop section, so a completed durable commit cannot disappear between the committed snapshot and the in-memory reservation. Reservations, rate events, circuit breakers, recovery probes, and debt are all keyed by the same generic accounting key, so official and development grants use the same admission algorithm without sharing allowance.

Admission runs in this order:

1. Authenticate the key.
2. Validate the model alias.
3. Reject streaming.
4. Reject a request that supplies both `max_tokens` and `max_completion_tokens`, or a maximum above the deployment hard ceiling.
5. Check the scope circuit breaker and committed call and token usage plus in-flight reservations.
6. Atomically reserve one logical call and its estimated input and enforced maximum output usage, check the sliding rate window, and append one rate event when admission succeeds.

Input reservation uses the configured tiktoken encoding over the accepted request. Request and completion JSON are encoded as ordinary text, so participant content that spells a tokenizer special token remains data and cannot trigger a tokenizer control-token error. Output reservation recognizes either `max_tokens` or `max_completion_tokens`. The two fields are mutually exclusive. An explicit value must not exceed `LLM_MAX_OUTPUT_TOKENS`; when both are absent, the proxy uses `LLM_DEFAULT_MAX_OUTPUT_TOKENS`. The proxy forwards exactly one maximum-output field carrying the enforced value, and admission rejects the request with `budget_exceeded` when estimated input plus that value does not fit every applicable token allowance. This makes the configured maximum, rather than an input-size heuristic or an upstream default, the bound on completion overshoot.

Each admitted logical inbound request appends one event to every applicable in-memory rate window before the upstream call. Its backend retry attempts append no events. Event retention does not depend on the upstream outcome, so a non-retryable error or exhausted retry sequence still occupies one request-per-minute slot. Local authentication, model, streaming, malformed-maximum, circuit-breaker, rate, and budget rejections never reach the upstream and do not append an admitted-request event. A rate rejection returns 429.

An eventual success first constructs the canonical completion described under model aliases, then validates its usage object. Valid counts commit with `usage_estimated = 0`. When usage is absent or malformed, the proxy estimates input tokens from the accepted request and output tokens from that same canonical completion with the configured tiktoken encoding, preserves an independently exposed non-negative reasoning-token count or uses zero, and commits with `usage_estimated = 1`. Both cases consume one successful call and their committed token counts in full. Subsequent requests see the committed total, and the successful response is never discarded merely because actual usage crosses the reservation through tokenizer variance. A local rejection, non-retryable upstream response, timeout sequence, connection-failure sequence, or exhausted retry sequence releases its call and token reservation and commits nothing. Budget rejection returns `400 budget_exceeded`.

The telemetry transaction must commit before the proxy returns a successful completion. Once the upstream returns success, any later failure before durable accounting completes, including usage validation, fallback estimation, completion normalization, or the SQLite transaction, moves the conservative call and token reservation into in-memory charged debt, trips a circuit breaker for every accounting scope that request used, and returns `503 meter_unavailable` instead of the completion. Debt is no longer an active reservation, so teardown can settle, but it remains included in subsequent usage calculations. Requests rejected by an open breaker never reach the upstream.

An open breaker starts one single-flight recovery loop after `LLM_METER_RECOVERY_INTERVAL_MS`. The affected store's health probe opens the same SQLite file, begins a write transaction, upserts and reads back a singleton row in a small `meter_health` table, and commits. Failure leaves the breaker open and schedules the next bounded-interval probe. Success closes the breaker for new admission but does not release or turn the conservative debt into spendable allowance. On startup, each configured store completes schema initialization and this write-health transaction before its accounting scope can admit requests. The failure and recovery transitions are logged without request bodies or secrets. This exceptional path may lack a telemetry row, but the open breaker prevents repeated unaccounted calls within the running backend process. A trusted operator restart clears process-lifetime debt, as it clears reservations and rate windows, only after startup has verified that the store is writable again.

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
  usage_estimated  INTEGER NOT NULL,
  latency_ms       INTEGER NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX calls_session_slot ON calls (session_id, slot);
CREATE INDEX calls_subject ON calls (subject_id);
CREATE INDEX calls_created_at ON calls (created_at);

CREATE TABLE meter_health (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  checked_at TEXT NOT NULL
);
```

The proxy stores the full accepted request and the canonical successful completion returned to the caller. Rows contain no failure status or error field. `usage_estimated` is 0 for validated upstream usage and 1 for tokenizer fallback, and row codecs and aggregates preserve that distinction. The successful insert is a transaction that commits before the proxy returns the response. Session limits query by `(session_id, slot)`. Run limits query by `subject_id` within the run-scoped file. Rate windows remain in memory and never infer admitted requests from successful telemetry rows.

Scope IDs are validated opaque identifiers and never interpolated into SQL. `PRAGMA user_version` versions the file schema, and startup applies explicit migrations before queries run. The store manages file creation, prepared statements, connection reuse, and closure. It closes a cached handle before retention deletes the file. Step 5 connects file retention to the session, run, and recording lifecycle and removes orphan files during startup.

`POST /internal/tick` uses `authenticateOfficial` and updates the latest value through that entry's `OfficialTickMarkerRef`. `{"phase":"setup"}` sets a null tick. `{"tick":N}` sets the active tick. The record sink for the same entry observes that reference, and one key cannot update another key's marker.

Step 3 sends the markers. Step 4 queries execution-scope SQLite for game-result aggregation. Step 5 resolves recordings to their session or run scope and serves matching rows through the recording API.

## Runtime dependencies

Add the official `openai` Node client and the `tiktoken` tokenizer as runtime dependencies of `@game-sandbox/backend` with `npm install --workspace @game-sandbox/backend openai tiktoken`. This updates `backend/package.json` and the root `package-lock.json`; do not add a backend-local lockfile. The client handles OpenAI-compatible request and response types, while all retry policy remains in `UpstreamCaller`.

## Configuration

The first implementation uses the following deployment defaults. They are operational defaults, not product limits, and every value remains configurable through the variable in the table below: internal port `8081`, per-attempt timeout `30_000` ms, two retries after the initial attempt, initial retry interval `250` ms, `cl100k_base` tokenization, `1_024` default and `4_096` hard-maximum output tokens, and a `5_000` ms meter-recovery interval. Session defaults are 100 calls, 100,000 tokens, and 60 admitted requests per minute per slot. Run defaults are 1,000 calls, 1,000,000 tokens, and 60 admitted requests per minute per submission.

`LLM_UPSTREAM_URL` must be an absolute `http` or `https` base URL with no surrounding whitespace, embedded credentials, query, or fragment. Configuration rejects malformed or ambiguous values at startup without echoing the configured value. `LLM_UPSTREAM_KEY` is optional so an operator can use an unauthenticated local OpenAI-compatible endpoint. When it is absent, the upstream request omits authorization. The internal listener binds on all interfaces because Step 2's Docker relay reaches it through the host gateway; the listener still starts only when an upstream URL and at least one alias are configured.

Token budgets count input tokens plus the upstream's total completion-token count. Reasoning tokens are preserved as a separately reported subset and are not added a second time. Fallback estimates encode the canonical JSON request and completion with the configured tokenizer. Scope IDs use a bounded filename-safe opaque identifier, and tick markers accept only non-negative safe integers.

The execution telemetry implementation lives under `backend/src/storage/llm/` so better-sqlite3 remains inside the repository's enforced storage boundary. Its official sink adapter is the bridge from identity-free grants to session, slot, subject, and tick rows. Step 1 exercises official grants directly in Docker-free tests; Step 2 connects grant issuance and revocation to the orchestrator and workflow lifecycle.

Add these deployment settings in `backend/src/config.ts`:

| Variable | Purpose |
| --- | --- |
| `LLM_INTERNAL_PORT` | Backend proxy port reached through the session relay |
| `LLM_UPSTREAM_URL`, `LLM_UPSTREAM_KEY` | Single OpenAI-compatible upstream and its credential |
| `LLM_MODEL_LARGE`, `LLM_MODEL_MEDIUM`, `LLM_MODEL_SMALL` | Public alias to upstream-model mappings |
| `LLM_UPSTREAM_TIMEOUT_MS` | Timeout for each upstream attempt |
| `LLM_UPSTREAM_MAX_RETRIES` | Retry attempts after the initial request |
| `LLM_UPSTREAM_RETRY_INTERVAL_MS` | Initial exponential-backoff interval |
| `LLM_TIKTOKEN_ENCODING` | Encoding used for admission and fallback token estimates |
| `LLM_DEFAULT_MAX_OUTPUT_TOKENS` | Enforced output maximum when a request supplies neither supported maximum field |
| `LLM_MAX_OUTPUT_TOKENS` | Hard ceiling for every explicit or default output maximum |
| `LLM_METER_RECOVERY_INTERVAL_MS` | Bounded interval between single-flight write-health probes for an open accounting breaker |
| `LLM_SESSION_TOKEN_BUDGET`, `LLM_SESSION_CALL_BUDGET`, `LLM_SESSION_RATE_LIMIT_RPM` | Official per-slot session defaults |
| `LLM_RUN_TOKEN_BUDGET`, `LLM_RUN_CALL_BUDGET`, `LLM_RUN_RATE_LIMIT_RPM` | Official per-submission run defaults |

Secrets use the existing secret-loading conventions and never appear in logs or errors.

## Tests

Docker-free backend tests use fake timers and a stub OpenAI-compatible upstream:

- Missing, malformed, unknown, and revoked keys return 401 without reaching the upstream.
- Model aliases map in both directions, and disallowed aliases return `model_not_allowed`.
- Streaming, rate, and budget rejections use the pinned OpenAI-compatible envelope and create no SQLite row.
- Each admitted logical request adds one event to its session and run rate windows whether the upstream succeeds, returns a non-retryable error, or exhausts retries; retry attempts add no events, and the next request at the boundary returns 429.
- `max_tokens` and `max_completion_tokens` each reserve and forward their enforced value, supplying both is rejected, an absent value injects the configured default, a value over the hard ceiling is rejected, and no request whose enforced input-plus-output reservation exceeds remaining budget reaches the upstream.
- First-attempt success with valid usage commits one call with `usage_estimated = 0` and one durable SQLite row.
- Token estimation treats strings such as `<|endoftext|>` as ordinary participant content in requests and completions.
- A successful response with missing, negative, non-integer, or otherwise malformed usage commits tiktoken input and output estimates, exposed reasoning or zero, and `usage_estimated = 1` without changing the canonical returned completion.
- A successful response retains generated text and standard response fields, rewrites structured model identifiers to the alias, and drops nonstandard top-level provider metadata from both the response and telemetry.
- Retryable failures followed by success use the exact exponential intervals, commit once, and include retry waits in latency.
- A non-retryable upstream 4xx makes one attempt, returns immediately, releases its reservation, and records nothing.
- Exhausted connection, timeout, 408, 409, 429, and 5xx sequences make the configured number of attempts, return the final error, release the reservation, and record nothing.
- Concurrent reservations prevent the successful-call and token limits from being crossed by simultaneous requests.
- Generic accounting keys keep two session slots, two run subjects, and development-shaped `(participant, season)` fixtures in independent sliding windows, reservation totals, debt, and breaker state.
- Tick markers are isolated per grant and stamp setup calls with null and acted calls with their current tick.
- Session, run-subject, and model aggregation queries return exact sums from successful rows and exact counts of estimated rows.
- File creation sets the current `user_version`, migrations advance older fixtures, and retention closes cached handles before deletion.
- Accepted request and canonical completion bodies round-trip through the SQLite row codec.
- A forced post-upstream estimation or telemetry transaction failure converts the reservation to conservative in-memory debt, returns `meter_unavailable`, opens every affected scope breaker, and prevents repeated requests from reaching the upstream. Fake-timer tests prove that probes are single-flight, failed probes keep the breaker open, a committed `meter_health` write closes it automatically, and the original debt still reduces the remaining allowance after recovery.
- Startup migration and write-health failure prevent admission for the affected accounting scope until the same probe succeeds.

## Done when

- One backend handler forwards non-streaming requests to one configured OpenAI-compatible upstream.
- The explicit retry loop follows the configured attempt count and exponential intervals.
- Every admitted logical request consumes one rate-window event independent of outcome, while backend retries consume none. Successful logical requests consume one call and write one official SQLite row. Every unsuccessful upstream path consumes no call or token budget and writes no row.
- Official grants enforce model, session, run, and rate boundaries and can be revoked by session.
- Explicit and default output maxima are normalized, hard-capped, forwarded, and included in admission so they cannot bypass remaining token allowance.
- SQLite rows contain the full accepted request, canonical completion, and authoritative session, slot, subject, tick, model, token, estimated-usage, and latency fields.
- Missing or malformed upstream usage is estimated with tiktoken and surfaced as estimated, while every post-upstream accounting failure retains a conservative charge and opens a scope circuit breaker before returning an error. A successful write-health probe restores admission without forgiving that charge.
- The backend manifest and root lockfile pin the OpenAI client and tiktoken runtime dependencies used by the implementation.
- Docker-free tests cover every retry class, reservation release, compatible error shape, and successful-only accounting rule.
