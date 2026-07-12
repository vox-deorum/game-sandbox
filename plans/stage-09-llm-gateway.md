# Stage 9: LLM Gateway

Status: not started (build order planned under [stage-09/](stage-09/)).

## Goal

Agents call an OpenAI-compatible LLM API from inside the sandbox with the stock `openai` client. Every call is metered and logged, budgets bound the bill, owners can inspect their agents' prompts, and the public sees only usage metadata.

## Architecture

The stage-start evaluation of LiteLLM as the whole gateway is done: its virtual keys meter dollars rather than the spec's tokens and calls, and its key management requires Postgres in a one-SQLite-file deployment. The gateway therefore splits in two:

- **Metering** — key auth, token/call/rate budgets, the model allowlist, telemetry capture — is a thin service embedded in the backend process (`backend/src/gateway/`, its own Fastify listener on a dedicated port), where session, season, and run state already live.
- **Upstream** — LiteLLM survives as the default: a DB-less router under `gateway/` that translates OpenAI-shaped requests to whichever provider the deployment configures. A deployment may instead point the upstream URL straight at one OpenAI-compatible provider and skip it. The TypeScript-outside-rule exception in [execution.md](../docs/specs/execution.md) now covers only this router.

Two contract decisions hold everywhere:

- Streaming (`stream=true`) is rejected with a clear API error: turn-based agents gain nothing from it, and rejecting it keeps forwarding and usage extraction trivial.
- Budget exhaustion answers a non-retryable 400 (`budget_exceeded`) the agent can catch; rate limiting answers 429.

## Scope

- **Enablement — season-controlled only.**
  - The never-consumed `EnvironmentMeta.llm` flag is removed.
  - The inert `overrides.llm` season block from Stage 6 becomes a strict codec: enabled (default false), a model list bounded by the deployment allowlist, budget and rate overrides.
  - The play-open season's override governs live watch and play sessions (the Stage 8 messaging precedent); workflow runs read their frozen config snapshot; nothing turns on unless the deployment also configures an upstream.
- **Keys — issued per agent slot at container launch.**
  - The orchestrator or workflow runner issues an in-memory one-off key per agent slot, scoped to that session and slot, carried to the harness in the session config argv.
  - The harness sets `OPENAI_BASE_URL` once and swaps the acting slot's `OPENAI_API_KEY` around load, reset, and the per-tick hooks, so ordinary use of the stock `openai` client is attributed correctly even though agents run sequentially in one process.
  - Slot keys are telemetry and budget attribution, not a security boundary between agents in one container — the accepted class-scale tradeoff in [execution.md](../docs/specs/execution.md).
  - Every key is revoked at the teardown convergence points when the container exits, and immediately when a launch fails after issuance.
- **Network — gateway-only, per session.**
  - LLM sessions attach to a per-session internal Docker network whose single reachable endpoint is a dual-homed relay container forwarding to the backend's gateway port (via `host.docker.internal:host-gateway`, so Docker Desktop development and Linux CI behave identically).
  - The future Kubernetes driver expresses the same profile as a network policy. Sessions without LLM keep no network at all.
- **Telemetry — every call, failures included.**
  - Each row carries session, slot (from the key), model, full prompt and completion (truncation-capped), input/reasoning/output token counts, and latency.
  - Tick attribution uses a marker: before running the acting slot, the harness posts the current tick to the gateway's internal endpoint, and rows are stamped per key by arrival order — exact under sequential stepping, isolated per slot, and immune to both `PausableClock` drift and Docker Desktop VM clock skew, which rule out a timestamp join.
  - At finalize the backend writes the rows as the `llm-telemetry` sidecar (`llm.jsonl`) beside the session's recording, declared in the header under the same schema version, per [recording.md](../docs/specs/recording.md).
