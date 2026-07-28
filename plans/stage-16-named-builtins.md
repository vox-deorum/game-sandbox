# Stage 16: Named builtins and a restricted seat

Status: not started.

## Goal

An environment may ship several named builtin agents and designate one seat in a declared seat plan as restricted. That seat accepts a human when it is human-capable, or the one builtin named by the seat declaration. It never accepts a submission or another builtin.

Each matchup already chooses the controller for every seat, so a season places the designated builtin in the restricted seat and uses `submission` or a named builtin everywhere else. The rest of the work makes the restriction authoritative in live sessions and clear in the Play, Watch, Rate, and admin interfaces.

This is one platform half of the future role-playing environment, whose player-character seat is a restricted seat driven by a scripted builtin whenever no human is playing.

## Scope

- Environment metadata declares one or more named builtin agents. `naive` is the required first entry and stays the scheduler's baseline filler.
- Builtin agents are staged by environment and name. Agent references, launch bindings, recordings, storage, boards, ratings, and public wires carry the name.
- Declared seat plans hold object-shaped seat declarations. At most one seat in a plan may name `restricted_builtin`, its sole non-human controller, and at least one other seat stays unrestricted.
- Match rows carry one entry per resolved seat, valued `submission` or `builtin:<name>`.
- Environment-aware season validation requires the restricted seat's match entry to name its designated builtin, and runs both when a config is saved and before it is frozen into a run.
- Live-session validation accepts only Human or the designated builtin on the restricted seat, and requires every builtin assignment anywhere to name a declared agent.
- Play and Rate default a human-capable restricted seat to Human. Watch always uses its builtin.
- The season editor locks the restricted matchup seat to its builtin. The live seat dialog exposes only legal choices.
- Each seat heading in the seat dialog carries its player count directly underneath the seat name.
- Spec deltas land with the steps that build them: [Environments](../docs/specs/environment.md), [Execution](../docs/specs/execution.md), [Recording](../docs/specs/recording.md), [Leaderboard](../docs/specs/leaderboard.md), [Interaction](../docs/specs/interaction.md), [Frontend](../docs/specs/frontend.md).

Stage 16 targets a fresh, pre-release checkout. Metadata, recording, API, and flat database shapes change in place, with no migration or compatibility path.

Out of scope: more than one restricted seat in a resolved plan; restricting a seat to a submission; choosing the restricted builtin per season rather than per environment; and the role-playing environment itself.

## Related specifications

- [Environments](../docs/specs/environment.md): named builtins, seat declarations, and the restricted-seat rule.
- [Execution](../docs/specs/execution.md): builtin staging by environment and name, and named launch bindings.
- [Recording](../docs/specs/recording.md): self-contained builtin attribution.
- [Leaderboard](../docs/specs/leaderboard.md): named builtin identity in matchups, boards, and ratings.
- [Interaction](../docs/specs/interaction.md): authoritative Human-or-builtin assignment.
- [Frontend](../docs/specs/frontend.md): Play, Watch, Rate, the admin editor, and the seat heading.

## Depends on

- [Stage 1](stage-01-contracts.md): the recording format and generated types.
- [Stage 2](stage-02-harness-and-first-environment.md): environment metadata and builtin loading.
- [Stage 6](stage-06-leaderboards.md): season matchup configuration, schedule expansion, boards, and ratings.
- [Stage 7](stage-07-multi-agent.md): multi-seat live sessions.
- [Stage 14](stage-14-environment-variants.md): parameter-aware season editing.
- [Stage 15](stage-15-wide-seats.md): resolved seats and human companions.

## Design decisions

### The matchup describes every seat

Each match row carries one controller spec per resolved seat. Several builtins generalize the existing compact string:

```json
{
  "seats": [
    "builtin:scripted_hero",
    "submission",
    "submission",
    "builtin:naive"
  ],
  "seeds": [7],
  "games": 2
}
```

