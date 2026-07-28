# Stage 17.3: The simultaneous tick loop

Status: not started.

Part of [Stage 17](../stage-17-simultaneous-stepping.md), build-order step 3.

## Outcome

The harness runs a declared parallel environment through live, local, and headless sessions. Every active player decides from one pre-step snapshot, the environment applies one action mapping, and the harness streams and records one multi-entry state.

Sequential decision collection retains every player's compute opportunity. A slow player defaults its own action and makes the tick slip, but never causes a later player to be skipped.

## Episode dispatch

Add `Episode.step_tick()` beside `step_once()`. A small `Episode.advance()` dispatches from the required `entry.meta.stepping` value, so `run_episode()` and the live runner share one selection point.

The two paths keep their PettingZoo-specific outer shape:

- `step_once()` consumes one AEC agent cycle and required dead steps.
- `step_tick()` consumes one parallel action mapping and result tuple.

Factor only mode-neutral participant work into shared helpers: timed actions, legal-default handling, chat validation and delivery, learning, score and budget accounting, state entry construction, failure attribution, and lifecycle cleanup. The AEC path also uses the state-entry helper to add actionless reward-and-score deltas for non-acting players. Do not adapt a `ParallelEnv` into an AEC wrapper or convert the AEC environments into parallel form.

`Episode.opening_state()` checks the declared mode before reading AEC-only fields. A simultaneous live session emits an unrecorded opening presentation state immediately after reset, containing `agents={}`, the reset overlay, and the designated human's reset `chat_options` when available. The browser can render legal controls, latch input, and compose chat before tick 0. Existing unpaced AEC opening presentation remains unchanged, and existing paced sequential environments keep skipping the opening frame.

## One parallel tick

`step_tick()` uses the active players listed before the environment step, in canonical player order:

1. Snapshot the active player IDs, each observation, and each info mapping from the reset result or previous parallel step result.
2. Consume the external player's latched input at the cadence boundary. Use its legal default when absent or invalid.
3. Call every agent player's `act()` against its saved observation. Time and charge each call independently. Replace an over-limit returned action with that player's legal default. Treat an illegal agent action or raised exception as an attributable failure, matching AEC behavior.
4. Atomically drain and validate the human message queue, then run every active agent's optional `chat()` hook against its pending inbox and the unchanged pre-step environment. Hold all accepted messages for one batch.
5. Call `env.step(actions)` once with exactly the pre-step active players.
6. Validate that all five returned mappings exactly cover the pre-step active set and that post-step `env.agents` is the canonical nonterminal subsequence. A mismatch raises `EnvironmentContractError` before recording a malformed transition.
7. Credit every returned reward to its player, then call each agent that acted and implements `learn()` with its saved observation, applied action, returned reward, and individual termination-or-truncation flag.
8. Build one `StepState` containing every player that acted, the accepted message batch in deterministic human-then-canonical-agent order, and the post-step overlay and human chat policy.
9. Write and stream that state, deliver its messages, purge newly inactive inboxes, increment the tick once, and apply the fixed budget, natural-ending, then tick-cap precedence.

The `agents` entries retain canonical player order in Python before JSON serialization. Each entry contains that player's applied action, immediate reward, cumulative score, and its own optional decision, chat, and learning durations.

The state's `started_at` is the cadence boundary. `duration_ms` ends immediately before canonical state construction and serialization, after participant hooks, the joint environment step, learning, and overlay extraction. Recording and relay serialization and I/O are excluded because a state cannot include time measured after its canonical bytes are written. The environment transition remains platform work and is not added to any player's compute budget.

## Per-player execution and failure

The existing action policy remains mode-neutral:

- An agent action whose hook returns over its step limit is charged and replaced with the environment default.
- An illegal agent action or participant exception fails that player and aborts before applying an incomplete joint action mapping.
- Missing or illegal human input is diagnosed and replaced with the default.
- Chat and learning overruns do not replace the action, but remain charged and increment that player's step-timeout count when the complete per-tick participant compute exceeds its limit.

Each agent-controlled player retains a separate episode budget. Budget checks run after the completed joint state is recorded because every action has already affected the environment. If several players cross their episode limit on the same tick, the first in canonical player order becomes `failed_player`; the episode reports one deterministic attributable failure.

Official LLM credential activation must follow the player across the separated action, chat, and learning phases. Before each participant hook, the harness restores that player's base URL and key and retains the current tick marker. A later player's global environment activation must never leak into an earlier player's chat or learning hook.