- **Budgets — enforced at the gateway's admission gate.**
  - The gate reserves an estimated cost per call (read tokens from the request size; write tokens at the request's `max_tokens` or a quarter of the read estimate) and reconciles counters to actual upstream usage afterward, so one final call cannot blow far past an exhausted budget.
  - Token and call budgets apply per slot per session and per submission per leaderboard run — one hungry agent starves neither its opponents in a match nor its competitors in a run — plus a per-key rate limit.
  - All have deployment defaults and Stage 6 season overrides.
  - An over-budget call fails with an ordinary catchable API error, the run continues, and budget exhaustion is never a forfeit.
- **Surfacing — public metadata, owner-only prompts.**
  - The replay viewer shows per-tick model, token, and latency metadata wherever the replay is public, fed by a server-side endpoint that masks prompt bodies per slot: only the slot's owner and operators receive them, read in the owner's debug view on the agent profile.
  - The automated board shows aggregated token usage per model next to timing, flowing from the gateway's authoritative per-model counters through `game_results` to the board and persisted placements, with the sidecar rows as the audit trail.
  - Wall-clock time waiting on the model already counts against the step limits through harness timing; the stage pins that with a test rather than new machinery.

## Spec references

[llm.md](../docs/specs/llm.md), [execution.md](../docs/specs/execution.md) (network sandbox, gateway exception), [recording.md](../docs/specs/recording.md) (sidecar), [leaderboard.md](../docs/specs/leaderboard.md) (overrides, token columns), [frontend.md](../docs/specs/frontend.md) (debug view), [submission.md](../docs/specs/submission.md) (template `.env` flow).

## Depends on

Stage 3 (orchestrator, networks), Stage 5 (agent profile), Stage 6 (season overrides, board). Independent of Stage 8 (communication).

## Build order

Each step is its own subplan under [stage-09/](stage-09/). The gateway lands first and Docker-free, orchestration and network second, and every step ends with something you can put hands on.

| # | Subplan | Builds | Hands-on |
| --- | --- | --- | --- |
| 1 | [Metering gateway and LiteLLM upstream](stage-09/1-metering-gateway-and-upstream.md) | Backend-embedded gateway listener: slot-key auth, model allowlist, rate limit, per-key token/call budgets with the pinned OpenAI-shaped error contract, streaming rejection, forwarding, per-call telemetry capture, the `gateway/` LiteLLM config, the admin scratch-key route | Curl the gateway with an issued key; watch the same key die at its budget |
| 2 | [Season enablement, slot keys, and the internal network](stage-09/2-enablement-keys-and-network.md) | Strict `overrides.llm` codec and admin editor fields, `resolveLlm` on both launch paths, `EnvironmentMeta.llm` removal, per-slot key issuance and teardown revocation, the `'llm'` sandbox network | From inside a container the gateway answers and the internet does not; the key dies on exit |
| 3 | [Harness credentials and the template LLM example](stage-09/3-harness-credentials-and-template-example.md) | Per-slot credential swap (byte-identical when disabled), wall-clock timing pin, `OPENAI_MODEL`-parameterized template example with `python -m sandbox llm`, the `examples/hearts/oracle` fallback agent, the student LLM guide | The same code runs locally on the class key and in a session against the gateway |
| 4 | [Telemetry sidecar](stage-09/4-telemetry-sidecar.md) | `llm-telemetry` schema and generated types with golden fixtures, header declaration, tick-attribution marker, finalize-time `llm.jsonl` write on both launch paths, retention | Open a recording directory and read the schema-valid call log keyed by tick and slot |
| 5 | [Run budgets and token aggregation](stage-09/5-run-budgets-and-token-aggregation.md) | Per-submission-per-run counters spanning a run's sessions, workflow-runner run scope, token-by-model totals through `game_results` into the board and persisted placements, the over-budget-but-honest journey, llm.md budget semantics | A tiny-budget season run where exhaustion is caught, finished, and visible in the board |
| 6 | [Replay metadata, owner debug view, and board tokens](stage-09/6-frontend-surfacing.md) | Per-slot-masked sidecar endpoint, public per-tick Model-calls replay panel, owner/operator prompt browser replacing the Stage 5 profile placeholder, token column on the automated board | The whole visibility story in a browser |
| 7 | [Testing, CI, and docs](stage-09/7-testing-ci-and-docs.md) | Whole-stage integration journey and byte-identical regression gates in the Docker lane, `llm.spec.ts` browser journey, optional LiteLLM config smoke, spec/configuration/student-docs sweep | Both CI lanes green |

## Done when

- The template repo's LLM example runs unmodified in both places: locally with the class key in `.env`, and inside a session against the gateway.
- From inside a container, the gateway answers and the open internet does not.
- A replayed session shows per-tick call metadata attributed to the correct slot; prompts are visible only to the owner and operators; the board shows token usage per model.
- A test agent that exceeds its session or run budget receives a catchable API error and finishes its episode without forfeiting.
- A revoked slot key stops authorizing after the container exits.
- Sessions of seasons that never enabled the capability remain byte-identical to today.
