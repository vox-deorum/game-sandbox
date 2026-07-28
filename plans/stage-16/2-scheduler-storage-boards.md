# Stage 16.2: Scheduler, storage, and boards

Status: not started.

Part of [Stage 16](../stage-16-pinned-seats.md), build-order step 2.

## Outcome

A season match config can pin a seat to a named builtin. The scheduler holds that seat fixed while submissions rotate through the rest, the workflow runner records which result rows came from pinned seats, and the automated board and rating candidacy ignore them. A Hearts season with one seat pinned to `naive` runs headless end to end and ranks only the unpinned seats.

## Seat spec and expansion

`SEAT_SPECS` in `schema/ts/src/schedule.ts` and the zod schema in `backend/src/storage/season-config.ts` gain a pinned variant naming a declared builtin. Season config validation resolves the environment's metadata to check the name, and requires the pinned spec on any seat whose resolved layout carries a `fixed` annotation.

In `backend/src/scheduler/build-schedule.ts`, K counts only `submission` specs, `resolveSeats` maps a pinned spec to its builtin agent reference in every seating, and the appended baseline seating keeps pinned refs while filling submission seats with `naive`. `projectSchedule` in `schema/ts/src/schedule.ts` applies the same arithmetic so the preview and the schedule never disagree.

## Storage

The `builtin-naive` agent kind unifies to `builtin` with a name column, `naive` everywhere today. `AgentRef`, `AgentColumns`, `agentKey`, and `isAgentRef` in `backend/src/storage/schema.ts`, `backend/src/storage/kysely/shared.ts`, and `backend/src/workflow/workflow-runner.ts` follow. `game_results` gains a boolean pinned-seat flag, set at insert from the frozen match config's seat spec. The flat pre-release schema changes in place.

The workflow runner resolves a pinned builtin through the same image and session-config path the baseline uses today, since only `naive` is staged this stage.

## Boards and ratings

`getAutomatedBoard` in `backend/src/storage/kysely/boards.ts` filters flagged rows with one predicate; the naive baseline's rotating row is unaffected because its rows come from submission seats. Rating candidate derivation excludes agents occupying pinned seats, and builtins other than `naive` are never candidates.

## Specification

[Leaderboard](../../docs/specs/leaderboard.md) gains pinned seats in match design, the expansion arithmetic over unpinned seats, the board exclusion rule, and the rating candidacy rule.

## Tests

- Scheduler: pinned seats excluded from K, refs preserved across seatings and in the baseline game, and the existing `projectSchedule` versus `buildSchedule` lockstep test extended over the new spec.
- Storage and boards: flagged rows written and filtered, baseline row still ranked, rating candidates exclude pinned seats.
- Season config: unknown builtin name and a metadata-fixed seat left unpinned both rejected.
