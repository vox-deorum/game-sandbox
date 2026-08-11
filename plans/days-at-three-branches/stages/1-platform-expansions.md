# Step 1: Platform contract expansions

Status: complete.

Part of [the plan](../README.md). This step landed mask-free simultaneous `Dict` actions, environment-limited broadcasts, live watcher visibility, setup observations, and live-session lifetime. A simultaneous fixture and backend tests cover these contracts.

## Landed contracts

### Mask-free `Dict` actions

A simultaneous environment may publish a `Dict` action space without an action mask when every value in the space is legal in every reachable state. The fixture proves that contract through PettingZoo parallel conformance and the platform's stricter subset.

### Environment-limited broadcasts

`ChatRouter.deliver` discovers and validates the optional `broadcast_recipients(sender)` hook in the same way as `chat_policy`. The hook returns the players a broadcast reaches at that boundary. Without it, broadcasts reach everyone. Three Branches uses the hook for characters within the speaker's hearing range. [communication.md](../../../docs/specs/communication.md) defines the hook.

### Live watcher visibility

Every non-controller socket receives every delivered line, including targeted messages, in both live filtering and connection catch-up. A human controller receives broadcasts and targeted lines to or from one of its external players. This matches replay visibility.

### Setup observations

`reset(seed, observation)` is a timed, charged agent hook. Every agent-controlled player receives the observation it would see on its first turn; human players receive no reset call.

- Simultaneous episodes pass the mapping returned by `env.reset(seed=...)` to each agent.
- Sequential episodes call `env.observe(player)` for each resolved player after the environment reset.

Reset follows the existing timing and attribution path for `act`, `chat`, and `learn`. Its cost counts against the episode budget, with no separate reset limit. The harness checks the budget immediately after agent resets and applies existing player forfeit attribution to exhaustion. Setup LLM calls keep null tick attribution. [llm.md](../../../docs/specs/llm.md) defines that timing.

`AgentBase.reset`, all environment templates, shipped examples, builtins, test doubles, the submission interface table, and the student agent-interface guide now use the same contract. The callable-only `is_agent` structural check remains unchanged, and template parity tests compare each stub with `AgentBase`.

### Live-session lifetime

`SESSION_MAX_DURATION_MS`, when set, is the positive chargeable-duration limit. Otherwise, a positive `pace_interval_ms` derives the limit from `recommended_episode_ticks * pace_interval_ms`, every agent-controlled player's resolved `episode_timeout_ms`, and a 60-second platform allowance. An absent or zero pace interval uses the 600-second fallback. [execution.md](../../../docs/specs/execution.md), the configuration guide, session setup, and integration tests share this rule.

Human-session idleness is separate. A connected owner socket keeps a human-play session alive, the idle timeout starts after the last owner disconnects, and spectator sockets do not extend that session. Scripted watch sessions retain viewer-based idleness. [frontend.md](../../../docs/specs/frontend.md) and [interaction.md](../../../docs/specs/interaction.md) define the corresponding pause and lifetime rules.

## Fixture and verification

The minimal simultaneous fixture has a mask-free `Dict` action space and three human-capable players. It exercises parallel conformance, the broadcast hook, setup observations, and natural paced completion.

Tests verify:

- parallel conformance, the broadcast hook and its no-hook fallback, and exact delivery bounds;
- watcher and human-controller visibility, including connection catch-up;
- first-turn setup observations in both stepping modes, no human reset call, reset-budget attribution, reset exhaustion, and reset-crash attribution;
- derived paced duration with its allowance, the unpaced fallback, and an explicit positive override; and
- connected-owner idleness, last-owner disconnect, spectator exclusion, and scripted-watch viewer idleness.

The fixture and platform tests are green, including bounded broadcasts, watcher-visible targeted delivery, charged setup observations in both modes, and a paced episode that reaches its final transition. The revised specifications state these contracts.
