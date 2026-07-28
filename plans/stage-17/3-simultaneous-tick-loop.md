# Stage 17.3: The simultaneous tick loop

Status: not started.

Part of [Stage 17](../stage-17-simultaneous-stepping.md), build-order step 3.

## Outcome

The harness runs simultaneous episodes: every tick, every live agent decides against the same pre-tick world, the actions apply together, and exactly one state is streamed and recorded. Live sessions, headless runs, and local play all take the tick path when the environment declares it, and playback consumes the recordings without change.

## The tick path

`Episode.step_tick()` in `harness/src/game_sandbox_harness/session.py`, beside the untouched `step_once()`:

1. Observe the pre-tick world once for every live player.
2. Sequentially collect one action per live player. Agent players go through the existing per-player timing, step-limit, budget, and LLM-scope machinery, with a late or illegal action replaced by the environment's default and charged to that player. External players read the latch through the existing paced non-blocking branch, latest input or default.
3. Run each agent's chat hook for the tick and admit latched human messages, under the step 1 model.
4. Apply one parallel `env.step(actions)`, credit every player's reward, and run the learning hooks.
5. Record one `StepState` whose `agents` map carries an entry for every player that acted, with per-agent timing, and increment the tick once.
6. Handle per-player terminations: a terminated player receives its final-reward entry, stops being called, and drops out of later maps. The episode ends when the agent set empties, a global truncation fires, or a step cap or episode budget trips, with failure attribution unchanged from Stage 15.

`run_live_loop` in `live.py` dispatches on the stepping mode; the pause, stop, and pace scaffolding is reused as is. On overrun the tick slips: the next tick is one full interval from completion, never a burst. Headless runs step ticks back to back with no pacing, exactly as sequential headless runs do today.

## Consumers verified, not changed

- `backend/src/workflow/aggregate.ts` already sums per-player timing by lookup; a test over a multi-entry recording pins that acted-tick counts and compute means stay correct.
- Replay transport steps one frame per tick by construction; a fixture recording verifies seek and playback.
- jsdom tests feed multi-entry states through `useSessionSocket` pacing and a renderer mount to pin that nothing assumes one acting player.

## Specification

[Interaction](../../docs/specs/interaction.md): the state-is-a-delta sentence becomes mode-conditional, the session loop section gains the tick shape, and the timing table gains a simultaneous row where the cadence is the advance rule and every actor's shared deadline. [Execution](../../docs/specs/execution.md): the sequential-execution rationale is rephrased to cover per-tick gathering. Tick slip is documented as accepted behavior.

## Tests

Fake-clock harness tests: one state per tick with all live entries, single tick increment, slip without burst, per-agent default on a slow agent while honest agents are unaffected, latched input applied at the deadline, next-tick message delivery, termination drop-out, and budget failure attribution. A full fixture episode runs live through the local runner and headless through `run_episode`, and both recordings are one frame per tick.
