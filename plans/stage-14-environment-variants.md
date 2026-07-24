# Stage 14: Environment variants

Status: not started.

## Goal

Environments declare typed, friendly-labeled gameplay parameters (including seat count) in their Python registration. Seasons override the parameter defaults through season config. Players may tweak the values when starting a play or watch session, automated runs always use the season values, and every session records the values it actually ran with. The environment page states plainly which season is open for play and that watching and playing use that season's settings.

## Scope

- Parameter declaration types in the harness metadata and their JSON wire form.
- A reserved, synthesized `seats` parameter derived from `min_slots` and `max_slots`.
- Parameterized environment factories. Flappy Bird declares one real parameter (`pipe_gap`); Hearts and Spades gain the new factory signature but declare nothing.
- A `parameters` block in the season config overrides, admin validation against the declarations, and per-run snapshotting.
- An optional `parameters` object on session start, orchestrator resolution and validation, threading into the container, and persistence in the session row and the recording header.
- Frontend: a dynamic parameter form in the start and watch flows, a new checkbox-group primitive, a season banner on the environment page, and a parameter-overrides card in the season config editor.

Out of scope: any environment actually using a variable seat count (all existing environments stay fixed; scheduler Naive fill and `human_slots` semantics for variable seats are recorded as open questions, not built), parameter pinning that hides tweaking from players, and Unity ML-Agents.

## Related specifications

- [Environments](../docs/specs/environment.md): metadata, determinism, and the new parameter declarations.
- [Leaderboard](../docs/specs/leaderboard.md): per-season configuration and what a season override governs.
- [Execution](../docs/specs/execution.md): the live-runner launch configuration and its new `parameters` field.
- [Interaction](../docs/specs/interaction.md): the play and watch start flows.
- [Recording](../docs/specs/recording.md): the header field that records the values a game ran with.
- [Frontend](../docs/specs/frontend.md): the environment page and shared UI behavior.

## Depends on

- [Stage 2](stage-02-harness-and-first-environment.md): environment metadata and the entry-point registry.
- [Stage 6](stage-06-leaderboards.md): seasons, season config, the admin console, and automated runs.
- [Stage 7](stage-07-multi-agent.md): multi-seat sessions and the slots start API.
- [Stage 13](stage-13-unified-rendering.md): the current harness, live runner, and local play shape.

## Design decisions

### Parameter declarations live in the harness metadata

`harness/src/game_sandbox_harness/environment.py` gains the declaration types beside `EnvironmentMeta`, because the harness loop, the container, and the generated registry JSON all consume them.

- `EnvParameterChoice` is a frozen dataclass with a `value` and a friendly display `label`.
- `EnvParameter` is a frozen dataclass with `name` (snake_case, unique within an environment, `seats` reserved), `title`, `description`, `type` (one of `int`, `float`, `string`, `bool`, `choice`, `multi_choice`), `default`, inclusive `min` and `max` for the numeric types, and a non-empty `choices` tuple for the choice types.
- `__post_init__` performs the structural checks and validates the default against the declaration.
- `validate_value` returns the normalized value or raises a typed error. `int` accepts integers only and rejects booleans (Python treats `bool` as an `int` subclass, so the check is explicit). `float` coerces integers and rejects booleans. `choice` accepts one declared choice value. `multi_choice` accepts a list of unique declared values and normalizes it to declaration order; an empty list is allowed.
- `to_json` emits the snake_case wire form the backend serves verbatim.

`EnvironmentMeta` gains `parameters: tuple[EnvParameter, ...] = ()`. The default keeps every existing `META` untouched. A `__post_init__` rejects duplicate names and a hand-declared `seats`.

### Seat count is a synthesized reserved parameter

