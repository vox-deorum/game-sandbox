# Stage 9: LLM Gateway

Status: not started (build order planned under [stage-09/](stage-09/)).

## Goal

Agents call an OpenAI-compatible LLM API from inside the sandbox with the stock `openai` client. Every call is metered and logged, budgets bound the bill, owners can inspect their agents' prompts, and the public sees only usage metadata.

## Architecture

The stage-start evaluation ended with LiteLLM removed from the design entirely. As the whole gateway it measured the wrong things — its virtual keys meter dollars rather than the spec's tokens and calls, and its key management requires Postgres in a one-SQLite-file deployment — and keeping it as a demoted router still meant shipping and operating a second service for multi-provider routing the sandbox does not need. What remains is one service and one artifact:

- **The gateway** — key auth, token/call/rate budgets, the model tiers, telemetry, tick attribution — is a thin service embedded in the backend process (`backend/src/gateway/`, its own Fastify listener on a dedicated port), where session, season, and run state already live. It calls the provider itself through the official `openai` SDK pointed at `LLM_UPSTREAM_URL`: any OpenAI-compatible endpoint works, and a deployment that wants several providers at once points the URL at a router it operates (OpenRouter, a self-hosted LiteLLM) rather than one the sandbox ships. The TypeScript-outside-rule exception in [execution.md](../docs/specs/execution.md) disappears — every line of the gateway is backend TypeScript.
- **Models are tiers, not provider names.** Agents request `large`, `medium`, or `small`; the deployment maps each tier it configures to a real model (`LLM_MODEL_LARGE` and friends), and the gateway translates on the way out and rewrites the response's `model` back to the tier on the way in. Telemetry and boards record tiers, so "tokens spent on `large`" reads the same on every deployment and no provider name reaches an agent or a public surface.
- **Telemetry is one SQLite file per execution scope** — `data/llm/<runId>.sqlite` for a leaderboard run, shared by all its sessions; `data/llm/<sessionId>.sqlite` for a live session — written through as each call completes, failures included. The file is the single usage record: budget admission sums it, board aggregation groups it, the owner debug view reads it. Plain rows, no OpenTelemetry — this is a product artifact (owner-visible prompts, tick attribution, board totals), not ops instrumentation — and the recording format is untouched: no sidecar, no header change, [recording.md](../docs/specs/recording.md) keeps its placeholder.

Two contract decisions hold everywhere:

- Streaming (`stream=true`) is rejected with a clear API error: turn-based agents gain nothing from it, and rejecting it keeps forwarding and usage extraction trivial.
- Budget exhaustion answers a non-retryable 400 (`budget_exceeded`) the agent can catch; rate limiting answers 429.

## Scope

- **Enablement — season-controlled only.**
  - The never-consumed `EnvironmentMeta.llm` flag is removed.
  - The inert `overrides.llm` season block from Stage 6 becomes a strict codec: enabled (default false), a tier list bounded by the deployment's configured tiers, budget and rate overrides.
  - The play-open season's override governs live watch and play sessions (the Stage 8 messaging precedent); workflow runs read their frozen config snapshot; nothing turns on unless the deployment also configures an upstream.
- **Keys — issued per agent slot at container launch.**
  - The orchestrator or workflow runner issues an in-memory one-off key per agent slot, scoped to that session and slot, carried to the harness in the session config argv. Issuance names the telemetry scope — the run id on the workflow path, the session id on the live path — so every call lands in the right `data/llm` file from the first request.
  - The harness sets `OPENAI_BASE_URL` once and swaps the acting slot's `OPENAI_API_KEY` around load, reset, and the per-tick hooks, so ordinary use of the stock `openai` client is attributed correctly even though agents run sequentially in one process.
  - Slot keys are telemetry and budget attribution, not a security boundary between agents in one container — the accepted class-scale tradeoff in [execution.md](../docs/specs/execution.md).
  - Every key is revoked at the teardown convergence points when the container exits, and immediately when a launch fails after issuance.
- **Network — gateway-only, per session.**
  - LLM sessions attach to a per-session internal Docker network whose single reachable endpoint is a dual-homed relay container forwarding to the backend's gateway port (via `host.docker.internal:host-gateway`, so Docker Desktop development and Linux CI behave identically).
  - The future Kubernetes driver expresses the same profile as a network policy. Sessions without LLM keep no network at all.
- **Telemetry — every call, failures included, written through to the scope's SQLite file.**
  - Each row carries session, slot (from the key), tier, full prompt and completion (truncation-capped per call), input/reasoning/output token counts, latency, and status.
  - Rows land as calls complete, so a crashed session keeps its telemetry and finalize has nothing to drain; the same file's sums are the budget record and the board's numbers — there is no second counter to reconcile.
  - Tick attribution uses a marker: before running the acting slot, the harness posts the current tick to the gateway's internal endpoint, and rows are stamped per key by arrival order — exact under sequential stepping, isolated per slot, and immune to both `PausableClock` drift and Docker Desktop VM clock skew, which rule out a timestamp join.
