# Stage 17: Simultaneous stepping

Status: not started.

## Goal

An environment can declare simultaneous stepping and return a PettingZoo `ParallelEnv`. Each tick snapshots one pre-step world, gathers one action from every active player, applies those actions together, and emits one state containing every player that acted.

Messaging uses one buffered asynchronous model in both stepping modes. Agent and human messages join one boundary batch, appear on that boundary's recorded state, and become readable only at a later acting opportunity.

## Scope

- Every environment explicitly declares `stepping` as `sequential` or `simultaneous`.
- Sequential environments continue to return an AEC environment. Simultaneous environments return a `ParallelEnv` and require `pace_interval_ms`.
- The harness validates the constructed environment against its declaration after resolving the session parameters.
- `Episode.step_tick()` runs one parallel tick beside the AEC `step_once()` path. Both paths share action, chat, learning, accounting, player-lifecycle, and state-building helpers where their semantics agree.
- A simultaneous live cadence is a minimum interval between ticks. Agent decisions remain sequential and retain their individual compute limits. An overrun slips the next tick rather than skipping another player or producing a catch-up burst.
- AEC and parallel players may terminate or truncate individually. Inactive players receive no later hooks, while their latest recorded score remains available to replay summaries.
- The shared decision log shows every player action in a multi-entry state.
- Human chat is always available while the designated external player is active. The acting-turn opportunity and compose-tick machinery are removed.
- Spec changes land with the work: [Communication](../docs/specs/communication.md), [Interaction](../docs/specs/interaction.md), [Environments](../docs/specs/environment.md), [Execution](../docs/specs/execution.md), and [Recording](../docs/specs/recording.md).

Stage 17 targets a fresh, pre-release checkout. Environment metadata and the internal chat command shape change in place, with no compatibility path.

Out of scope: the role-playing environment and its renderer; a registered public simultaneous environment; multi-human sessions; concurrent CPU execution for agent decisions; message-only transport states; changes to the recorded message object; background or cross-tick LLM execution; and changes to the renderer contract. The ordinary synchronous LLM API remains available, and its wall-clock wait may make a simultaneous tick slip.

## Related specifications

- [Communication](../docs/specs/communication.md): boundary admission, delayed delivery, recipient policy, and the human sender.
- [Interaction](../docs/specs/interaction.md): AEC steps, parallel ticks, pacing, state shape, input snapshots, and chat.
- [Environments](../docs/specs/environment.md): the required stepping declaration and the AEC or parallel authoring contract.
- [Execution](../docs/specs/execution.md): sequential decision collection inside one parallel tick.
- [Recording](../docs/specs/recording.md): multi-entry state lines and final scores derived from each player's latest entry.

## Depends on

- [Stage 2](stage-02-harness-and-first-environment.md): the harness, metadata, and environment registry.
- [Stage 3](stage-03-backend-and-live-sessions.md): live pacing, transport, and input latching.
- [Stage 8](stage-08-communication.md): the chat hook and routing this stage simplifies.
- [Stage 13](stage-13-unified-rendering.md): the shared production and local live runner.
- [Stage 15](stage-15-wide-seats.md): the player and seat split, per-player execution, and per-seat results.

## Design decisions

### Stepping is explicit and checked against the constructed environment

`EnvironmentMeta` requires `stepping: sequential | simultaneous`. The three existing environments declare `sequential`; no omitted value is interpreted. A simultaneous declaration requires a positive `pace_interval_ms` and no separate human move timeout.

`EnvironmentEntry.make()` may return either AEC or parallel PettingZoo behavior. `Episode.start()` calls the factory with the actual resolved parameters, checks the required protocol surface against `meta.stepping`, resets the environment, and then performs the existing resolved-player check. A mismatch raises a typed `EnvironmentContractError` naming the environment and declared mode. Discovery does not construct an environment with default parameters and cannot validate the wrong variant.

The harness keeps the dependency direction unchanged. It uses explicit duck-typed AEC and parallel protocol checks rather than importing the environments package or PettingZoo.

### The pace interval is a cadence, not a shared compute deadline

At a simultaneous cadence boundary, the harness snapshots every active observation and consumes the designated human player's latched input. It then calls agent-controlled players sequentially in canonical player order. Every agent retains the existing step and episode compute limits.

A slow action is charged to that player and replaced with its legal default after the hook returns. The harness does not preempt Python work, skip later players, or create seat-order deadline bias. An illegal agent action remains an attributable failure. An absent or illegal human input uses the legal default and records the existing diagnostic.

After all actions are available, the environment applies them in one `env.step(actions)` call. If collection and stepping overrun the cadence, the next tick is scheduled one full interval after completion. Headless runs keep no wall-clock pacing and execute the next tick immediately.

### One completed parallel step produces one state

`Episode.step_tick()` records one `StepState` for one completed parallel step. Its `agents` map contains an entry for every player that acted, in canonical order, with that player's action, reward, cumulative score, and decision, chat, and learning timing. The state tick increments once.

The pre-step observation snapshot ensures every decision describes the same world even though the hooks run sequentially. All action hooks finish before any chat hook runs. Agent chat therefore knows its own chosen action but not another player's returned action or the joint step result through a harness API.