`min_slots` and `max_slots` stay the source of truth for seat bounds. A module-level `effective_parameters(meta)` prepends a reserved `seats` parameter (`type="int"`, `default=max_slots`, `min=min_slots`, `max=max_slots`) to the declared tuple, and `EnvironmentMeta.to_json` emits the combined list, so the wire always carries `seats` explicitly. This avoids churning every existing consumer of the slot bounds (admin slot-count validation, orchestrator slot-shape validation, the scheduler, the shared TypeScript guard, and the specs) and cannot drift from them. For the three existing environments `min_slots` equals `max_slots`, so `seats` has exactly one possible value and the user-facing UI hides it.

A module-level `resolve_parameters(meta, *layers)` fills defaults from the effective declarations, then validates each override layer in order; unknown names raise. This is the one Python resolution function shared by the harness, local play, and tests.

### Factories take the resolved parameter map

`EnvironmentEntry.make` becomes `Callable[[Mapping[str, Any]], Any]` and the harness always passes the fully resolved map, which always contains `seats`. Environment factories are written as `def make_env(params=None)` so existing zero-argument call sites (the conformance tests and the composed student templates, which copy `env.py` verbatim) keep working. A future variable-seat environment reads `params["seats"]` to size `possible_agents`; after reset, the episode asserts that `len(env.possible_agents)` equals the resolved seat count so a factory that ignores it fails loudly. `default_action` and `overlay` are unchanged: they receive the live environment, which already embodies the parameters.

Flappy Bird declares `pipe_gap` (`int`, default 100, min 60, max 200) and passes it into `FlappyBirdGame`, which already accepts a `pipe_gap` constructor argument. The overlay and renderer read the gap per pipe from state and the observation space is unbounded floats, so nothing else changes. This gives the stage one real end-to-end parameter.

### Lockstep TypeScript validation in the schema package

`schema/ts/src/environment.ts` gains `EnvParameter`, `EnvParameterChoice`, and `ParameterValue` types, an `isEnvParameter` guard folded into `isEnvironmentMeta`, `validateParameterValue` (mirroring the Python semantics exactly; `int` requires `Number.isInteger`), and `resolveParameters(declarations, ...layers)` returning `{ values, issues }`. The backend uses it to validate season overrides and session-start payloads; the frontend shares the same functions for form validation and prefill. The Python `to_json`/`validate_value` pair and the TypeScript guard/validator pair must stay in lockstep, exactly like the existing metadata guard.

### Seasons override parameters through the existing config document

`OverridesSchema` in `backend/src/storage/season-config.ts` gains `parameters`, a record from name to boolean, finite number, string, or string array. The codec stays structure-only, as its own contract states; environment-aware validation happens in the admin API. `PUT /api/admin/seasons/:id/config` resolves the block against the environment's declarations and rejects any issue with a 400. When the override sets `seats`, every match's slot count must equal the resolved seat count; otherwise the existing min/max range check stands. Parameter edits ride the existing destructive-edit `?force=true` confirm flow unchanged.

### Session start accepts player tweaks and everything records the outcome

`POST /api/sessions` gains an optional `parameters` object. The orchestrator resolves in two layers: environment defaults with the season override applied (an issue here means the declarations drifted since the config was saved and yields a 409 `season_parameters_invalid`), then the player's tweaks on top (an issue yields a 400 `invalid_parameters`). Slot-shape validation sizes its required seats from the resolved `seats` value instead of `meta.max_slots`, which moves slot-shape errors after season resolution; the affected tests are updated deliberately. The resolved map is added to the launch argv, persisted on the session row, and returned by the session read API.

A new public endpoint `GET /api/environments/:envId/play-parameters` returns `{ season_id, values, issues }` for the play-open season (`season_id` null with pure defaults when play is closed), because season config is deliberately excluded from the public season views. The start forms prefill from it.

Automated runs always use the season values: triggering a run resolves them (refusing on issues), freezes them as a new `season_runs.parameters_snapshot` column following the `llm_policy_snapshot` precedent, and the workflow runner passes the snapshot to every game. `season_run_games` needs no new column: the values are uniform across a run by construction and each game's recording header carries them.

