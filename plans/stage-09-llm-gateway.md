# Stage 9: LLM Gateway

Status: not started

## Goal

Agents can call an OpenAI-compatible LLM API from inside the sandbox using the stock `openai` client. Every call is metered and logged. Budgets bound the bill. Owners can inspect their agents' prompts, while the public sees only usage metadata.

## Scope

Deploy the gateway per [llm.md](../docs/specs/llm.md), configured under `gateway/`. The proposed default is LiteLLM as an off-the-shelf proxy. This is the one allowed exception to the TypeScript-outside rule in [execution.md](../docs/specs/execution.md). The gateway holds the provider credentials and enforces the deployment's model allowlist. It never runs inside a session container. At stage start, evaluate whether LiteLLM's key management, logging, and budget hooks cover what this stage needs. If they fall short, put a thin service in front of it rather than reimplementing a proxy.

Implement key issuance. When the orchestrator launches a container for an environment with the LLM flag enabled, it generates a one-off key for each agent slot, scoped to that session and slot. The harness sets `OPENAI_BASE_URL` and the acting slot's `OPENAI_API_KEY` when loading and calling that slot. Ordinary use of the stock `openai` client is therefore attributed correctly, even though agents run sequentially in one Python process. These slot keys are not a security boundary between malicious agents in the same container; that is already an accepted class-scale tradeoff in [execution.md](../docs/specs/execution.md). They are the telemetry and budget attribution mechanism. Revoke every slot key when the container exits. Attach the container to an internal-only network whose single reachable endpoint is the gateway. Express this through the execution driver's sandbox profile: an internal Docker network on the local driver, a network policy on the future Kubernetes driver. For these sessions, it replaces the no-network profile from Stage 3. Sessions without the LLM flag keep no network at all.

Capture telemetry for every call: session, slot (from the slot-scoped key), model, full prompt and completion, input, reasoning, and output token counts, and latency. The harness stamps tick attribution. This is unambiguous because agents step sequentially. Define the telemetry sidecar payload now. Attach it through the Stage 1 recording sidecar rule and store it next to the session's recording, keyed by tick and slot, under the same schema version, per [recording.md](../docs/specs/recording.md).

Enforce budgets and limits: per-session and per-leaderboard-run token and call budgets, plus a rate limit. These have deployment defaults and the Stage 6 iteration overrides. An over-budget call fails with an ordinary API error the agent can catch, and the run continues.

Surface it. Show per-tick model, token, and latency metadata in the replay viewer wherever the replay is public. Show full prompts and completions only in the owner's debug view on the agent profile. Show aggregated token usage per model as a column on the automated board, next to timing. Wall-clock time spent waiting on the model already counts against the step limits through the harness timing.

## Spec references

[llm.md](../docs/specs/llm.md), [execution.md](../docs/specs/execution.md) (network sandbox, gateway exception), [recording.md](../docs/specs/recording.md) (sidecar), [leaderboard.md](../docs/specs/leaderboard.md) (overrides, token columns), [frontend.md](../docs/specs/frontend.md) (debug view), [submission.md](../docs/specs/submission.md) (template `.env` flow).

## Depends on

Stage 3 (orchestrator, networks), Stage 5 (agent profile), Stage 6 (iteration overrides, board). Independent of Stage 8 (communication).

## Done when

The template repo's LLM example runs unmodified in both places: locally with the class key in `.env`, and inside a session against the gateway. From inside a container, the gateway answers and the open internet does not. A replayed session shows per-tick call metadata attributed to the correct slot, with prompts visible only to the owner, and the board shows token usage per model. A test agent that exceeds its session budget receives a catchable API error and finishes its episode. A revoked slot key stops authorizing after the container exits.
