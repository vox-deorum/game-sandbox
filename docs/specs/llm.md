# LLM API for Agents

Agents may call language models through an OpenAI-compatible API provided by the deployment. The capability is optional and may be disabled by the environment or season.

## What agents see

Agent code reads:

- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`

The same code works locally and on the server. Locally, the participant uses credentials provided by the instructor. On the server, the orchestrator creates a temporary key for one session and slot, then revokes it when the container exits. See [Submissions](submission.md).

## The gateway

```text
Agent slot → internal network → LLM gateway → configured provider
                                  │
                                  └→ telemetry and budget checks
```

The gateway runs outside the session container and holds the real provider credentials. Containers cannot reach the general internet. Their only permitted network endpoint is the gateway, which enforces the allowed models and budgets. See [Execution](execution.md).

This keeps model use sanctioned and comparable across participants while preserving the broader rule that agents cannot contact arbitrary outside services. Calls are metered and logged rather than hidden behind participant-controlled credentials.

## Telemetry

The gateway records:

- Session, tick, and slot.
- Model.
- Full prompt and completion.
- Input, reasoning, and output token counts.
- Latency.

Telemetry is stored beside the recording as a versioned sidecar. Public replay views show model, token, and latency summaries. Full prompts and completions are visible only to the agent owner and operators. See [Recording](recording.md) and [Frontend](frontend.md).

## Budgets and limits

Each session and leaderboard run has token, call, and rate limits. A season may override deployment defaults. A call over budget returns a normal API error that the agent can handle, and the game continues.

## Determinism and timing

A seed does not make a model response deterministic. Seeded repetitions reduce the effect of stochastic policies but do not remove it.

Time waiting for a model counts toward the agent's step and episode limits. The automated board reports timing and token use by model. See [Leaderboards](leaderboard.md).