In the harness, `LiveConfig` gains `parameters` with shallow shape validation in `parse_config`. `Episode` takes a `parameters` argument and re-resolves defensively through `resolve_parameters` (`None` means pure defaults, which keeps the CLI, local play, and existing tests working), calls `entry.make` with the resolved map, and stamps the map into the recording header (`state.py` and `schema/recording-header.schema.json`).

### Storage and generated artifacts

`sessions.parameters` and `season_runs.parameters_snapshot` are JSON-text columns added by editing the flat initial migration in place, per the repository's migration convention. `uv run python scripts/generate.py` regenerates `backend/src/generated/environments.json` (now carrying `parameters` per environment) and the recording-header TypeScript types. Because an older session base image would silently ignore the unknown `parameters` argv key and run defaults, the dependency-set version is bumped so seasons pin a parameters-aware harness.

### Frontend: one dynamic form, a season banner, and admin overrides

A new `frontend/src/lib/parameters.ts` holds the pure logic: the visibility rule (a parameter is hidden from user-facing UI when it has only one possible value, meaning `min` equals `max` for numbers or the choice set has at most one entry), `resolvedDefaults`, `diffParameters` (start flows send only the values the player changed), `validateParameter`, `formatParameterValue`, and `resolvedSeatCount`.

`frontend/src/components/ParameterFields.vue` renders the visible declarations as a form: `int`, `float`, and `string` through `UiField` with `UiInput`; `bool` through `UiSelect` with On and Off options, matching the established messaging-override idiom; `choice` through `UiSelect`; `multi_choice` through a new `UiCheckboxGroup` primitive. It renders nothing when no parameter is visible, exposes parsed values through its model, and reports validity so parents can gate their start buttons.

`UiCheckboxGroup` is a new `frontend/src/components/ui/` primitive: a fieldset with a visible legend, labeled options, a string-array model emitted in options order, hint and error wiring mirroring `UiField`, and token-only styling. It appears on the `/styleguide` route and in the design-system inventory, and the season config editor's ad hoc model-alias checkbox fieldset is refactored onto it.

The environment page gains a play-season banner under the watch and play section head, shown while a season is open for play: "Now playing" with the season name, the season's description markdown, a quiet summary of the effective parameter values, and the sentence "Watching and playing use this season's settings; you can adjust them when you start." The play dialog title names the season. When play is closed, the empty-state copy says that no season is currently open for play. The multi-seat decision reads the resolved seat count instead of `meta.max_slots`. The banner and the boolean-as-select control are new visual patterns and need owner sign-off before implementation.

The start flows thread the form through: `StartForm` places it above the seed field and adds the diffed `parameters` to its payload; `SeatAssignmentDialog` derives its seat ids reactively from the resolved seat count (growing fills new seats with the Naive agent, shrinking reseats the human at the first in-range human-capable seat or disables start); `WatchAgentPicker` keeps its instant single-slot start only when no visible parameters exist and otherwise routes through the dialog, so Hearts and Spades behavior is unchanged today.

The season config editor gains an "Environment Parameters" card listing every declared parameter, including single-valued ones, since the hide rule is user-facing only and operators may still override. Each row follows the existing inherit-versus-override idioms: blank means inherit for numbers and strings, an "Environment default" first option for booleans and choices, and a default-or-custom mode revealing a `UiCheckboxGroup` for multi-choice. Overrides are validated against the declarations before save, canonicalized for dirty tracking, and unknown stored keys pass through untouched.

## Tests

