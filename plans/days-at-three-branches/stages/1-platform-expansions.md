# Step 1: Platform contract expansions

Status: planned.

Part of [the plan](../README.md). This is build-order step 1: every contract change the design assumes, landed together as one reviewable platform change before any game code exists. The hands-on surface is a fixture simultaneous `Dict` environment passing the full conformance suite, with bounded broadcasts, public delivery, and an agent that precomputes from its setup observation, all visible in a harness test run.

## Why this is its own seam

These changes touch the harness, metadata schema, and backend, and every later step builds on them. A fixture proves the platform contracts before the game depends on them and keeps every existing environment green.

## What to build

### Mask-free Dict actions in simultaneous environments

The platform specification currently limits a `Dict` action space to sequential environments. The pinned PettingZoo `parallel_api_test` only breaks on a published `action_mask`: `sample_action` reduces a mask with `np.flatnonzero`, but an observation without an `action_mask` key samples through the action space itself, which handles a `Dict` correctly. Narrow the rule in [environment.md](../../../docs/specs/environment.md): a simultaneous environment may declare a `Dict` action space when it publishes no mask and every in-space value is legal in every reachable state. `Dict` plus a published mask stays sequential-only until the upstream fix reaches a release.

### Environment-limited broadcasts

`ChatRouter.deliver` sends a broadcast to every other active player. The environment gains an optional `broadcast_recipients(sender)` hook, discovered and validated like `chat_policy`, returning the players a broadcast from `sender` reaches this boundary. No hook keeps today's full delivery. Three Branches uses it to bound an NPC shout to shout range and the visitor's broadcast to talk range. Document the hook in [communication.md](../../../docs/specs/communication.md).

### Public messages

`EnvironmentMeta` gains `public_messages: bool = False`, threaded through `to_json`, the zod environment schema, the regenerated JSON schema, the backend registry, and the live-session visibility check. Today a spectator never sees a targeted message live, and every NPC talk is targeted, so watchers of this game would see only shouts. A declared-public environment's delivered lines reach every viewer socket; replays already show every line. The spectator-facing test lands with the chat panel in step 3.

### The setup observation

`reset(seed)` becomes `reset(seed, observation)`, and it becomes a timed, charged hook.

Today an agent's episode setup has nowhere to go. `reset` runs before any observation exists, so anything derived from standing knowledge has to be built inside the first `act` call under the per-decision limit. An overrun there is silent: the harness substitutes the default action, charges the time, and the agent loses the tick without an error to read. This plan's case is a route graph over the village layout, which is too large to build inside 0.25 seconds and too useful to leave out.

The two stepping modes need different plumbing for the same contract:

- Simultaneous environments already have it. `Episode.start` unpacks the parallel observations from `env.reset(seed=...)` before it resets agents, so each player's initial observation is in hand and passes straight through.
- Sequential environments do not. An AEC `reset()` returns nothing, and the harness first pulls an observation through `env.last()` during the opening step, well after agents reset. The harness therefore calls `env.observe(player)` for each resolved player after the environment reset and hands each agent its own.

Either way the promise is the same: every agent-controlled player receives the observation it would see on its first turn. Human players keep receiving nothing, as they do today.

`reset` currently runs through no timer and touches no budget, so it is bounded by nothing short of the backend's container watchdog. Route it through the same timing path as `act`, `chat`, and `learn`, and add its cost to the player's episode budget. That budget is the only bound: an environment that wants to allow heavy setup raises it, and there is no separate per-call limit to tune. Run the episode-limit check immediately after agents reset, with the existing attribution, so an agent that spends its whole budget on setup fails there instead of after the first step. Setup LLM calls keep their null tick attribution, and [llm.md](../../../docs/specs/llm.md) drops the claim that they occur before turn timing.

The seam is not specific to this game. A Crane agent can build its terrain cost map once per match, and a card agent can study its opening hand, both off the per-decision clock.

Blast radius, landed together here: `AgentBase.reset`, the `is_agent` structural check, the harness call site, four environment templates, twelve example agents, six builtins, and the test doubles under `harness/tests/`, `environments/*/tests/`, `backend/test/fixtures/validate/`, and `frontend/e2e/fixtures/submission/`. The parity test comparing each template stub against `AgentBase` catches any that drift. The interface table in [submission.md](../../../docs/specs/submission.md) and the student [agent interface](../../../docs/students/agent-interface.md), including its call-order diagram, follow in the same change.

### Live-session lifetime

Make `SESSION_MAX_DURATION_MS` an optional explicit override. When it is set, its positive value remains the chargeable-duration limit for every live session. When it is absent and `pace_interval_ms` is positive, derive the limit from `recommended_episode_ticks * pace_interval_ms`, plus the sum of each agent-controlled player's resolved `episode_timeout_ms`, plus a 60-second platform-overhead allowance. That allowance covers session startup, completed environment transitions, recording work, and teardown. When the override is absent and `pace_interval_ms` is `None`, use the current 600-second fallback. Remove the default environment setting that would otherwise turn 600 seconds into an override for every deployment. Replace the fixed deployment-wide rule in [execution.md](../../../docs/specs/execution.md), update the configuration guide, implement the calculation in backend session setup, and cover each branch with integration tests. This lets a naturally paced day reach its final transition without changing the default bound for turn-based games.

Human-session idleness is owned separately from the duration cap. A connected owner socket keeps a human-play session alive even when the owner sends no commands. Arm the idle timeout only when the last owner socket disconnects. Spectator sockets do not keep a human-play session alive. Scripted watch sessions retain their viewer-based idle rule. Update the lifetime rule in [frontend.md](../../../docs/specs/frontend.md) and the pause behavior in [interaction.md](../../../docs/specs/interaction.md).

### The fixture

A minimal simultaneous environment with a mask-free `Dict` action space joins the harness test fixtures, exercising conformance, the broadcast hook, public visibility, the setup observation, and the derived session-duration rule end to end.

Human capability needs no platform work: the visitor is `player_0` in every plan, so `human_players` is the single entry `player_0` and resolves correctly everywhere today.

## Tests

- The fixture through PettingZoo's `parallel_api_test` and the platform's stricter parallel subset.
- Broadcast hook validation, the no-hook fallback, and delivery bounds.
- `public_messages` round-trip through the zod schema and the backend visibility check.
- Every agent-controlled player receives its first-turn observation at reset in both stepping modes: a simultaneous fixture through the reset mapping, and each shipped sequential environment through `env.observe`. A human player still receives no reset call.
- Reset time is charged to the player's episode budget, an agent that exhausts its budget in reset fails at reset with its own player attributed at the environment's forfeit floor, and the existing reset-crash attribution still holds.
- With no override, a paced environment receives the derived duration, including its 60-second platform-overhead allowance, and an unpaced environment receives the 600-second fallback. A positive `SESSION_MAX_DURATION_MS` overrides both. Tests cover all three paths.
- A quiet connected human owner remains live, the timeout starts after the last owner socket detaches, spectators do not extend a human session, and scripted watch sessions remain viewer-based.

## Done when

The fixture is green across the conformance suite, a fixture broadcast reaches exactly the hook's audience, a public fixture line is visible to a non-controller, an agent builds from its first-turn observation inside `reset` in both stepping modes with the cost on its episode budget, a naturally paced fixture can reach its final transition, and the revised specifications state each rule.
