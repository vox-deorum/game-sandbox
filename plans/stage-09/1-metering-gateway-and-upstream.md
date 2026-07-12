# Stage 9.1: The Metering Gateway and the LiteLLM Upstream

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 1: the OpenAI-compatible gateway itself — the first demonstrable slice and the piece every later step calls into. The stage-start evaluation landed against LiteLLM-as-the-whole-gateway: its virtual keys enforce budgets in dollars rather than the spec's tokens and calls, and its key management requires Postgres in a deployment that is otherwise one SQLite file. So the metering layer (key auth, token/call/rate budgets, model allowlist, telemetry capture) is a thin service embedded in the backend process, where session and season state already live, and LiteLLM is demoted to what it is genuinely good at: a DB-less router from OpenAI-shaped requests to whatever provider the deployment configures.

**Hands-on result:** issue a scratch key through the admin API, call `POST /v1/chat/completions` on the gateway port with the stock request shape, watch the call answer through LiteLLM, and watch the same key get refused the moment its budget is spent.

## Why this is its own seam

- Every later step consumes a gateway that already authenticates, meters, and records: slot keys at launch (step 2), the harness credential swap (step 3), the telemetry sidecar (step 4), run budgets (step 5), the frontend surfaces (step 6).
- Landing it first, Docker-free against a stub upstream, pins every enforcement rule and error shape with fast unit tests before any container or network exists.
- It records the LiteLLM decision in the specs, per the [plans README](../README.md): metering is backend TypeScript, and the "implementation-defined separate service" of [execution.md](../../docs/specs/execution.md) is now only the upstream router.

## What to build

### The gateway listener

- A new `backend/src/gateway/` module exposing `buildGatewayApp(deps)`: a second, dedicated Fastify instance constructed in `backend/src/main.ts`, listening on `LLM_GATEWAY_PORT` — separate from the public API app so the two surfaces never share a port, an auth model, or a rate posture.
- The gateway starts only when `LLM_UPSTREAM_URL` is set; otherwise the backend boots exactly as today and every later `resolveLlm` check reads "deployment not configured."

| Route | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | The one endpoint agents use, bearer-authenticated by a slot key. The stock `openai` client against `OPENAI_BASE_URL=http://…/v1` hits exactly this path |
| `GET /v1/models` | The key's allowed models in OpenAI list shape, so `client.models.list()` works for curious students |
| `POST /internal/tick` | Reserved for step 4's tick-attribution marker; registered now returning 204 so the harness has a stable path |

### The key registry

An in-process `KeyRegistry` service, constructed in `main.ts` and injected into the gateway app (and, in step 2, the orchestrator and workflow runner):

- `issue({sessionId, slot, models, budgets, rateLimitRpm, runScope?}) → key`. Keys are `sk-sandbox-` plus 32 hex chars of crypto randomness, held in an in-memory map, never persisted: a key lives exactly as long as its session, and a backend restart that orphans containers already gets them reaped, so persistent keys would outlive anything that could legitimately use them.
- `authenticate(bearer) → grant | null`; `revokeSession(sessionId)`, idempotent.
- Per-grant, **per-model** usage counters (calls; input/output/reasoning tokens). The counters are the authoritative usage record — budgets enforce against them and step 5's board aggregation reads them; telemetry rows are the audit artifact beside them, never the source of a number.
- `issue` accepts an optional TTL, enforced at `authenticate`: session keys carry none (teardown revokes them); scratch keys expire on their own.
- `runScope` is accepted and stored from day one, consumed only in step 5.

### Enforcement, in order, per request

| # | Check | On failure | Notes |
| --- | --- | --- | --- |
| 1 | Auth | 401 | Unknown or revoked bearer; OpenAI-shaped error body |
| 2 | Allowlist | 400 `model_not_allowed` | Requested model outside the grant's model list |
| 3 | Streaming | 400 `streaming_unsupported` | Message points at the student docs. Turn-based agents gain nothing — the harness blocks on `act` regardless — and rejecting keeps forwarding and usage extraction trivial. Revisit only on real need |
| 4 | Rate limit | 429 | Sliding-window requests-per-minute per key. The `openai` client retries 429 with backoff by default — exactly right for a rate limit |
| 5 | Budgets | 400 `budget_exceeded` | A call that would take the grant past its call or token budget. Deliberately **not** 429 or 5xx: the client must not auto-retry an exhausted budget; a 400 surfaces immediately as a catchable `openai.BadRequestError` — the "ordinary API error the agent can catch" the stage promises |

Budget admission is **estimate-reserving**, so a nearly exhausted key cannot blow far past its cap on one final call:

- Read tokens are estimated from the request body (~4 bytes per token); write tokens are reserved at the request's `max_tokens` when set, else a quarter of the read estimate.
- The call is admitted only if spent plus estimate fits the budget.
- After the response, counters reconcile to the upstream's actual `usage` — estimates gate admission and are never recorded, so overshoot is bounded by estimation error rather than by whatever the model returned.

Every error body uses the exact OpenAI error envelope `{"error": {"message", "type", "code"}}`, pinned by tests: the Python client maps status plus envelope to its exception types, and agents will be written against those.

### Forwarding and telemetry capture

