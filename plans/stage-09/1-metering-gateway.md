# Stage 9.1: The Metering Gateway

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 1: the OpenAI-compatible gateway itself — the first demonstrable slice and the piece every later step calls into. The stage-start evaluation eliminated LiteLLM entirely: as the whole gateway its virtual keys enforce budgets in dollars rather than the spec's tokens and calls and its key management requires Postgres in a deployment that is otherwise one SQLite file, and keeping it as a demoted router still meant operating a second service for multi-provider routing the sandbox does not need. So the whole gateway is a thin service embedded in the backend process (key auth, tier allowlist, token/call/rate budgets, telemetry, tick stamping), and the upstream is any OpenAI-compatible endpoint the gateway calls through the official `openai` SDK. This step also owns the telemetry store — one SQLite file per execution scope under `data/llm/`, written through as calls complete — because that file is the single usage record everything later reads: budget admission sums it, step 4's board aggregation groups it, step 5's debug view queries it.

**Hands-on result:** issue a scratch key through the admin API, call `POST /v1/chat/completions` with `model: "small"` and the stock request shape, watch the call answer through whatever provider model the deployment mapped, watch the same key get refused the moment its budget is spent — then open the scope's file under `data/llm/` and read every row, the refusals included.

## Why this is its own seam

- Every later step consumes a gateway that already authenticates, meters, and records: slot keys at launch (step 2), the harness credential swap and tick marker (step 3), run budgets and board aggregation (step 4), the frontend surfaces (step 5).
- Landing it first, Docker-free against a stub upstream, pins every enforcement rule, error shape, and telemetry row with fast unit tests before any container or network exists.
- It records the owner decisions in the specs, per the [plans README](../README.md): no separate gateway service (the "implementation-defined separate service" of [execution.md](../../docs/specs/execution.md) disappears), models as fixed tiers, and per-scope telemetry SQLite instead of a recording sidecar.

## What to build

### The gateway listener

- A new `backend/src/gateway/` module exposing `buildGatewayApp(deps)`: a second, dedicated Fastify instance constructed in `backend/src/main.ts`, listening on `LLM_GATEWAY_PORT` — separate from the public API app so the two surfaces never share a port, an auth model, or a rate posture.
- The gateway starts only when `LLM_UPSTREAM_URL` is set; otherwise the backend boots exactly as today and every later `resolveLlm` check reads "deployment not configured."

| Route | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | The one endpoint agents use, bearer-authenticated by a slot key. The stock `openai` client against `OPENAI_BASE_URL=http://…/v1` hits exactly this path |
| `POST /internal/tick` | The tick-attribution marker (below), authenticated by the posting slot's key |

There is deliberately no `GET /v1/models`: the model vocabulary is the three fixed tiers below, taught in the step 3 student docs, so discovery buys nothing — `client.models.list()` 404s and the docs say so.

### Model tiers

Agents never see provider model names. They request one of three fixed tiers — `large`, `medium`, `small` — and the deployment decides what stands behind each:

- `LLM_MODEL_LARGE`, `LLM_MODEL_MEDIUM`, and `LLM_MODEL_SMALL` each map a tier to a provider model name; the tiers a deployment configures form its allowlist (one, two, or all three).
- The gateway swaps tier → provider model just before the upstream call and rewrites the response's `model` field back to the tier on the way in, so a provider name never reaches an agent, a telemetry row, or a board. Usage reads identically across deployments and providers, and season overrides (step 2) subset a stable vocabulary instead of chasing deployment-specific names.

### The key registry

An in-process `KeyRegistry` service, constructed in `main.ts` and injected into the gateway app (and, in step 2, the orchestrator and workflow runner). It is pure authentication — usage lives in the telemetry store, and budgets are enforced by querying it, so the registry keeps no counters:

