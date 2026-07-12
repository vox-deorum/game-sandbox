# Stage 9.7: Testing, CI, and Docs

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 7: the cross-cutting companion every stage since 2 has shipped — the whole-stage journeys no single step can own, the CI wiring that keeps them running, and the final reconciliation sweep across specs and student docs. Per-step tests live in each subplan; this step tests the seams _between_ them.

## Why this is its own seam

- The stage's "done when" sentences are cross-step by construction: "the template's example runs unmodified in both places" spans steps 1–3, "prompts visible only to the owner" spans 4–6, "a revoked key stops authorizing" spans 1–2.
- Those journeys need the full stack, Docker, and a browser — exactly the machinery the `backend-integration` and `e2e.yml` lanes already own. Bundling them with the docs sweep mirrors stages 5–8 and keeps every earlier step lean.

## What to build

### The whole-stage integration journey

In the Docker-gated `backend-integration` lane, against a stub OpenAI upstream (an in-process HTTP server — LiteLLM is deliberately not a CI dependency; the gateway only requires "an OpenAI-compatible upstream," and the stub pins that contract):

- **End-to-end session**: a season configured with LLM enabled, a model allowlist, and small budgets; a session with the step 3 oracle runs end to end. Inside the container the gateway answers and the internet does not; the recording carries the declared sidecar; `llm.jsonl` rows validate, tick-match the recording, and include any failures; the saved slot key is dead after exit; the network and relay attachment are gone.
- **Run budget**: a two-match mini-run under a tiny per-submission run budget reproduces the step 5 journey across sessions — exhaustion in match two, a caught error, an honest finish, no forfeit, and board rows with token usage by model.
- **Regression gates**: a messaging-era Spades session and a plain Flappy Bird session re-run byte-identical to their pre-stage recordings, proving the LLM path adds nothing when disabled.

### The browser journey

`llm.spec.ts` joins `e2e.yml` beside `spades.spec.ts`, on the same stub upstream:

- An operator enables LLM on a season in the admin console's new fields; a watch session with the oracle runs.
- The replay shows the Model-calls panel ticking under the scrubber, with the run-cost summary.
- The owner's profile debug view shows full prompts while a logged-out context shows none — asserted at both the UI and the raw-API level, since the endpoint is the boundary.
- The board renders the token column.

### Optional gateway-config smoke

A non-blocking job that boots the real LiteLLM image against `gateway/config.yaml` with mock responses and passes one call through the full backend-gateway → LiteLLM chain — insurance that the shipped upstream config stays loadable as LiteLLM versions move, without making CI depend on it.

### Docs and spec reconciliation

The sweep that closes the stage, each item finishing what its step began:

- [llm.md](../../docs/specs/llm.md) reads as one coherent document of the built system: backend metering with a DB-less LiteLLM default upstream, season-only enablement, per-slot session and per-submission run budgets, the error-code contract, no streaming, marker-based tick attribution, and the visibility rules.
- [execution.md](../../docs/specs/execution.md) (languages table, sandboxing section), [recording.md](../../docs/specs/recording.md) (null-tick nuance), [environment.md](../../docs/specs/environment.md) and [submission.md](../../docs/specs/submission.md) (flag removal, `.env` flow) are consistent with the steps that touched them.
- `docs/contributors/configuration.md` documents every `LLM_*` variable with defaults; `gateway/README.md` becomes the operator guide — running LiteLLM, provider examples, pointing `LLM_UPSTREAM_URL` at a bare provider instead, the allowlist, and budget defaults.
- `docs/students/llm.md` and the template README are verified against the shipped behavior: model names come from the deployment, errors are catchable, prompts are visible to you and operators, metadata is public.
- Stage and subplan statuses are updated per the [plans README](../README.md).

## Done when

- Both CI lanes are green with the new journeys: the integration lane proves the container-to-board pipeline against the stub upstream, byte-identical regression gates included; the e2e lane proves the operator-to-owner story in a real browser with the visibility boundary asserted at the API.
- The optional LiteLLM smoke passes locally.
- Every spec and student doc the stage touched describes the system as built, and the stage file records done.