If `seat_0` is restricted to `scripted_hero`, its entry is required to be `builtin:scripted_hero`. The scheduler counts the two `submission` entries as K, expands submissions into those positions, keeps both builtin entries where they are, and appends its ordinary baseline game. The baseline fills only `submission` entries with `builtin:naive`, so `scripted_hero` holds `seat_0` there too.

`projectSchedule` in `schema/ts/src/schedule.ts` already derives K by counting entries equal to `'submission'`, so its P(N,K) and C(N,K) arithmetic is untouched and only its `SeatSpec` type widens. `resolveSeats` in `backend/src/scheduler/build-schedule.ts` is the one function that must change: its else branch treats any non-baseline spec as a submission slot and advances the seating cursor, which would shift every later seat once a named builtin appears.

### One validator owns the environment-aware config checks

The season-config codec validates the compact string's shape. The environment-aware checks resolve the selected seat plan, check each builtin name against metadata, and require the restricted seat's declared value. They belong with the seat-count check, which today lives as a private `validateSeatCounts` in `backend/src/admin/routes.ts` and is called only from the config `PUT`. Stage 16 lifts that helper into one exported validator and calls it from both the config `PUT` and the run trigger, which currently resolves the layout only to obtain `layout.planKey` for `buildSchedule`.

### Builtin identity is explicit and self-contained

The canonical reference is:

```json
{ "kind": "builtin", "name": "scripted_hero" }
```

The name reaches schedule JSON, storage keys, launch bindings, board and rating wires, frontend keys, and recording attribution. Agent-keyed tables gain a nullable `agent_builtin_name` beside the existing `agent_submission_id` and `agent_user_id`, and grouping, lookups, and partial unique indexes key on kind plus name.

A recording distinguishes human, submitted-agent, and builtin-agent players. A submitted agent requires `submission_id` and forbids `builtin_name`. A builtin requires `builtin_name`, forbids `submission_id`, and carries its launch-time display `label`, so a replay identifies and renders the agent from the recording alone:

```json
{
  "kind": "agent",
  "builtin_name": "scripted_hero",
  "label": "Scripted hero"
}
```

Every named builtin participates in boards and ratings on the terms the single baseline has today: it ranks on the automated board keyed by its name, and it is rateable only in a session that also contains a submitted agent. `naive` still fills the appended baseline game, so every board keeps its reference row. The restricted seat carries no result flag and no rating exception, so a builtin that only ever plays a restricted seat ranks on the same mean-score board as everything else. [Leaderboard](../docs/specs/leaderboard.md) generalizes from "the built-in baseline" to any named builtin to match.

### Seat declarations supply the live restriction

Environment metadata declares the builtins and the restriction. The future role-playing environment is the motivating shape:

```python
EnvironmentMeta(
    builtin_agents=(
        BuiltinAgent(name="naive", label="Naive agent"),
        BuiltinAgent(name="scripted_hero", label="Scripted hero"),
    ),
    layout=SeatPlans(
        plans=(
            SeatPlan(
                key="adventure",
                title="Adventure",
                seats=(
                    SeatDeclaration(players=(0,), restricted_builtin="scripted_hero"),
                    SeatDeclaration(players=tuple(range(1, 11))),
                    SeatDeclaration(players=tuple(range(11, 21))),
                ),
            ),
        ),
    ),
)
```

At most one seat per declared plan sets `restricted_builtin`, the name must be declared by the same environment, and at least one other seat stays unrestricted, which keeps the environment useful for submission evaluation and keeps a Rate action well defined. Player-bounds layouts synthesize interchangeable seats and cannot carry a restriction. `resolve_layout` puts the nullable name on `ResolvedSeat`, so config validation, session validation, and the frontend all read one resolved shape.

The restriction lives only in metadata. A live start already sends complete parameters, and the backend resolves the current layout from installed metadata before accepting any assignment.

