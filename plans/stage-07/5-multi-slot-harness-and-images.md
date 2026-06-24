# Stage 7.5: Multi-Slot Harness and Multi-Submission Images

Status: not started.

Part of [Stage 7](../stage-07-multi-agent.md). This is build-order step 5. It makes the real multi-slot execution path work end to end: the harness steps every slot of a turn-based session, and a session image overlays every participating submission in isolation. It is Docker-gated, in the same lane as the Stage 5 build and load tests and the Stage 6.4 runner, so the default test run stays Docker-free. It depends on the environment from step 1 and the start contract from step 4.

## Why this is its own seam

The single-agent stages never exercised more than one slot, one timing clock, or more than one submission in a container. This step is where the harness multi-slot path becomes real and where the isolation between checkouts is proven. Separating it from the start contract (step 4) keeps the pure validation and attribution logic testable without Docker, and isolates the container-level work into the gated lane.

## Multi-slot stepping

Exercise the harness's multi-slot path for real on Hearts:

- Sequential stepping across the non-human slots on the unpaced turn-based loop from [interaction.md](../../docs/specs/interaction.md), advancing as each slot acts.
- Per-slot timing and timeouts, so each seat has its own move clock.
- A human-controlled slot among agents.
- The human-slot timeout auto-plays the environment's `default_action` (the lowest legal card from step 1) when that slot stalls past the configured window. The timeout is defined and exposed before this stage; Stage 7 only needs to exercise it in an unpaced product environment. The move clock display lives in step 7.

Fix what the single-agent stages never had to get right in this multi-slot path.

## Multi-submission session images

Extend session image building per [execution.md](../../docs/specs/execution.md). A multi-agent session overlays every participating submission's code, each in its own per-slot directory, onto the base image for the season's pinned dependency-set version. The driver already exposes per-slot overlay paths through `submissionSlotPath(slotId)` and the `submission-overlay` image spec; this step builds one overlay per submitted slot and composes them into the session image.

Dependency conflicts cannot arise because every participant runs the same single dependency set. What this step must get right is **code isolation between checkouts**:

- Import paths do not leak between slots.
- Module name collisions between repos that both ship an `agent` module are isolated, so each slot imports its own code.
- The harness loads each slot's class from its own directory, reusing `load_agent` and `load_manifest` in `harness/src/game_sandbox_harness/manifest.py`.
- The same submission may fill more than one slot, for self-play or for the all-`builtin-naive` baseline. The build overlays it into each per-slot directory independently and the harness loads a separate instance per seat, so two seats backed by the same repo are as isolated as two different repos, with no shared module state between the instances.

## Tests

Docker-gated, in the existing gated lane:

- A multi-slot Hearts session steps each seat in turn through the real driver, with per-slot timing.
- Two submissions that both ship an `agent` module run in the same session without import collision, each executing its own code.
- The same submission seated in two slots runs as two independent instances in one session, with no shared state, exercising the same-agent-in-multiple-slots path.
- A human-controlled slot that stalls past the window auto-plays a legal move via the environment `default_action`.

## Done when

A Hearts session runs end to end through the real execution driver with submitted agents in multiple slots and, optionally, a human slot. The harness steps every slot sequentially on the unpaced turn-based loop, applies per-slot timeouts, and auto-plays a legal move when a human slot stalls. The session image overlays each submission in its own per-slot directory with no import-path or `agent`-module collision between checkouts. The Docker-gated tests above pass in their lane and the default test run stays Docker-free.