The existing state schema already accepts several `agents` entries. Recording JSONL, the relay, socket pacing, and renderers continue to carry one state object without a parallel-only envelope.

### Player lifecycle is mode-neutral

PettingZoo decides which players remain active. AEC dead steps are consumed without invoking participant hooks or emitting a recorded state. A parallel player that terminates or truncates on a joint step receives that step's reward, score, and learning call with its terminal flag, then disappears from later action sets and state entries.

An episode continues while its environment has active players unless a stop, tick cap, player budget, or attributable failure ends it. When several player budgets cross their limit on the same parallel tick, canonical player order selects the reported failed player after the completed tick is recorded.

Replay summaries scan the recording and retain each player's latest score instead of assuming every player appears in the final state. This covers individually inactive AEC and parallel players without adding persistent score snapshots or actionless entries to the state schema.

### Messaging has one pre-step admission boundary

The product still designates one external human player. After action collection and before chat hooks, the harness atomically drains that player's bounded FIFO and validates the batch against the pre-step recipient policy. Agent chat output is validated against the same pre-step world.

All accepted human and agent messages form one boundary batch. They are recorded on the state produced by that boundary and delivered only after every chat hook and the environment step have completed. No agent reads a message from the boundary whose actions are being applied. In AEC mode the next opportunity is the recipient's next live turn; in parallel mode it is the next tick in which the recipient remains active.

The human chat command carries `player`, `to`, and `text`, with no compose tick. The sender must be the session's designated external player. Per boundary, the existing one-message-per-direct-recipient plus one-broadcast limit applies. Stale, inactive, over-limit, and policy-disallowed messages are dropped with stderr diagnostics and never forfeit a seat.

Every emitted live state carries the designated human player's current `chat_options` while that player is active. The options describe the post-step world in which the next message will be composed, so the next pre-step admission check sees the same policy unless the environment changes at that boundary. Self-contained states keep reconnect and local play on the existing latest-state path. The composer stays enabled across actions and resets its recipient only when the policy value changes.

### Multi-entry states are visible to shared consumers

Workflow aggregation already looks up each player independently in every state. It gains a multi-entry regression test but no new reduction path.

The live and replay decision-log adapters flatten every `agents` entry into a row keyed by `(tick, player)`, ordered by tick and canonical player order. AEC recordings still yield one row for each real action.

Replay final standings retain the latest score seen for every player across the recording. Replay transport, seek, live jitter buffering, and renderer mounting receive multi-entry fixture states in tests to pin their existing state-level behavior.

## Steps

### 17.1 [Unified asynchronous messaging](stage-17/1-unified-async-messaging.md)

Remove acting-turn admission, define the boundary batch, simplify the human command, publish a self-contained policy on every live state, and update Spades, local play, production relay, unit tests, browser journeys, and the communication specifications.

### 17.2 [Parallel contract and stepping metadata](stage-17/2-parallel-contract-and-metadata.md)

Require the stepping declaration, validate the constructed AEC or parallel protocol, branch registered-environment conformance, and add an unregistered parallel fixture for direct tests.

### 17.3 [The simultaneous tick loop](stage-17/3-simultaneous-tick-loop.md)

Add the tick path and its live and headless dispatch, completion-based cadence, mode-neutral player lifecycle, multi-entry decision logs, last-seen replay scores, and end-to-end fixture coverage.

## Exit criteria

- Every existing environment explicitly declares sequential stepping and preserves its non-messaging AEC action, score, timing, recording, and replay behavior.
- A declaration whose mode contradicts the environment built from the resolved parameters fails at episode start with `EnvironmentContractError`.
- The fixture passes `parallel_api_test`, validates JSON-safe observations and overlays through a seeded deterministic rollout, and is absent from the public environment registry.
- Fake-clock harness tests pin one state and one tick increment per parallel step, canonical multi-player entries, pre-step observation and input snapshots, per-player timing and defaults, illegal-agent attribution, completion-based slip, and no catch-up burst.
- AEC and parallel lifecycle tests terminate one player while others continue. The inactive player receives its final reward and terminal learning call, receives no later hooks, and remains present in replay standings through its last recorded score.
- A simultaneous tick that pushes several players past their episode budgets completes and records once, then attributes failure to the first player in canonical order.
- In Spades, the human composer remains available across turns. A queued message is validated at the next pre-step boundary, recorded there, and delivered only at the recipient's later opportunity. A disallowed target is dropped with an stderr diagnostic and no forfeit.
- In the parallel fixture, every chat hook for tick T runs before tick T messages are delivered, and an active recipient first reads them during tick T+1.
- Chat commands without compose ticks round-trip through the browser, production relay, local relay, and harness. Reconnect receives usable current `chat_options` from the latest live state.
- The live and replay decision logs show every `(tick, player)` action from a multi-entry state, while AEC logs retain one action row per completed step.
- Workflow timing aggregation, replay seek and playback, live socket pacing, and a renderer mount accept multi-entry states without a parallel-specific transport or renderer branch.
- The specs state that synchronous model calls are supported but can slip simultaneous ticks, and do not describe background or cross-tick execution as a platform feature.
- `uv run python scripts/ci.py python`, `generated-code-fresh`, `docs`, and `frontend-e2e` pass.
