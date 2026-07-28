# Stage 17.4: Cross-tick LLM

Status: not started.

Part of [Stage 17](../stage-17-simultaneous-stepping.md), build-order step 4.

## Outcome

Agents in simultaneous environments use the LLM proxy without stalling ticks: a request is submitted at one tick and its completion consumed at a later one, while `act()` keeps returning within its step limit. The helper ships in the template sandbox library and works identically with development keys and injected session keys.

## The helper

A small fire-and-poll wrapper in the template sandbox library: `submit()` starts one logical completion request on a background thread that only waits on the network, and a non-blocking handle exposes pending, completed, or failed with the same OpenAI-compatible response or error the synchronous path yields. The agent polls the handle from `act()` on later ticks and falls back to its ordinary policy while pending. No harness API changes: the proxy, per-player keys, budgets, rate limits, and telemetry are exactly the Stage 9 machinery, and a request that completes after the episode ends is simply discarded with its usage already metered by the proxy.

Timing: the call runs outside any hook, so no verified-wait discount applies or is needed; the agent's charged time is only what it spends submitting and polling inside its hooks. Sequential environments keep today's synchronous call with discounting, and may use the helper too.

## Specification

[LLM API](../../docs/specs/llm.md) documents the cross-tick pattern as the default for simultaneous environments and states that a synchronous call does not fit a live tick. [Execution](../../docs/specs/execution.md) permits threads that only wait on the network within the sequential-CPU rationale.

## Tests

- Against the stub upstream: submit at tick T, completion consumed at a later tick, every intervening `act()` within its step limit, in a paced live session and an unpaced headless run.
- A failed request surfaces on the handle without affecting the episode; budget exhaustion returns the ordinary catchable error.
- The template example demonstrating the pattern runs with a development key and with injected session credentials.
