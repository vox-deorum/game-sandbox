# Stage 9.6: Testing, CI, and Docs

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 6: the cross-cutting companion every stage since 2 has shipped — the whole-stage journeys no single step can own, the CI wiring that keeps them running, and the final reconciliation sweep across specs and student docs. Per-step tests live in each subplan; this step tests the seams _between_ them.

## Why this is its own seam

- The stage's "done when" sentences are cross-step by construction: "the template's example runs unmodified in both places" spans steps 1–3, "prompts visible only to the owner" spans 1 and 5, "a revoked key stops authorizing" spans 1–2.
- Those journeys need the full stack, Docker, and a browser — exactly the machinery the `backend-integration` and `e2e.yml` lanes already own. Bundling them with the docs sweep mirrors stages 5–8 and keeps every earlier step lean.

## What to build

### The whole-stage integration journey

In the Docker-gated `backend-integration` lane, against a stub OpenAI upstream (an in-process HTTP server — the gateway requires only "an OpenAI-compatible endpoint," and the stub pins that contract):

- **End-to-end session**: a season configured with LLM enabled, a tier list, and small budgets; a session with the step 3 oracle runs end to end. Inside the container the gateway answers and the internet does not; the session's telemetry file under `data/llm/` holds a row per call, failures included, tick-matched to the acting slot's recorded steps; the saved slot key is dead after exit; the network and relay attachment are gone.
- **Run budget**: a two-match mini-run under a tiny per-submission run budget reproduces the step 4 journey across sessions — exhaustion in match two, a caught error, an honest finish, no forfeit, and board rows with token usage by tier.
- **Regression gates**: a messaging-era Spades session and a plain Flappy Bird session re-run byte-identical to their pre-stage recordings, proving the LLM path adds nothing when disabled.

### The browser journey

`llm.spec.ts` joins `e2e.yml` beside `spades.spec.ts`, on the same stub upstream:

- An operator enables LLM on a season in the admin console's new fields; a watch session with the oracle runs.
- The replay shows the Model-calls panel ticking under the scrubber, with the run-cost summary.
- The owner's profile debug view shows full prompts while a logged-out context shows none — asserted at both the UI and the raw-API level, since the endpoint is the boundary.
- The board renders the token column.

### Docs and spec reconciliation

The sweep that closes the stage, each item finishing what its step began:

- [llm.md](../../docs/specs/llm.md) reads as one coherent document of the built system: the backend-embedded gateway calling one OpenAI-compatible endpoint through the official `openai` SDK, the `large`/`medium`/`small` tier vocabulary, season-only enablement, per-slot session and per-submission run budgets, the error-code contract, no streaming, marker-based tick attribution, per-scope telemetry files, and the visibility rules.
- [execution.md](../../docs/specs/execution.md) (languages table with the separate-service row gone, sandboxing section), [environment.md](../../docs/specs/environment.md) and [submission.md](../../docs/specs/submission.md) (flag removal, `.env` flow) are consistent with the steps that touched them.
- `docs/contributors/configuration.md` documents every `LLM_*` variable with defaults, the tier mapping, and the operator guidance: choosing a provider, or pointing `LLM_UPSTREAM_URL` at a router the deployment operates (OpenRouter, a self-hosted LiteLLM) when one provider is not enough.
- `docs/students/llm.md` and the template README are verified against the shipped behavior: the tiers are fixed and the deployment decides what stands behind them, errors are catchable, prompts are visible to you and operators, metadata is public.
- Stage and subplan statuses are updated per the [plans README](../README.md).

## Done when

- Both CI lanes are green with the new journeys: the integration lane proves the container-to-board pipeline against the stub upstream, byte-identical regression gates included; the e2e lane proves the operator-to-owner story in a real browser with the visibility boundary asserted at the API.
- Every spec and student doc the stage touched describes the system as built, and the stage file records done.
