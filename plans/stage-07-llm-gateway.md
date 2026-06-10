# Stage 7: LLM Gateway

Status: not started

## Goal

Agents can call an OpenAI-compatible LLM API from inside the sandbox with the stock `openai` client, every call is metered and logged, budgets bound the bill, and owners can inspect their agents' prompts while the public sees only usage metadata.

## Scope

Deploy the gateway per [llm.md](../specs/llm.md), configured under `gateway/`. Proposed default: LiteLLM as an off-the-shelf proxy, the one allowed exception to the TypeScript-outside rule in [execution.md](../specs/execution.md). The gateway holds the provider credentials, enforces the deployment's model allowlist, and never runs inside a session container. Evaluate at stage start whether LiteLLM's key management, logging, and budget hooks cover what this stage needs; if they fall short, put a thin service in front of it rather than reimplementing a proxy.

Implement session key issuance: when the orchestrator launches a container for an environment with the LLM flag enabled, it generates a one-off key scoped to that session, injects `OPENAI_BASE_URL` and `OPENAI_API_KEY` into the container environment, and revokes the key when the container exits. Attach the container to an internal-only network whose single reachable endpoint is the gateway, expressed through the execution driver's sandbox profile (an internal Docker network on the local driver, a network policy on the future Kubernetes driver), replacing the no-network profile from Stage 3 for these sessions; sessions without the LLM flag keep no network at all.

Capture telemetry for every call: session, slot (from the scoped key), model, full prompt and completion, input, reasoning, and output token counts, and latency. The harness stamps tick attribution, which is unambiguous because agents step sequentially. Define the telemetry sidecar payload now, attach it through the Stage 1 recording sidecar rule, and store it next to the session's recording, keyed by tick and slot, under the same schema version, per [recording.md](../specs/recording.md).

Enforce budgets and limits: per-session and per-leaderboard-run token and call budgets plus a rate limit, with deployment defaults and the Stage 6 iteration overrides. An over-budget call fails with an ordinary API error the agent can catch, and the run continues.

Surface it: per-tick model, token, and latency metadata in the replay viewer wherever the replay is public; full prompts and completions only in the owner's debug view on the agent profile; and aggregated token usage per model as a column on the automated board next to timing. Wall-clock time waiting on the model already counts against the step limits through the harness timing.

## Spec references

[llm.md](../specs/llm.md), [execution.md](../specs/execution.md) (network sandbox, gateway exception), [recording.md](../specs/recording.md) (sidecar), [leaderboard.md](../specs/leaderboard.md) (overrides, token columns), [frontend.md](../specs/frontend.md) (debug view), [submission.md](../specs/submission.md) (template `.env` flow).

## Depends on

Stage 3 (orchestrator, networks), Stage 5 (agent profile), Stage 6 (iteration overrides, board). Independent of Stage 9 (communication).

## Done when

The template repo's LLM example runs unmodified both locally with the class key in `.env` and inside a session against the gateway. From inside a container, the gateway answers and the open internet does not. A replayed session shows per-tick call metadata to everyone, prompts only to the owner, and the board shows token usage per model. A test agent that exceeds its session budget receives a catchable API error and finishes its episode, and a revoked session key stops authorizing after the container exits.

## Deviations

None yet.
