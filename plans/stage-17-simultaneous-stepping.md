# Stage 17: Simultaneous stepping

Status: not started.

## Goal

An environment can declare simultaneous stepping: every pace tick, every live agent decides against the same pre-tick world, the human contributes through the input latch, the environment applies all actions together, and the harness streams and records exactly one state per tick. Messaging becomes one asynchronous buffered model shared by every environment, and agents get a cross-tick LLM pattern that fits real-time ticks. Together with named builtins and the restricted seat, this completes the platform work the future role-playing environment needs.

## Scope

- A `stepping` metadata field with `sequential` as today's unchanged default and `simultaneous` as the new mode, which requires a pace interval.
- Simultaneous environments are authored as PettingZoo `ParallelEnv`. The harness gains a per-tick episode path beside the untouched sequential one, with a conformance branch and an internal fixture environment for tests.
- The unified asynchronous messaging model in every environment: messages buffered at step boundaries, delivered at the recipient's next opportunity, humans free to send at any time. This changes existing Spades behavior and retires the acting-turn chat machinery.
- A cross-tick LLM helper in the template sandbox library, the default pattern for simultaneous environments.
- Spec deltas land with the steps that build them: [Interaction](../docs/specs/interaction.md), [Environments](../docs/specs/environment.md), [Communication](../docs/specs/communication.md), [Execution](../docs/specs/execution.md), [LLM API](../docs/specs/llm.md).

Out of scope: the role-playing environment and its renderer; any public simultaneous environment, so browser end-to-end coverage of simultaneous play waits for the first real one; multi-human sessions; concurrent CPU for agent decisions, since gathering stays sequential inside a tick; changes to the step-state schema, the recording format, the relay, or the renderer contract, all of which already tolerate one state carrying every agent's entry.

## Related specifications

- [Interaction](../docs/specs/interaction.md): the session loop, the state-per-actor wording, and the timing table.
- [Environments](../docs/specs/environment.md): the stepping declaration and parallel conformance.
- [Communication](../docs/specs/communication.md): the buffered messaging model.
- [Execution](../docs/specs/execution.md): sequential agent execution within a tick and network-wait threads.
- [LLM API](../docs/specs/llm.md): the cross-tick usage pattern.

## Depends on

- [Stage 2](stage-02-harness-and-first-environment.md): the harness, metadata, and the entry-point registry.
- [Stage 3](stage-03-backend-and-live-sessions.md): the live runner, transport, and input latching.
- [Stage 8](stage-08-communication.md): the chat hook and routing this stage reworks.
- [Stage 9](stage-09-llm-gateway.md): the LLM proxy and credentials the cross-tick helper rides on.
- [Stage 13](stage-13-unified-rendering.md): the shared local runner that inherits the mode.
- [Stage 15](stage-15-wide-seats.md): players, seats, and per-seat results.

## Design decisions

### ParallelEnv is the simultaneous contract

A simultaneous environment's `make()` returns a PettingZoo `ParallelEnv`, so `env.step(actions)` applies every action together and returns per-agent observations, rewards, terminations, and truncations. Every decision seeing the same pre-tick world is structural rather than an authoring convention, and conformance uses `parallel_api_test`. The harness keeps duck-typing: the sequential path speaks AEC exactly as today, the tick path speaks the parallel API, and a load-time check verifies that the declared mode matches the shape `make()` returns.

### One stepping declaration

`EnvironmentMeta` gains `stepping: sequential | simultaneous`, defaulting to sequential. Simultaneous requires `pace_interval_ms`, which is the tick period, every actor's shared deadline, and the human deadline through the existing latched-or-default input path. The environment.md sentence making the pace interval the only distinction between turn-based and real-time is revised: it still distinguishes those two within sequential stepping, and the stepping field distinguishes sequential from simultaneous.

### The tick loop gathers, applies, and records once

`Episode.step_tick()` is a sibling of the untouched `step_once()`. Each tick it observes the pre-tick world once, sequentially collects one action per live agent under the existing per-agent timing, step-limit, budget, and LLM-scope machinery, applies one parallel step, records exactly one `StepState` whose `agents` map carries every actor's entry, and increments the tick once. On overrun the tick slips: the next tick is scheduled one full interval from completion, with no catch-up burst, while per-agent step limits keep charging and defaulting slow agents individually. Terminated players stop being called and drop out of later `agents` maps after their final-reward entry; the episode ends when the agent set empties, a global truncation fires, or a cap or budget trips. Tick slip under load is accepted, documented behavior.