### The restricted seat is Human or its designated builtin

At the authoritative session boundary a restricted seat accepts `{ kind: "human" }` when at least one of its players is human-capable, and `{ kind: "builtin", name }` when the name equals `restricted_builtin`. Everything else is refused. On a wide restricted seat held by a human, the backend fills the remaining players with the designated builtin instead of taking a companion from the client.

Watch always assigns the designated builtin. Play defaults Human on a capable restricted seat and returns it to the builtin when the user sits elsewhere. Rate defaults it to Human, locks the intended agent into every unrestricted seat, and leaves the restricted seat's Human-or-builtin switch as the one enabled choice.

Builtin names are checked everywhere, not only on restricted seats. Any builtin assignment, including a companion the client picks for an ordinary wide Human seat, must name an agent the environment declares.

### Seat headings keep their detail together

The seat dialog renders the seat name and its player count as a two-line heading in the left grid column:

```text
Seat 1        [Agent selector]
2 players
```

`2 players` sits directly below `Seat 1` rather than wrapping under the selector, in Play, Watch, and Rate alike, so the grid does not shift between modes. Companion controls stay below the assignment control in the right column.

## Steps

### 16.1 [Named builtins and seat declarations](stage-16/1-named-builtins-and-seat-declarations.md)

Named builtins in metadata, staging by environment and name, object-shaped seat declarations with `restricted_builtin`, and explicit builtin identity through launch, recording, storage, boards, ratings, and every generated artifact.

### 16.2 [Matchup and session enforcement](stage-16/2-matchup-and-session-enforcement.md)

Named matchup strings, the shared environment-aware config validator on both call sites, the scheduler's one vocabulary change, and authoritative live-assignment checks.

### 16.3 [Play, Rate, Watch, and admin interface](stage-16/3-interface.md)

Named builtin labels and choices, restricted-seat behavior in every session flow, the locked admin matchup cell, the two-line seat heading, and the unit and browser tests that assert on them.

## Exit criteria

- Spades declares `naive` and a second builtin. Both load from `/opt/agents/builtin/spades/<name>` and launch with distinct names and labels.
- Agent references carrying two different builtin names round-trip through schedule JSON, result storage, placements, ratings, API responses, and frontend keys without merging.
- Two builtins hold separate placement rows and separate ratings within one season.
- A recording containing the second builtin renders its snapshotted label with no environment or season lookup. Agent attribution carrying both `builtin_name` and `submission_id`, or neither, is rejected.
- A four-seat match such as `["builtin:scripted_hero", "submission", "submission", "builtin:naive"]` keeps four entries, and projection and expansion both count K as 2, preserve both builtin positions, and agree on all totals.
- A match naming an undeclared builtin, or putting the wrong builtin in the restricted seat, is rejected both when the config is saved and when a run is triggered.
- A direct live request assigning a submission or `naive` to a seat restricted to another builtin fails before session insertion or container work.
- A live request naming an undeclared builtin on an unrestricted seat, or as an ordinary wide-seat companion, fails the same way.
- Metadata rejects a plan with two restricted seats, a plan whose only seat is restricted, a restriction naming an undeclared builtin, and a restriction on a player-bounds layout.
- Play and Rate default a capable restricted seat to Human, Watch uses its builtin, and a wide restricted Human seat receives its companions from the backend with no client choice.
- Rate keeps the intended agent in every unrestricted seat and leaves only the restricted seat's Human-or-builtin control enabled.
- The season editor offers every declared builtin, locks the restricted seat's cell to its designated builtin, and keeps full-width match rows with unchanged projected totals.
- Every seat heading shows `Seat X` with `X player` or `X players` directly below it in Play, Watch, and Rate, including narrow viewports.
- `uv run python scripts/ci.py python`, `generated-code-fresh`, and `docs` pass. `uv run python scripts/ci.py frontend-e2e` passes after the interface changes.