- `issue({scope, sessionId, slot, models, budgets, rateLimitRpm, runScope?, ttl?}) → key`. Keys are `sk-sandbox-` plus 32 hex chars of crypto randomness, held in an in-memory map, never persisted: a key lives exactly as long as its session, and a backend restart that orphans containers already gets them reaped, so persistent keys would outlive anything that could legitimately use them.
- `scope` names the telemetry file the grant's calls land in: the run id on the workflow path, the session id on the live path, the key's own id for scratch keys.
- `authenticate(bearer) → grant | null`; `revokeSession(sessionId)`, idempotent. `ttl` is enforced at `authenticate`: session keys carry none (teardown revokes them); scratch keys expire on their own.
- `runScope` is accepted and stored from day one, consumed only in step 4.

### The telemetry store

One better-sqlite3 file per execution scope at `data/llm/<scopeId>.sqlite`, created at the scope's first key issuance, holding a single `calls` table:

```sql
CREATE TABLE calls (
  id               INTEGER PRIMARY KEY,
  session_id       TEXT NOT NULL,
  slot             TEXT NOT NULL,
  subject_id       TEXT,              -- run-scope attribution, stamped from the grant (step 4)
  tick             INTEGER,           -- NULL before the slot's first marker and during setup
  model            TEXT NOT NULL,     -- always the tier, never the provider name
  request          TEXT NOT NULL,     -- messages JSON, truncated at LLM_PROMPT_BYTE_CAP
  response         TEXT,              -- completion text, same cap
  truncated        INTEGER NOT NULL,
  input_tokens     INTEGER NOT NULL,
  output_tokens    INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  latency_ms       INTEGER NOT NULL,
  status           TEXT NOT NULL,     -- 'ok' | 'error'
  error_code       TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX calls_session_slot ON calls (session_id, slot);  -- session-budget sums
CREATE INDEX calls_subject     ON calls (subject_id);         -- run-budget sums (step 4)
```

