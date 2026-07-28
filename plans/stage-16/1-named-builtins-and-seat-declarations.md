# Stage 16.1: Named builtins and seat declarations

Status: not started.

Part of [Stage 16](../stage-16-named-builtins.md), build-order step 1.

## Outcome

An environment declares, stages, launches, stores, and displays more than one builtin agent, and a declared seat plan names one seat's designated builtin. Builtin identity is a stable name rather than a hardcoded kind or a display label. Metadata, its serialization, and every generated artifact change once, here.

## Named builtins in metadata

`EnvironmentMeta` in `harness/src/game_sandbox_harness/environment.py` gains an ordered `builtin_agents` tuple of frozen `BuiltinAgent` entries, each with a snake_case `name` and a non-empty `label`. Names are unique within an environment, and `naive` is the first entry everywhere, which keeps it available as the scheduler's baseline filler.

## Seat declarations

`SeatPlan.seats` moves from a tuple of player-index tuples to a tuple of `SeatDeclaration` objects:

```python
SeatPlan(
    key="adventure",
    title="Adventure",
    seats=(
        SeatDeclaration(players=(0,), restricted_builtin="scripted_hero"),
        SeatDeclaration(players=tuple(range(1, 11))),
        SeatDeclaration(players=tuple(range(11, 21))),
    ),
)
```

`SeatDeclaration.players` keeps the current non-empty tuple of player indexes and the existing rule that a plan's seats partition players `0` through `N - 1` exactly once. `restricted_builtin` is optional. Load-time validation requires the name to be declared by the same environment, allows at most one restricted seat per plan, and requires at least one other seat to stay unrestricted. `PlayerBounds` layouts synthesize interchangeable seats and cannot carry a restriction.

`resolve_layout` emits a nullable `ResolvedSeat.restricted_builtin`, so config validation, session validation, and the frontend read the resolved shape rather than re-deriving it from the plan.

The name `SeatDeclaration` keeps the declared seat distinct from `SeatSpec`, the matchup controller string, and from `ResolvedSeat`.

## Staging by environment and name

The session image moves from one flat directory per environment to one directory per environment and builtin:

```text
/opt/agents/builtin/hearts/naive
/opt/agents/builtin/spades/naive
/opt/agents/builtin/spades/cautious
```

The source tree under `backend/images/session-base/deps-v1/builtin/` takes the same shape. In `backend/images/session-base/deps-v1/Dockerfile` the `COPY` into `/opt/agents/builtin` is unchanged, the build-time `load_agent` smoke test moves to the two-level paths, and the build fails when metadata names a builtin with no matching directory. `DEFAULT_BUILTIN_AGENT_BASE` resolution in `harness/src/game_sandbox_harness/live.py` appends the builtin name from the seat binding to the environment id instead of stopping at the environment.

Spades declares a second builtin beside `naive`, so the two-level path, the named launch binding, distinct storage rows, and distinct labels are all exercised by a real environment inside the real image. `cautious` ("Cautious bidder"), a bidder that never bids nil and follows suit low, is the proposed name and behavior; confirm or replace it when work starts. Flappy Bird and Hearts keep `naive` alone.

No shipped environment restricts a seat until the role-playing environment arrives, so restricted-seat coverage comes from metadata fixtures in the Python, TypeScript, backend, and jsdom suites rather than from a production game.

## Identity and storage

`AgentKind` and `AgentRef` in `backend/src/storage/schema.ts` become:

```ts
export type AgentKind = 'submission' | 'builtin'

export type AgentRef =
  | { kind: 'submission'; submission_id: string; user_id: string }
  | { kind: 'builtin'; name: string }
```

`AgentColumns` gains a nullable `agent_builtin_name` beside `agent_submission_id` and `agent_user_id`. A builtin row has `agent_kind = 'builtin'`, a name, and null ids; a submitted-agent row has the reverse. `agentColumns`, `decodeAgent`, and `agentKey` in `backend/src/storage/kysely/shared.ts` carry the name, and one shared parser owns `{ kind: "builtin", name }` validation and key construction so callers do not rebuild the identity.

`game_results`, `automated_placements`, and `ratings` each gain the column in `backend/src/storage/migrations.ts`. The aggregation in `getAutomatedBoard`, the lookups in `listPlacementsByAgent`, and the partial unique indexes key on kind together with the builtin name, so two builtins never overwrite or aggregate into one row.

