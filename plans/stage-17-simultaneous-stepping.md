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
- A simultaneous live session emits an unrecorded opening presentation state after reset, before its first cadence interval, so the human can render legal controls, latch input, and compose chat for tick 0.
- AEC and parallel players may terminate or truncate individually. Inactive players receive no later hooks. AEC states carry reward-only entries when a non-acting player receives reward or becomes inactive, so every player's latest recorded score remains available to replay summaries.
- Shared decision logs and chat threads show every player action in a multi-entry state while presenting the state's messages once.
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

Game Sandbox deliberately narrows the permissive parallel API. All resolved players are active after reset. The active set only shrinks. Every joint action and all five returned step mappings exactly cover the players active before that step, and post-step `env.agents` is the canonical subsequence whose termination and truncation flags are both false. The harness validates those facts at reset and after every step.

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

PettingZoo decides which players remain active within the stricter roster contract above. AEC dead steps are consumed without invoking participant hooks or emitting a recorded housekeeping state. The preceding real-action state includes reward-and-score entries without actions or timing for any other player that received reward or became inactive on that transition. A parallel player that terminates or truncates on a joint step receives that step's reward, score, and learning call with its terminal flag, then disappears from later action sets and state entries.

An explicit stop prevents the next environment step, and an attributable participant failure can abort before a joint step. After a completed step is recorded, player budget exhaustion is checked first. When several player budgets cross their limit on the same parallel tick, canonical player order selects the reported failed player. Otherwise, an empty environment produces its natural result: `truncated` if any player naturally truncated, and `terminated` otherwise. That natural result wins when the same step also reaches the tick cap. A tick cap produces `truncated` only when players remain active.

One shared state reduction scans a recording and retains each player's latest score instead of assuming every player appears in the final state. Replay summaries and replay game-over standings use that complete map. Live and local game-over standings use the complete result-envelope map, with accumulated state scores as reconnect fallback. This covers individually inactive AEC and parallel players without adding persistent score snapshots or actionless entries to the state schema.

### Messaging has one pre-step admission boundary

The product still designates one external human player. After action collection and before chat hooks, the harness atomically drains that player's bounded FIFO and validates the batch against the pre-step recipient policy. Agent chat output is validated against the same pre-step world.

All accepted human and agent messages form one boundary batch. Limits apply independently to each sender. Recording order is the human FIFO first, then agent batches in canonical player order, retaining each sender's returned order. The batch is recorded on the state produced by that boundary and delivered only after every chat hook and the environment step have completed. No agent reads a message from the boundary whose actions are being applied. In AEC mode the next opportunity is the recipient's next live turn; in parallel mode it is the next tick in which the recipient remains active.

The human chat command carries `player`, `to`, and `text`, with no compose tick. The sender must be the session's designated external player. Per boundary, the existing one-message-per-direct-recipient plus one-broadcast limit applies. Stale, inactive, over-limit, and policy-disallowed messages are dropped with stderr diagnostics and never forfeit a seat.

Every emitted live state carries the designated human player's current `chat_options` while that player is active. The options describe the post-step world in which the next message will be composed, so the next pre-step admission check sees the same policy unless the environment changes at that boundary. Self-contained states keep reconnect and local play on the existing latest-state path. The composer stays enabled across actions and resets its recipient only when the policy value changes.

### Multi-entry states are visible to shared consumers

Workflow aggregation already looks up each player independently in every state. It gains a multi-entry regression test but no new reduction path.

The live, local, and replay adapters flatten every action-bearing `agents` entry into a row keyed by `(tick, player)`, ordered by tick and canonical player order. Reward-only AEC entries update score summaries but do not create decision rows. Replay highlighting works by tick or tick group rather than treating a state index as a flattened decision index. `GameThread` renders each state's messages once after that state's decision group. AEC recordings still yield one row for each real action.

Replay and directly opened ended-session standings retain the latest score seen for every player across the recording. Live and local standings retain the result envelope's complete player scores. Replay transport, seek, live jitter buffering, and renderer mounting receive multi-entry fixture states in tests to pin their existing state-level behavior.

## Steps

### 17.1 [Unified asynchronous messaging](stage-17/1-unified-async-messaging.md)

Remove acting-turn admission, define the boundary batch, simplify the human command, publish a self-contained policy on every live state, and update Spades, local play, production relay, unit tests, browser journeys, and the communication specifications.

### 17.2 [Parallel contract and stepping metadata](stage-17/2-parallel-contract-and-metadata.md)

Require the stepping declaration, validate the constructed AEC or parallel protocol, branch registered-environment conformance, and add an unregistered parallel fixture for direct tests.

### 17.3 [The simultaneous tick loop](stage-17/3-simultaneous-tick-loop.md)

Add the tick path and its live and headless dispatch, completion-based cadence, mode-neutral player lifecycle, multi-entry decision logs, last-seen replay scores, and end-to-end fixture coverage.

## Exit criteria

- Every existing environment explicitly declares sequential stepping and preserves its non-messaging AEC action, score, timing, and replay behavior. AEC states add only the reward-and-lifecycle entries needed to preserve non-acting players' final scores.
- A declaration whose mode contradicts the environment built from the resolved parameters fails at episode start with `EnvironmentContractError`.
- A simultaneous reset whose active players differ from the resolved canonical roster, a step mapping with missing or extra keys, a revived player, or a post-step active set that contradicts the terminal flags fails with `EnvironmentContractError`.
- The fixture passes `parallel_api_test`, validates JSON-safe observations and overlays through a seeded deterministic rollout, and is absent from the public environment registry.
- A human simultaneous session receives an unrecorded reset overlay and `chat_options` before the first cadence wait, and input latched from that frame is eligible for tick 0.
- Fake-clock harness tests pin one state and one tick increment per parallel step, canonical multi-player entries, pre-step observation and input snapshots, per-player timing and defaults, illegal-agent attribution, completion-based slip, and no catch-up burst.
- AEC and parallel lifecycle tests terminate one player while others continue. A player that acted on its terminal transition receives its terminal learning call. A non-acting AEC player receives a reward-only state entry rather than a synthetic hook. Neither receives later hooks, and both remain present in live, local, ended-session, and replay standings through complete score maps.
- A mixed natural ending reports `truncated` regardless of AEC dead-step order; an all-termination ending reports `terminated`.
- When natural completion and the tick cap coincide on one recorded step, the natural result wins in AEC and parallel modes. A cap reached while players remain active reports `truncated`.
- A simultaneous tick that pushes several players past their episode budgets completes and records once, then attributes failure to the first player in canonical order.
- In Spades, the human composer remains available across turns. A queued message is validated at the next pre-step boundary, recorded there, and delivered only at the recipient's later opportunity. A disallowed target is dropped with a standard-error diagnostic and no forfeit.
- In the parallel fixture, every chat hook for tick T runs before tick T messages are delivered, and an active recipient first reads them during tick T+1.
- Chat commands without compose ticks round-trip through the browser, production relay, local relay, and harness. Reconnect receives usable current `chat_options` from the latest live state.
- The live and replay decision logs show every `(tick, player)` action from a multi-entry state, while AEC logs retain one action row per completed step.
- Replay highlighting selects the complete current tick group, and a tick's messages appear once after that group.
- Workflow timing aggregation, replay seek and playback, live socket pacing, and a renderer mount accept multi-entry states without a parallel-specific transport or renderer branch.
- The specs state that synchronous model calls are supported but can slip simultaneous ticks, and do not describe background or cross-tick execution as a platform feature.
- `uv run python scripts/ci.py python`, `generated-code-fresh`, `docs`, and `frontend-e2e` pass.