- Harness: declaration structural checks, `validate_value` per type including the boolean-as-int traps, `effective_parameters` and `resolve_parameters` layering, episode re-resolution, the seat-count assertion, and the recording-header field.
- Environments: a conformance case constructing Flappy Bird through `entry.make` with an overridden `pipe_gap` and asserting the gap in state; Hearts and Spades factories accept and ignore the map.
- Schema package: the extended metadata guard and the TypeScript validator and resolver, mirroring the Python cases.
- Backend: season-config codec round-trips; admin config validation including drift refusals and seats-aware slot counts; run triggering freezing the snapshot; orchestrator resolution, the new error codes, and the deliberate error-precedence updates; workflow runner threading; the new public play-parameters endpoint.
- Frontend unit: the parameters library (visibility, defaults, diff, validation, seat count), `ParameterFields` rendering and validity, `UiCheckboxGroup`, and updates to the environment page, seat-assignment dialog, watch-picker, API client, and admin console suites.
- Playwright: the Flappy play dialog prefills the season value, a tweak starts a session whose recording header carries it; the Flappy watch flow opens the dialog; Hearts and Spades journeys are unchanged; an admin parameter override round-trips to the public play prefill.

## Risks

- A season override can outlive the declarations it was written against. Every consumer fails loud (400 at config save, 409 at run trigger and session start, non-empty issues on the play-parameters endpoint) and the operator repairs through the existing force flow. Frozen snapshots keep already-triggered runs immune.
- Moving slot-shape validation after season resolution changes orchestrator error precedence; tests are updated deliberately rather than accidentally.
- Numeric JSON round-trips are subtle: JavaScript serializes whole floats as integers and Python treats booleans as integers, so both validators pin these cases explicitly.
- Reactive seat grids can drop assignments or evict the human when the seat count shrinks; the grow-and-reseat rules and their tests cover this, and the concern stays theoretical while every environment is fixed-seat.
- A stale session base image ignores the new argv field and silently runs defaults; the dependency-set version bump removes that path.
- Variable seats interact with `human_slots` and the scheduler's Naive fill in ways this stage does not settle; the environment spec records them as open questions for the first variable-seat environment.

## Documentation and plan updates

Update the specifications alongside implementation:

- Revise [Environments](../docs/specs/environment.md): the metadata layers table and a new configurable-parameters section covering the declaration shape, the reserved `seats` rule, resolution order, and the single-value hide rule.
- Revise [Leaderboard](../docs/specs/leaderboard.md): the per-season configuration list gains parameter overrides and their interaction with match slot counts.
- Revise [Execution](../docs/specs/execution.md): the launch configuration and recording header gain the `parameters` field.

Revise the contributor environment guide for declaring parameters and the parameterized factory. Update `plans/stage-02/environments-and-metadata.md`, `plans/stage-06/1-season-config-and-storage.md`, and `plans/stage-06/3-admin-api-and-gating.md` where they describe the zero-argument factory and the override block as current architecture.

## Implementation order

1. Harness declaration types, validation, resolution, and the retyped factory signature.
2. Harness plumbing: episode parameters, live configuration, and the recording header with its schema.
3. Environment factories and the Flappy Bird `pipe_gap` declaration with conformance coverage.
4. Schema package types, guards, and resolver, then regeneration of the committed artifacts.
5. Storage columns, the season-config codec extension, and the storage interfaces.
6. Admin API validation, seats-aware slot counts, and run snapshotting.
7. Orchestrator resolution, the session-start body, the play-parameters endpoint, and session reads.
8. Workflow runner threading.
9. Frontend: client types, the parameters library, `UiCheckboxGroup` with its styleguide entry, `ParameterFields`, the start and watch flows, the environment page banner, and the season config editor card.
10. Specification, guide, and earlier-stage plan revisions, then the dependency-set version bump.

## Exit criteria

- Flappy Bird's pipe gap is tweakable end to end: the play dialog prefills the season value, a player tweak reaches the game, and the recording header records the value the session ran with.
- A season parameter override prefills public play and governs automated runs through the frozen snapshot.
- Hearts and Spades play, watch, and admin flows behave exactly as before.
- The environment page names the play-open season, shows its description and effective settings, and says that watching and playing use them.
- Season config edits with invalid or drifted parameter overrides are rejected with the typed reasons, and destructive edits still require force.
- `uv run ruff check --fix .` and `uv run ruff format .` have been applied after Python changes.
- `uv run python scripts/ci.py python`, `typescript`, `generated-code-fresh`, `docs`, and `frontend-e2e` pass.