- **Write-through, one INSERT per call at completion, successes and failures alike.** Rows are never buffered and never dropped — a budget rejection is exactly the kind of event an owner debugs — so a mid-session backend crash keeps every row already written and finalize has nothing to drain. The row count is bounded by the rate limit times the session's wall-clock backstop; bodies are bounded per call by `LLM_PROMPT_BYTE_CAP` under the `truncated` flag, which is the only truncation rule.
- Token counts are exactly what the upstream's `usage` reported — zero for locally rejected calls and for upstream errors that reported none; no tokenizer guesses its way into the record.
- The file is the authoritative usage record: the same sums that gate admission feed step 4's board aggregation and step 5's owner views. There is no second counter to reconcile.
- Lifecycle: a scope file dies with its referent — live-session and run files are deleted alongside the recordings that reference them (the hook lands with step 5's recording→scope resolver), scratch files with their key's expiry — and a startup sweep under `data/llm/` removes orphans.

### Enforcement, in order, per request

| # | Check | On failure | Notes |
| --- | --- | --- | --- |
| 1 | Auth | 401 | Unknown, revoked, or expired bearer; OpenAI-shaped error body |
| 2 | Allowlist | 400 `model_not_allowed` | Requested tier outside the grant's list, or unconfigured on the deployment |
| 3 | Streaming | 400 `streaming_unsupported` | Message points at the student docs. Turn-based agents gain nothing — the harness blocks on `act` regardless — and rejecting keeps forwarding and usage extraction trivial. Revisit only on real need |
| 4 | Rate limit | 429 | Sliding-window requests-per-minute per key. The `openai` client retries 429 with backoff by default — exactly right for a rate limit |
| 5 | Budgets | 400 `budget_exceeded` | A call that would take the grant past its call or token budget. Deliberately **not** 429 or 5xx: the client must not auto-retry an exhausted budget; a 400 surfaces immediately as a catchable `openai.BadRequestError` — the "ordinary API error the agent can catch" the stage promises |

Budget admission is **estimate-reserving over the file's sums**, so a nearly exhausted key cannot blow far past its cap on one final call:

- Spent usage is `SELECT SUM(...), COUNT(*)` over the scope's file, filtered to the grant's session and slot (step 4 adds the subject-keyed run query to the same gate).
- Read tokens are estimated from the request body (~4 bytes per token); write tokens are reserved at the request's `max_tokens` when set, else a quarter of the read estimate. The call is admitted only if spent plus in-flight reservations plus this estimate fits the budget.
- In-flight reservations are a small in-memory set per scope — added at admission, dropped when the row lands — covering the gap where a call has been admitted but not yet recorded. Estimates gate admission and are never written to a row, so overshoot is bounded by estimation error rather than by whatever the model returned.

Every error body uses the exact OpenAI error envelope `{"error": {"message", "type", "code"}}`, pinned by tests: the Python client maps status plus envelope to its exception types, and agents will be written against those.

### The upstream call

- One `openai` SDK client (the official Node package), constructed at gateway boot: `baseURL: LLM_UPSTREAM_URL`, `apiKey: LLM_UPSTREAM_KEY`, `maxRetries: 0` — the gateway never silently retries a metered call; retry policy belongs to the agent's own client — and a bounded per-request timeout.
- Requests that clear enforcement forward as-is apart from the tier→model swap, non-streaming by construction (check 3 already rejected `stream: true`).
- Upstream 4xx/5xx (the SDK's `APIError`) pass through with status and body; a connection failure or timeout becomes a 502 in the same envelope.
- On success the gateway reads `usage.prompt_tokens`, `usage.completion_tokens`, and `usage.completion_tokens_details.reasoning_tokens` when present, measures round-trip latency itself, rewrites `model` to the tier, and returns the body.

### Tick attribution: the marker

The gateway sees keys; only the harness knows ticks. This step builds the gateway half; the harness POSTs land in step 3, beside the credential swap at the same hook points. `POST /internal/tick`, authenticated with a slot key, body `{"tick": N}` per stepped tick or `{"phase": "setup"}` before load/reset, answers 204:

- The gateway keeps the marker **per authenticated grant**, not per session: a row is stamped with its own key's most recent marker, so no key can move another's attribution, and a lost marker mis-stamps only its own slot's rows — with that slot's previous tick or null, never another seat's. Rows before a grant's first marker, or after a setup marker, carry `tick: NULL`.
- Why a marker and not a timestamp join, given every step already records `started_at`: attribution by arrival order at a single process is exact under the same sequential-agents guarantee the keys rely on; it is immune to both clock hazards a join is not (`PausableClock` subtracts paused time, so recorded `started_at` drifts off wall time in any live session that pauses, and on Docker Desktop the container VM's clock can drift from the host's after every sleep of the development machine); and its failure mode is self-consistent — the marker targets the same endpoint the model calls use, so if the marker cannot get through, neither can the calls it would have attributed.

### Configuration and the admin scratch key

`backend/src/config.ts` gains the LLM block, all optional, documented in `docs/contributors/configuration.md` in step 6. Secrets follow the `GITHUB_TOKEN` precedent: read via `stringVar`, never logged.

| Variable | Purpose |
| --- | --- |
| `LLM_GATEWAY_PORT` | Gateway listener port |
| `LLM_UPSTREAM_URL`, `LLM_UPSTREAM_KEY` | Any OpenAI-compatible endpoint and its key; URL unset means the gateway is off |
| `LLM_MODEL_LARGE`, `LLM_MODEL_MEDIUM`, `LLM_MODEL_SMALL` | Provider model behind each tier; the configured tiers form the deployment allowlist |
| `LLM_SESSION_TOKEN_BUDGET`, `LLM_SESSION_CALL_BUDGET` | Budgets per slot per session |
| `LLM_RUN_TOKEN_BUDGET`, `LLM_RUN_CALL_BUDGET` | Budgets per submission per run (consumed in step 4) |
| `LLM_RATE_LIMIT_RPM` | Per-key rate limit |
| `LLM_PROMPT_BYTE_CAP` | Per-call body truncation cap |

`POST /api/admin/llm/keys` (operator-gated under `/api/admin`, like the season routes) issues a scratch key with deployment-default budgets and a short expiry — sessionless keys must die on their own, since no teardown path owns them — and returns it with the gateway base URL. It is this step's hands-on surface and stays as the operator's diagnostic probe ("is the gateway up, is the provider key valid") without touching a session. Its telemetry scope is the key itself, so the probe's rows are readable at `data/llm/<key-id>.sqlite` until the key expires and the file is removed.

### Spec reconciliation in this step

Spec and plan move together, per the [plans README](../README.md):

- [llm.md](../../docs/specs/llm.md): gateway section rewritten to the built shape — metering embedded in the backend, the upstream any OpenAI-compatible endpoint called through the `openai` SDK, the tier vocabulary, streaming unsupported, the error-code contract (401 / 400 `model_not_allowed` / 400 `budget_exceeded` / 429), per-scope telemetry files with null ticks for setup-phase calls, marker-based attribution.
- [execution.md](../../docs/specs/execution.md): the "Separate service — implementation-defined" row leaves the languages table; nothing in the system remains outside Python-in-container and TypeScript-outside.
- The reserved `gateway/` directory and its README are removed — there is no separate service to house. A deployment that wants multi-provider routing points `LLM_UPSTREAM_URL` at a router it operates (OpenRouter, a self-hosted LiteLLM); a paragraph in `docs/contributors/configuration.md` (step 6) says so.

## Tests

Docker-free vitest in the backend workspace, with a local stub upstream (an in-test HTTP server speaking just enough OpenAI):

- **Auth**: missing, malformed, unknown, revoked, and expired bearers each 401; a revoked session's keys stop authorizing while another session's keys continue.
- **Tiers**: a tier outside the grant (or unconfigured on the deployment) 400s with `model_not_allowed`; a granted tier forwards carrying the mapped provider model upstream, and both the returned body and the telemetry row read the tier.
- **Streaming**: `stream: true` 400s with `streaming_unsupported` and the upstream is never called.
- **Rate**: the N+1th call inside a minute 429s; the window slides.
- **Budgets**: the call-budget boundary is exact; a request whose read-plus-write estimate exceeds the remaining token budget is refused with `budget_exceeded` before the upstream is called, with `max_tokens` honored over the quarter-of-read default; an in-flight call's reservation counts against the next admission until its row lands; rows record actual usage and estimates are never recorded.
- **Error shapes**: every rejection matches the OpenAI error envelope byte-for-byte at the JSON level; the stock Python `openai` client (exercised in step 3's tests) maps `budget_exceeded` to `BadRequestError`, not a retry.
- **Forwarding**: upstream 500 passes through; unreachable upstream 502s in-envelope; exactly one upstream request per gateway request, even on upstream failure (`maxRetries: 0` pinned); the upstream key is attached and the slot key never leaks upstream.
- **Telemetry**: each call inserts one row at completion, durable immediately — readable mid-session, not just after teardown; rows carry tier, both bodies, token counts, latency; failed calls produce rows with error codes and zero tokens when the upstream reported no usage; over-cap bodies truncate with the flag; the file's sums equal what admission read.
- **Marker**: rows land on their own grant's most recent marker; two interleaved keys never re-stamp each other's rows; rows before a grant's first marker and after a setup marker are `NULL`-ticked.
- **Files**: scope files land at `data/llm/<scopeId>.sqlite`; an expired scratch key's file is removed; the startup sweep deletes an orphan.
- **Boot**: without `LLM_UPSTREAM_URL` the gateway does not listen and the backend behaves exactly as today; the admin scratch-key route requires an operator.

## Done when

- With `LLM_UPSTREAM_URL` pointed at any OpenAI-compatible endpoint and at least one tier mapped, an operator can issue a scratch key via the admin API and call the gateway with the stock request shape: `model: "small"` answers through the mapped provider model with the tier name in the response.
- A disallowed tier and a `stream: true` request are refused with the pinned codes; the key hits its rate limit at the configured RPM; once its budget is spent every further call fails with `budget_exceeded` until a new key is issued.
- Every call of the exchange — failures included — is a durable row in the scope's `data/llm/` file with tier, bodies, token counts, and latency (`NULL` ticks until step 3's harness marker flows).
- All of the above is green in Docker-free tests against the stub upstream; llm.md and execution.md describe the built shape; the reserved `gateway/` directory is gone.
