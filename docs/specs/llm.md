# LLM API for Agents

Agents may call a large language model through an OpenAI-compatible API that the sandbox provides. Like messaging (see [communication.md](communication.md)), this is optional: an agent that never calls the API loses nothing, and an environment can leave the API disabled (see [environment.md](environment.md)).

## What agents see

Agent code reads `OPENAI_BASE_URL` and `OPENAI_API_KEY` from its environment, so the stock `openai` Python client works with no configuration. During local development, the template repo instructs participants to put the class-provided key in a `.env` file (see [submission.md](submission.md)). Server-side, the orchestrator creates a dynamically generated one-off key for each agent slot in the session. The harness presents the gateway address and the acting slot's key through the same environment variables when that slot is loaded and called. Each key authorizes only that session and slot, and is revoked when the container exits. The agent code is identical in both places, it just reads the environment.

## The gateway

The gateway runs on the backend server, never inside the session container, so participant code can never see the real provider key. Session containers have no general network access; each is attached to an internal-only network whose single reachable endpoint is the gateway (see [execution.md](execution.md)). The gateway holds the provider credentials, forwards requests to the configured providers, and enforces the allowed model list, which is deployment configuration.

The sandbox originally blocked all network access so an agent could not secretly outsource its decisions to an outside model. The gateway keeps the intent of that rule while changing its letter: model use is sanctioned, equal for every participant, metered, and fully logged, and arbitrary network access stays blocked.

## Telemetry

The gateway records every call: the session, the agent slot identified by its slot key, the model, the full prompt and completion, input, reasoning, and output token counts, and latency. Agents step sequentially, so each call maps cleanly to the tick it ran on, and the harness stamps that attribution. Telemetry is stored as a sidecar next to the session's recording, keyed by tick and slot and covered by the same schema version (see [recording.md](recording.md)). Because the gateway sits server-side, telemetry capture never crosses the container boundary.

Models used, token counts, and latency are public wherever the replay is public. Full prompts and completions are visible only to the agent's owner through a debug view (see [frontend.md](frontend.md)), so a participant's prompting strategy stays private while the operator can still audit everything.

## Budgets and limits

Each session and each leaderboard run carries a token and call budget plus a rate limit, with deployment defaults that a season can override (see [leaderboard.md](leaderboard.md)). A call over budget fails with an ordinary API error that the agent can catch, and the run continues. Budgets are what keep the operator's bill bounded.

## Determinism and timing

Seeds control the environment and the agent's own randomness, not the model, so an LLM-backed agent is a stochastic policy. The leaderboard already absorbs stochastic policies through seeded repetitions (see [leaderboard.md](leaderboard.md)). Wall-clock time spent waiting on the model counts against the per-step and per-episode limits like any other time, so a slow model is a real cost the agent's author chose. The automated board also shows token usage per model from telemetry next to its timing column.