The same explicit name reaches scheduled games, `SeatBinding` in `backend/src/session/launch-config.ts` and its `driver` value, the builtin resolution in `backend/src/session/orchestrator.ts`, the builtin branch in `backend/src/workflow/workflow-runner.ts`, board and rating wires, frontend agent keys, and display-name enrichment. `builtin-naive` is removed in place from source and generated types.

## Recording

`schema/recording-header.schema.json` splits its `players` entry into three variants: a human, a submitted agent with `submission_id` and no `builtin_name`, and a builtin with `builtin_name` and no `submission_id`. `kind` keeps its `human` and `agent` values, and the two agent variants are a `oneOf` within the agent branch, so an entry carrying both identity fields or neither fails validation. Both agent variants keep the required `label`, so a builtin player renders from the recording alone:

```json
{
  "kind": "agent",
  "builtin_name": "scripted_hero",
  "label": "Scripted hero"
}
```

`PlayerAttribution` in `harness/src/game_sandbox_harness/state.py`, the generated TypeScript types, harness validation, replay attribution, blind masking, and fixtures follow the disjoint variants. This replaces the derivation documented at `backend/src/ratings/routes.ts:11-15`, which reads a builtin as an agent entry that happens to lack a `submission_id`. The backend assembles the name and the label at launch, and no replay consults environment or season metadata to recover either.

## Boards and ratings

Every named builtin participates on the terms the single baseline has today. It ranks on the automated board keyed by kind and name, and the mixed-session rule at `backend/src/ratings/routes.ts:214-216` keeps any builtin rateable only in a session that also contains a submitted agent. The restricted seat adds no exclusion flag, no provenance column, and no rating exception.

## Serialization and generation

- `to_json()` and `_layout_to_json` in `harness/src/game_sandbox_harness/environment.py` emit `builtin_agents` and the object-shaped seats.
- `schema/ts/src/environment.ts` mirrors `BuiltinAgent` and `SeatDeclaration`, extends `isEnvironmentLayout` and its `hasOnlyKeys` allow-lists, validates unique names and non-empty labels, and carries `restricted_builtin` through `resolveLayout` onto `ResolvedSeat`.
- `scripts/_template_gen.py` constructs `BuiltinAgent` and `SeatDeclaration` values rather than passing serialized dictionaries into `EnvironmentMeta`.
- Registry JSON, generated templates, examples, shared layout fixtures, and the Spades and Hearts declarations regenerate from the new shape in one pass.
- `environments/test_conformance.py` keeps the metadata JSON round trip honest over both new shapes.

## Specification

- [Environments](../../docs/specs/environment.md) defines named builtins, the required `naive` baseline, `SeatDeclaration`, and the one-restricted-seat-per-plan rule.
- [Execution](../../docs/specs/execution.md) defines the two-level staged path and the named launch binding.
- [Recording](../../docs/specs/recording.md) defines `builtin_name` plus the snapshotted label and the disjoint agent variants.
- [Leaderboard](../../docs/specs/leaderboard.md) generalizes from "the built-in baseline" to any named builtin on both boards, with `naive` still filling the appended baseline game.

## Tests

- Metadata rejects no builtins, a first entry other than `naive`, duplicate or malformed names, and blank labels.
- Metadata rejects a restriction naming an undeclared builtin, two restricted seats in one plan, a plan whose only seat is restricted, and a restriction on a player-bounds layout. Python and TypeScript assert the same set.
- Resolver fixtures prove restricted and unrestricted seats produce the expected nullable `restricted_builtin` in both languages.
- Image and harness tests load `naive` and Spades' second builtin from distinct paths and reject an unknown name before gameplay.
- Agent references round-trip through schedule JSON, result storage, placements, ratings, API responses, and frontend keys without merging two names.
- Database uniqueness tests store two builtin placements and two builtin ratings within one season.
- Recording tests write, validate, read, mask, and display two builtin identities with no metadata lookup, and reject agent attribution carrying both `builtin_name` and `submission_id` or neither.
- Template composition imports and constructs `BuiltinAgent` and `SeatDeclaration`, registry generation stays fresh, and every current environment still launches its `naive` agent from the two-level path.