- Requests that clear enforcement forward verbatim (minus the bearer, plus `LLM_UPSTREAM_KEY`) to `LLM_UPSTREAM_URL`, with a bounded timeout. Upstream 4xx/5xx pass through with status and body; an unreachable upstream becomes a 502 in the same envelope.
- On success the gateway reads `usage.prompt_tokens`, `usage.completion_tokens`, and `usage.completion_tokens_details.reasoning_tokens` when present, and measures round-trip latency itself.
- Each call appends one row to a per-session in-memory buffer: session, slot, model, request messages, response content, the three token counts, latency, status, and an error code on failures. Ticks are `null` until step 4 adds the marker.
- **Rows are never dropped** — failed calls are telemetry too (a budget rejection is exactly the kind of event an owner debugs), and the row count is already bounded by the rate limit times the session's wall-clock backstop. Bodies are bounded instead: prompt and completion text truncates per call at `LLM_PROMPT_BYTE_CAP`, and once the per-session `LLM_TELEMETRY_BODY_BUDGET` is exhausted, bodies store empty under the `truncated` flag while the metadata record stays complete.
- Token counts are exactly what the upstream's `usage` reported — zero for locally rejected calls and for upstream errors that reported none; no tokenizer guesses its way into the record.

### The upstream under `gateway/`

- `gateway/` (today a one-line reserved README) becomes the upstream's home: a LiteLLM `config.yaml` mapping public model names (the names agents use, e.g. `gpt-4o-mini`) to provider routes with provider keys from env, plus a README covering `docker run`-style startup and provider examples.
- LiteLLM runs **DB-less** — no virtual keys, no Postgres, no spend logging; the backend owns all of that.
- The gateway only needs "an OpenAI-compatible upstream": a deployment may point `LLM_UPSTREAM_URL` straight at a single provider and skip LiteLLM entirely. LiteLLM is the default answer for multi-provider routing, not a hard dependency. CI never needs it — tests inject a stub upstream.

### Configuration and the admin scratch key

`backend/src/config.ts` gains the LLM block, all optional, documented in `docs/contributors/configuration.md` in step 7. Secrets follow the `GITHUB_TOKEN` precedent: read via `stringVar`, never logged.

| Variable | Purpose |
| --- | --- |
| `LLM_GATEWAY_PORT` | Gateway listener port |
| `LLM_UPSTREAM_URL`, `LLM_UPSTREAM_KEY` | Upstream endpoint and key; URL unset means the gateway is off |
| `LLM_MODELS` | Deployment model allowlist |
| `LLM_SESSION_TOKEN_BUDGET`, `LLM_SESSION_CALL_BUDGET` | Budgets per slot per session |
| `LLM_RUN_TOKEN_BUDGET`, `LLM_RUN_CALL_BUDGET` | Budgets per submission per run (consumed in step 5) |
| `LLM_RATE_LIMIT_RPM` | Per-key rate limit |
| `LLM_PROMPT_BYTE_CAP` | Per-call body truncation cap |
| `LLM_TELEMETRY_BODY_BUDGET` | Per-session telemetry body budget |

`POST /api/admin/llm/keys` (operator-gated under `/api/admin`, like the season routes) issues a scratch key with deployment-default budgets and a short expiry — sessionless keys must die on their own, since no teardown path owns them — and returns it with the gateway base URL. It is this step's hands-on surface and stays as the operator's diagnostic probe ("is the gateway up, is the provider key valid") without touching a session.

### Spec reconciliation in this step

Spec and plan move together, per the [plans README](../README.md):

- [llm.md](../../docs/specs/llm.md): gateway section rewritten to the built shape — metering in the backend, LiteLLM as the default DB-less upstream router, streaming unsupported, the error-code contract (401 / 400 `model_not_allowed` / 400 `budget_exceeded` / 429).
- [execution.md](../../docs/specs/execution.md): languages table corrected — the gateway's metering half is TypeScript in the backend; the "implementation-defined" row now names only the upstream router.

## Tests

Docker-free vitest in the backend workspace, with a local stub upstream (an in-test HTTP server speaking just enough OpenAI):

- **Auth**: missing, malformed, unknown, revoked, and expired bearers each 401; a revoked session's keys stop authorizing while another session's keys continue.
- **Allowlist**: a model outside the grant 400s with `model_not_allowed`; a model in the grant forwards.
- **Streaming**: `stream: true` 400s with `streaming_unsupported` and the upstream is never called.
- **Rate**: the N+1th call inside a minute 429s; the window slides.
- **Budgets**: the call-budget boundary is exact; a request whose read-plus-write estimate exceeds the remaining token budget is refused with `budget_exceeded` before the upstream is called, with `max_tokens` honored over the quarter-of-read default; counters reconcile to actual usage per model; estimates are never recorded.
- **Error shapes**: every rejection matches the OpenAI error envelope byte-for-byte at the JSON level; the stock Python `openai` client (exercised in step 3's tests) maps `budget_exceeded` to `BadRequestError`, not a retry.
- **Forwarding**: upstream 500 passes through; unreachable upstream 502s in-envelope; the upstream key is attached and the slot key never leaks upstream.
- **Telemetry**: rows carry model, both bodies, token counts, latency, `tick: null`; failed calls produce rows with error codes and zero tokens when the upstream reported no usage; over-cap bodies truncate with the flag; once the body budget is exhausted, rows keep full metadata with empty flagged bodies; the counters equal the sum of the rows' reported usage; `drain` empties the buffer.
- **Boot**: without `LLM_UPSTREAM_URL` the gateway does not listen and the backend behaves exactly as today; the admin scratch-key route requires an operator.

## Done when

- With LiteLLM running locally against a real provider key (or any OpenAI-compatible endpoint), an operator can issue a scratch key via the admin API and call the gateway with the stock request shape: the call answers through the upstream, and `/v1/models` lists the allowlist.
- A disallowed model and a `stream: true` request are refused with the pinned codes; the key hits its rate limit at the configured RPM; once its budget is spent every further call fails with `budget_exceeded` until a new key is issued.
- Telemetry rows for the whole exchange, failures included, sit in the session buffer with correct token counts and latency.
- All of the above is green in Docker-free tests against the stub upstream, and llm.md and execution.md describe the built shape.