### Messaging is buffered and asynchronous everywhere

One model for both stepping modes: messages sent during step or tick T are recorded on state T and delivered to recipients' inboxes at their next chat opportunity after T, so replies arrive at later ticks and nothing waits inside a tick. An agent's chat hook runs at its acting opportunity, its turn when sequential and every tick when simultaneous. Humans may send at any time; their messages latch like inputs and are admitted at the next boundary, validated there against the current recipient policy for that sender, and dropped with a diagnostic when disallowed. This retires the acting-turn opportunity machinery from Stage 15.4: the composer stays enabled for the whole session, the sender-plus-tick pairing and its one-drain grace disappear, and the relay's checks reduce to membership and the message cap. The message cap and the recorded message shape are unchanged.

### LLM calls cross ticks by default in simultaneous mode

A synchronous LLM call cannot fit inside a live tick, so the agent-facing pattern is fire-and-poll: the agent submits a request through an async helper in the template sandbox library, a thread that only waits on the network against the same proxy and per-player key, and consumes the completion at a later tick while `act()` keeps returning within its step limit. Sequential environments keep today's synchronous call with verified-wait discounting, and the helper is available to them too. The execution.md rationale that agents need no simultaneous CPU access is rephrased to cover per-tick gathering and to permit threads that only wait on the network.

### What already fits and stays untouched

The step-state schema and its TypeScript mirror accept any number of `agents` entries per state, and the recording writer, replay parsing and transport, the backend relay and its input gate, workflow aggregation, the frontend jitter buffer, and the renderer contract are all agnostic to how many entries a state carries. `view_interval_ms` remains the replay cadence, `live_interval_ms` stays a turn-based concern, and the opening presentation state already skips paced environments.

## Steps

### 17.1 [Unified asynchronous messaging](stage-17/1-unified-async-messaging.md)

The buffered model in the harness, the relaxed relay gate, the always-enabled composer, the Spades UI and test changes, and the communication.md rewrite. Lands first because the tick loop builds on it and because it changes existing turn-based behavior, so its diff stays separate from the new mode.

### 17.2 [Parallel contract and stepping metadata](stage-17/2-parallel-contract-and-metadata.md)

The `stepping` field with its validation and mirrors, the load-time shape check, the conformance branch, and the internal fixture environment.

### 17.3 [The simultaneous tick loop](stage-17/3-simultaneous-tick-loop.md)

`Episode.step_tick`, the live-loop dispatch, slip behavior, per-agent budgets and defaults, terminations, one recorded state per tick, and the playback verifications.

### 17.4 [Cross-tick LLM](stage-17/4-cross-tick-llm.md)

The async helper in the template sandbox library, its timing and accounting semantics, and the llm.md and execution.md text.

## Exit criteria

- A sequential environment behaves byte-identically to today across live play, recording, and replay.
- Harness tests with a fake clock pin the tick loop: one state per tick carrying every live agent's entry, the tick incrementing once per tick, slip without burst on overrun, a slow agent defaulted and charged individually, latched human input applied at the deadline, a terminated player dropping out after its final-reward entry, and an episode budget failure attributed to the right seat.
- The fixture environment passes `parallel_api_test` and a seeded parallel rollout determinism check, and a metadata declaration whose mode contradicts the shape `make()` returns fails at load with a typed error.
- A recorded fixture episode replays one frame per tick through the replay transport, and jsdom tests feed multi-entry states through the socket pacing and a renderer mount without assumptions breaking.
- Messaging: in a Spades session the human sends at any time, a message sent during another player's turn is delivered at the recipient's next opportunity, a disallowed recipient is dropped with a diagnostic and no forfeit, and the revised jsdom tests and Playwright journeys pass. In a simultaneous fixture episode, a message sent at tick T is readable by its recipient at tick T+1 and never at T.
- The LLM helper, against the stub upstream, submits at one tick and consumes at a later tick while every intervening `act()` returns within its step limit, in both a paced live session and an unpaced headless run.
- `uv run python scripts/ci.py python`, `generated-code-fresh`, `docs`, and `frontend-e2e` pass.