Synchronous model calls use the Stage 9 timing contract unchanged. Their proxy wait may make the wall-clock tick slip. Background requests and cross-tick helpers are not introduced.

## Individual termination and truncation

Lifecycle follows PettingZoo in both modes:

- An AEC player marked terminated or truncated receives no action, chat, or learning hook on its required dead step. `env.step(None)` advances the environment without a recorded housekeeping state.
- After each real AEC action, the recorded state contains the acting player's ordinary entry first, followed in canonical order by an actionless reward-and-score entry for every other player that received a nonzero reward or became terminated or truncated on that transition. This preserves the current first-entry actor convention and the final scores without inventing an action, timing, or learning call.
- A parallel player present before the joint step receives that step's reward and one terminal learning call when its returned termination or truncation flag is true.
- Once a player is absent from `env.agents`, it receives no later observations, actions, chat hooks, learning hooks, or state entries.
- Messaging policy and default recipients exclude inactive players, and pending inbox contents for a newly inactive player are discarded.
- An explicit stop prevents another step but does not interrupt participant work already executing. An attributable participant failure aborts before applying an incomplete joint action mapping.

Player bindings and cumulative `_PlayerState` remain until result construction. The result therefore includes every resolved player even after individual inactivity.

After each completed state is recorded and its tick is counted, resolve the outcome in this order:

1. If any player crossed its episode budget, report that failure. Canonical player order selects `failed_player` when several cross together.
2. Otherwise, if `env.agents` is empty, report the natural result. Track whether any player naturally truncated during the episode and report `truncated` if that flag was ever set, or `terminated` otherwise.
3. Otherwise, if the tick cap has been reached, report `truncated`.

Natural completion therefore wins when it lands on the same recorded step as the tick cap. Environment contract errors and participant failures still abort at the point where they are detected rather than entering this completed-step precedence.

For AEC, snapshot rewards, updated cumulative scores, terminations, and truncations immediately after each real action. Build the acting and reward-only state entries from that snapshot before later required dead steps can clear the environment mappings. Dead-step order never overwrites the accumulated natural-ending reason.

Add an AEC regression fixture that terminates one player while another continues, alongside the parallel fixture's early termination and later truncation. The AEC fixture pins its reward-only terminal entry and absence of a synthetic learning call. The parallel fixture pins one terminal learning call for the player that acted. Both pin final reward credit, no later hooks, bounded chat cleanup, and complete final results.

## Live cadence and headless execution

The existing sequential live scheduler stays byte-identical. Its paced AEC behavior continues to advance target instants from the preceding target.

The simultaneous live branch:

1. Emits the unrecorded opening presentation state, then sets the first target to `clock.now_ms() + pace_interval_ms`. Reset, overlay extraction, serialization, and emission cannot shorten the human's tick-0 input window.
2. Calls `episode.advance()`.
3. After completion, sets the next target to `clock.now_ms() + pace_interval_ms`.
4. Waits cooperatively with the existing pause and stop slices.

It never advances several targets to catch up. Pause freezes the cadence and in-harness timing through the existing pausable clock. Stop prevents another tick but does not interrupt a participant hook already executing.

`run_episode()` calls `advance()` back to back with no cadence, matching existing headless behavior. The workflow runner needs no stepping-specific launch command. The local browser bridge already launches the production live runner and therefore inherits the same dispatch.

`build_players()` continues to create a nonblocking latched external source whenever a pace interval is present. Stage 17.2 ensures every simultaneous environment has one. The tick path consumes the latch once at the boundary before agent collection, so later network input waits for the next tick.

## Recording and shared consumers

The state schema and JSONL envelope do not change. One parallel state line simply contains several `agents` entries.

Update shared consumers that currently assume the first or final entry:

- `frontend/src/pages/SessionPage.vue`, `frontend/src/pages/ReplayPage.vue`, and `frontend/src/composables/useLiveFramePresentation.ts` flatten every action-bearing state entry for the decision log.
- `DecisionLog` keys rows by `(tick, player)` and displays canonical player order within a tick. LLM call lookup continues to use that same pair.
- `GameThread` groups decision rows by state tick, highlights by tick rather than flattened row index, and appends that state's messages once after the complete decision group.
- `frontend/src/local/LocalPlayPage.vue` uses the same multi-entry conversion rather than pushing one `toDecision()` result.
- Extract a shared player-score reduction that scans states in order and retains the latest score for each player. `frontend/src/replay/summary.ts`, directly opened ended sessions, and replay standings consume that map.
- Preserve the raw complete result-envelope score map in live and local socket state. `GameOverCard` and `buildStandings` accept the complete player score map in addition to the final state. Overlay leaderboard and display arrays retain their current precedence; the complete map replaces the incomplete final-state fallback and supplies headerless player rows when no complete overlay array exists. Accumulated live state scores cover reconnect until the result envelope arrives.