- **Budgets — enforced at the gateway's admission gate, as sums over the telemetry file.**
  - The gate admits a call only if the scope's recorded usage plus in-flight reservations plus the call's estimate (read tokens from the request size; write tokens at the request's `max_tokens` or a quarter of the read estimate) fits the budget; rows record actual upstream usage, so overshoot is bounded by estimation error.
  - Token and call budgets apply per slot per session and per submission per leaderboard run — one hungry agent starves neither its opponents in a match nor its competitors in a run — plus a per-key rate limit.
  - All have deployment defaults and Stage 6 season overrides.
  - An over-budget call fails with an ordinary catchable API error, the run continues, and budget exhaustion is never a forfeit.
- **Surfacing — public metadata, owner-only prompts.**
  - The replay viewer shows per-tick tier, token, and latency metadata wherever the replay is public, fed by a server-side endpoint over the telemetry file that masks prompt bodies per slot: only the slot's owner and operators receive them, read in the owner's debug view on the agent profile.
  - The automated board shows aggregated token usage per tier next to timing, flowing from the same telemetry file through `game_results` to the board and persisted placements.
  - Wall-clock time waiting on the model already counts against the step limits through harness timing; the stage pins that with a test rather than new machinery.

## Spec references

[llm.md](../docs/specs/llm.md), [execution.md](../docs/specs/execution.md) (network sandbox, languages table), [leaderboard.md](../docs/specs/leaderboard.md) (overrides, token columns), [frontend.md](../docs/specs/frontend.md) (debug view), [submission.md](../docs/specs/submission.md) (template `.env` flow).

## Depends on

Stage 3 (orchestrator, networks), Stage 5 (agent profile), Stage 6 (season overrides, board). Independent of Stage 8 (communication).

## Build order

Each step is its own subplan under [stage-09/](stage-09/). The gateway lands first and Docker-free, orchestration and network second, and every step ends with something you can put hands on.

| # | Subplan | Builds | Hands-on |
| --- | --- | --- | --- |
| 1 | [Metering gateway](stage-09/1-metering-gateway.md) | Backend-embedded gateway listener: slot-key auth, the `large`/`medium`/`small` tier vocabulary, rate limit, token/call budgets enforced as sums over the per-scope telemetry SQLite under `data/llm/`, write-through call rows, the tick-stamping marker endpoint, `openai`-SDK forwarding with the pinned OpenAI error contract, streaming rejection, the admin scratch-key route | Curl the gateway with an issued key; watch the same key die at its budget; read the rows in `data/llm/` |
| 2 | [Season enablement, slot keys, and the internal network](stage-09/2-enablement-keys-and-network.md) | Strict `overrides.llm` codec and admin editor fields, `resolveLlm` on both launch paths, `EnvironmentMeta.llm` removal, per-slot key issuance (naming the telemetry scope) and teardown revocation, the `'llm'` sandbox network | From inside a container the gateway answers and the internet does not; the key dies on exit |
| 3 | [Harness credentials and the template LLM example](stage-09/3-harness-credentials-and-template-example.md) | Per-slot credential swap (byte-identical when disabled), tick-marker POSTs around the same hooks, wall-clock timing pin, small-tier template example with `python -m sandbox llm`, the `examples/hearts/oracle` fallback agent, the student LLM guide | The same code runs locally on the class key and in a session against the gateway |
| 4 | [Run budgets and token aggregation](stage-09/4-run-budgets-and-token-aggregation.md) | Per-submission-per-run budget as a subject-keyed sum over the run's telemetry file, workflow-runner run scope, token-by-tier totals through `game_results` into the board and persisted placements, the over-budget-but-honest journey, llm.md budget semantics | A tiny-budget season run where exhaustion is caught, finished, and visible in the board |
| 5 | [Replay metadata, owner debug view, and board tokens](stage-09/5-frontend-surfacing.md) | Per-slot-masked telemetry endpoint over the scope DB, public per-tick Model-calls replay panel, owner/operator prompt browser replacing the Stage 5 profile placeholder, token column on the automated board | The whole visibility story in a browser |
| 6 | [Testing, CI, and docs](stage-09/6-testing-ci-and-docs.md) | Whole-stage integration journey and byte-identical regression gates in the Docker lane, `llm.spec.ts` browser journey, spec/configuration/student-docs sweep | Both CI lanes green |

## Done when

- The template repo's LLM example runs unmodified in both places: locally with the class key in `.env`, and inside a session against the gateway.
- From inside a container, the gateway answers and the open internet does not.
- A replayed session shows per-tick call metadata attributed to the correct slot; prompts are visible only to the owner and operators; the board shows token usage by tier.
- A test agent that exceeds its session or run budget receives a catchable API error and finishes its episode without forfeiting.
- A revoked slot key stops authorizing after the container exits.
- Sessions of seasons that never enabled the capability remain byte-identical to today.
