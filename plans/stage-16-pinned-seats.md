# Stage 16: Pinned seats

Status: not started.

## Goal

A seat can be fixed to a designated builtin agent. Submissions never occupy a pinned seat, the scheduler rotates submissions only through the unpinned seats, and a pinned seat's results never rank on a board. In live play a pinned seat belongs to the human when the person takes it and to the designated builtin otherwise, and the Rate action's locked configuration follows the same rule. This is one platform half of the future role-playing environment, whose player-character seat is a pinned seat driven by a scripted builtin whenever no human is playing.

## Scope

- Builtin agents get names. Environment metadata declares an ordered tuple of builtin agents, each with a snake_case name and a display label. `naive` is the reserved first entry every environment has. This stage keeps one staged builtin per environment, so `naive` is the only declared name anywhere, and the image staging layout is unchanged. A two-level staged layout arrives with the first environment that declares a second builtin.
- An optional per-seat fixed-controller annotation on seat plans, naming a declared builtin. Only a seat-plans layout can fix a seat, since player bounds synthesize interchangeable solo seats.
- A third seat spec in the season match config that pins a seat to a named builtin, with the scheduler and the schedule projection treating pinned seats as fixed.
- Storage and boards: builtin agent references carry a name, `game_results` rows born from pinned seats carry an exclusion flag, the automated board filters them, and rating candidacy excludes pinned seats.
- The session path: seat validation, the Rate, watch, and play flows, launch-config bindings, the seat assignment dialog, the season config editor, and attribution labels.
- Spec deltas land with the steps that build them: [Environments](../docs/specs/environment.md), [Leaderboard](../docs/specs/leaderboard.md), [Frontend](../docs/specs/frontend.md).

Stage 16 targets a fresh, pre-release checkout, exactly as Stages 14 and 15 did. The flat initial database schema and the season config schema change in place, with no data migration or backward-compatibility path.

Out of scope: the role-playing environment and its scripted player-character builtin; a second staged builtin and the two-level staging layout; pinning a seat to a submission; any human-feedback treatment of pinned agents beyond exclusion from candidacy.

## Related specifications

- [Environments](../docs/specs/environment.md): named builtin agents and the fixed-controller seat annotation.
- [Leaderboard](../docs/specs/leaderboard.md): match design over pinned seats, expansion arithmetic, and board exclusion.
- [Frontend](../docs/specs/frontend.md): the Rate action's locked configuration, the seat dialog and season editor behavior, and attribution labels.
- [Execution](../docs/specs/execution.md): builtin staging, naming only in this stage.

## Depends on

- [Stage 2](stage-02-harness-and-first-environment.md): environment metadata and the entry-point registry.
- [Stage 6](stage-06-leaderboards.md): seasons, season config, the scheduler, workflow runs, and boards.
- [Stage 7](stage-07-multi-agent.md): multi-seat sessions and the slots start API.
- [Stage 14](stage-14-environment-variants.md): typed parameters and the season config editor.
- [Stage 15](stage-15-wide-seats.md): players, seats, layouts, and per-seat results.

## Design decisions

### A pinned seat is human-or-builtin, never a submission

The rule holds in every session kind. Automated runs always give a pinned seat its designated builtin. A watch session gives it the builtin. A play session gives it the human when the person takes it, and the builtin otherwise. The Rate action locks the intended agent into every unpinned seat; the pinned seat goes to the viewer when they choose to play and to the builtin otherwise. `validateSeatShape` in `backend/src/session/orchestrator.ts` enforces the rule at the assignment boundary, the same place `human_players` is enforced today.

When a human takes a wide pinned seat, the companion for its remaining players is the designated builtin rather than a free choice, so the seat's cast never varies by who is watching.

### Builtin agents have names, and `naive` is reserved

Metadata declares the builtins; the season config and the scheduler reference them by name; an unknown name is rejected when the season config is validated. The storage vocabulary unifies to one `builtin` agent kind carrying the name, with `naive` the value everywhere today, and the aggregation key becomes kind plus name. The frontend renders the declared display label instead of a hardcoded baseline string. This is a pre-release rename of the `builtin-naive` agent kind in place; the `builtin-naive` seat spec literal in match configs keeps its meaning as the rotating baseline filler and is unrelated to pinning.

### Pinned seats are invisible to expansion arithmetic

The seating width K counts only `submission` seats. A pinned seat keeps its fixed agent reference in every enumerated seating and in the appended all-naive baseline game. `buildSchedule` in `backend/src/scheduler/build-schedule.ts` and `projectSchedule` in `schema/ts/src/schedule.ts` change together, preserving their lockstep invariant and today's P(N,K) and C(N,K) figures over the unpinned seats.

### Exclusion from ranking is seat-based and decided at insert

Every seat still writes a `game_results` row, so run detail, replay standings, compute audit, and failure attribution stay complete. A row born from a pinned seat carries a boolean flag derived from the frozen match config when the workflow runner inserts it, and `getAutomatedBoard` filters flagged rows with one predicate. Exclusion cannot key on the agent kind, because the naive builtin legitimately ranks as the baseline row when it fills submission seats.

Rating candidacy excludes any agent occupying a pinned seat. The baseline's existing mixed-session rating rule is otherwise unchanged, and builtins other than `naive` are never rating candidates.

### Metadata seeds the season config, the season config is authoritative

A metadata-fixed seat forces the pinned spec in the editor and locks it. An operator may also pin an unannotated seat to any declared builtin, which is how this stage tests the machinery before a second builtin exists. The frozen match config is what the scheduler, the workflow runner, and the insert-time flag read; metadata is never consulted after season creation. This mirrors the `human_players` pattern: capability in metadata, assignment in config.

## Steps

### 16.1 [Builtin names and layout annotation](stage-16/1-builtin-names-and-layout.md)

The declared-builtins tuple and the per-seat fixed-controller annotation in the Python metadata, the JSON serialization, the TypeScript mirror and shape guards, the regenerated registry JSON, and the load-time validation. Every environment declares exactly `naive`, so nothing changes behaviorally.

### 16.2 [Scheduler, storage, and boards](stage-16/2-scheduler-storage-boards.md)

The pinned seat spec through the season config schema, `buildSchedule`, and `projectSchedule`, the unified `builtin` agent kind with its name, the insert-time exclusion flag, the board filter, and rating candidacy.

### 16.3 [Sessions and interface](stage-16/3-sessions-and-interface.md)

Seat validation, the Rate, watch, and play flows, launch-config bindings, the seat assignment dialog, the season config editor, attribution labels, and the UI tests and journeys that assert on them.

## Exit criteria

- A season config that pins a Hearts seat to `naive` runs end to end: the schedule preview counts seatings over unpinned seats only, every game's pinned seat holds the naive builtin, and the appended baseline game is unchanged.
- Rows born from pinned seats carry the exclusion flag and never appear on the automated board, while the naive baseline's ordinary rotating row still ranks.
- A season config naming an unknown builtin, or flipping a metadata-fixed seat to `submission`, is rejected at validation with a message naming the seat.
- A live session with a pinned seat starts with the builtin driving it; the person can take the seat when it is human-capable; the Rate action locks the intended agent into unpinned seats only. Assigning a submission to a pinned seat fails with a 400 naming the seat.
- Agents occupying pinned seats are absent from rating candidates.
- `uv run python scripts/ci.py python`, `generated-code-fresh`, and `docs` pass, and `uv run python scripts/ci.py frontend-e2e` passes after the dialog and editor changes.