Reward-only AEC entries are ordinary state deltas under the existing schema because `action` and `timing` are optional. Workflow aggregation already ignores them when counting acted ticks because they carry no timing.

Verify consumers that are already state-level or player-keyed:

- `backend/src/workflow/aggregate.ts` counts timing-bearing entries for one named player across all states.
- replay transport and seek move one state per recorded tick;
- `useSessionSocket` paces one state at a time;
- renderers receive the complete state and may inspect any or every agent entry;
- the backend relay and audience filter preserve the one canonical state line, apart from existing targeted-message filtering.

The parallel fixture recording supplies the regression data. No parallel-only transport envelope, recording header field, or renderer method is added.

## Specifications and contributor documentation

[Interaction](../../docs/specs/interaction.md) gains:

- separate AEC-step and parallel-tick loops;
- the required pre-step observation and input snapshot;
- a timing table whose simultaneous cadence is a minimum interval rather than a shared compute deadline;
- one state containing all players that acted;
- completion-based slip with no catch-up;
- mode-neutral individual inactivity.

[Execution](../../docs/specs/execution.md) states that decisions within a parallel tick run sequentially in one container. It does not promise concurrent CPU and explains that all observations are snapshotted before participant work.

[Recording](../../docs/specs/recording.md) defines a state line as one AEC action, including any non-acting reward-and-lifecycle deltas caused by it, or one parallel tick. A player's final score is the latest cumulative score recorded for that player.

Update harness package and contributor runtime documentation that currently describes `step_once()` as the sole episode path.

## Tests

Fake-clock and fixture harness tests cover:

- every active player observing the same pre-step version;
- exact reset and step mapping keys, monotonic active membership, and runtime `EnvironmentContractError` on every contract violation;
- canonical sequential action collection and one joint environment step;
- an unrecorded simultaneous opening frame carrying reset controls and chat policy, followed by one full cadence interval before tick 0 input is consumed;
- a latched human action consumed before agent hooks and later input retained for the next tick;
- one recorded state with every applied action, reward, score, and per-player timing;
- one tick increment per joint step;
- a late agent defaulting only itself while every later player still acts;
- an illegal agent action failing before an incomplete joint step;
- chat hooks seeing no messages admitted on their current boundary and recipients first seeing tick T messages on tick T+1;
- individual parallel termination and truncation;
- individual AEC termination while another player continues, including the non-acting player's reward-only terminal entry and no synthetic learning call;
- mixed natural termination and truncation producing `truncated` regardless of AEC dead-step order;
- natural completion winning when the same AEC or parallel step reaches the tick cap, plus cap truncation while players remain active;
- canonical attribution when several episode budgets cross together;
- first-tick wait, completion-based slip, pause, stop, and no catch-up burst;
- an unpaced headless rollout with the same states apart from wall-clock fields.

Consumer tests cover:

- one decision-log row for every action-bearing `(tick, player)` entry in live and replay views, with no row for an AEC reward-only delta;
- grouped replay highlighting and one copy of each tick's messages after all decisions for that tick;
- latest-seen replay scores for players absent from the final state;
- complete live, local, directly opened ended-session, and replay game-over standings when a player is absent from the final state and no environment score array is available;
- correct acted-tick counts and compute means from a multi-entry workflow recording;
- replay seek and playback advancing one multi-entry frame at a time;
- socket pacing and one renderer mount receiving multi-entry states unchanged.

The fixture runs through direct `Episode`, `run_episode`, the injected live runner, and the local relay without becoming a registered environment. An existing AEC Playwright journey pins one decision row per real action and complete game-over standings after the adapter change. Browser end-to-end play for the parallel path waits for the first public simultaneous environment; Stage 17.1's Spades journey remains the browser gate for the messaging UI changed in this stage.

## Done when

- Every live, local, and headless caller dispatches from the required stepping declaration.
- One parallel tick applies every active player's action to one pre-step world and creates one state.
- A slow player slips cadence but cannot skip a later player or cause a catch-up burst.
- AEC and parallel players can become inactive individually without losing final scores or receiving later hooks.
- Multi-entry decisions and final scores remain visible through recording, replay, workflow aggregation, and the shared decision log.
- Synchronous LLM calls retain their existing accounting and may slip ticks; Stage 17 adds no background execution path.
