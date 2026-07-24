# Stage 14: Environment variants

Status: completed.

## Goal

Environments declare typed, friendly-labeled gameplay parameters (including seat count) in their Python registration. Seasons override the parameter defaults through season config. Players may tweak the values when starting a play or watch session, automated runs always use the season values, and every session records the values it actually ran with. The environment page states plainly which season is open for play and that watching and playing use that season's settings.

## Scope

- Parameter declaration types in the harness metadata and their JSON wire form.
- A reserved, synthesized `seats` parameter derived from `min_slots` and `max_slots`.
- Parameterized environment factories. Flappy Bird declares one real parameter (`pipe_gap`); Hearts and Spades gain the new factory signature but declare nothing.
- A `parameters` block in the season config overrides, admin validation against the declarations, and per-run snapshotting.
- The play-open `season_id` and a complete resolved `parameters` object on session start, followed by orchestrator validation, container threading, and persistence in the session row and recording header.
- Frontend: a dynamic parameter form in the start and watch flows, a new checkbox-group primitive, a play-season section on the environment page, and a parameter-overrides card in the season config editor.

Stage 14 targets a fresh, pre-release checkout. It updates the current source, version 1 template contents, and flat initial database schema in place. `template_version` and `deps_version` stay at 1. Databases, built session images, and composed templates from another checkout are unsupported and must be recreated. There is no data migration or backward-compatibility path.

Out of scope: any environment actually using a variable seat count (all existing environments stay fixed; scheduler Naive fill and `human_slots` semantics for variable seats are recorded as open questions, not built), parameter pinning that hides tweaking from players, backward compatibility, data migration, and Unity ML-Agents.

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

- `ParameterValue` is the shared Python value alias for booleans, JSON-safe integers, finite floats, strings, and lists of strings.
- `EnvParameterChoice` is a frozen dataclass with a unique, non-empty string `value` and a non-empty friendly display `label`. Both choice types use string values throughout Python, JSON, TypeScript, storage, and form controls.
- `EnvParameter` is a frozen dataclass with `name` (snake_case, unique within an environment, `seats` reserved), `title`, `description`, `type` (one of `int`, `float`, `string`, `bool`, `choice`, `multi_choice`), `default`, inclusive `min` and `max` for the numeric types, and a non-empty `choices` tuple for the choice types.
- `__post_init__` performs the structural checks and validates the default against the declaration. Integer bounds and values must be JSON-safe integers. Float bounds and values must be finite. Numeric bounds are ordered, titles and descriptions are non-empty, and defaults satisfy the same rules as overrides.
- `validate_value` returns the normalized value or raises a typed error. `int` accepts JSON-safe integers only and rejects booleans (Python treats `bool` as an `int` subclass, so the check is explicit). `float` accepts finite integers and floats, coerces integers to floats, and rejects booleans. `string` accepts any string, including an empty string. `choice` accepts one declared string value. `multi_choice` accepts a list of unique declared string values and normalizes it to declaration order; an empty list is allowed.
- `to_json` emits the snake_case wire form the backend serves verbatim, carrying only the keys a declaration's type actually uses, so the wire matches the TypeScript union rather than adding null bounds and empty choice lists that a declaration is not allowed to have.

`EnvironmentMeta` gains `parameters: tuple[EnvParameter, ...] = ()`, where the empty tuple means that the environment declares no gameplay parameters. A `__post_init__` rejects duplicate names and a hand-declared `seats`.

### Seat count is a synthesized reserved parameter

`min_slots` and `max_slots` stay the source of truth for seat bounds. A module-level `effective_parameters(meta)` prepends a reserved `seats` parameter (`type="int"`, `default=max_slots`, `min=min_slots`, `max=max_slots`) to the declared tuple, and `EnvironmentMeta.to_json` emits the combined list, so the wire always carries `seats` explicitly. This avoids churning every existing consumer of the slot bounds (admin slot-count validation, orchestrator slot-shape validation, the scheduler, the shared TypeScript guard, and the specs) and cannot drift from them. For the three existing environments `min_slots` equals `max_slots`, so `seats` has exactly one possible value and the user-facing UI hides it.

A module-level `resolve_parameters(meta, *layers)` fills defaults from the effective declarations, then validates each override layer in order; unknown names raise. This is the one Python resolution function shared by the harness, local play, and tests.

### Factories take the resolved parameter map

`EnvironmentEntry.make` becomes `Callable[[Mapping[str, ParameterValue]], Any]`. Every factory requires the fully resolved map, which always contains `seats`. The harness, conformance tests, `scripts/play.py`, composed-template helpers, and harness fixtures all resolve defaults before constructing an environment. The generated student environment surface uses the same required signature.

`scripts/_template_gen.py` renders `meta.parameters` as `EnvParameter` and `EnvParameterChoice` constructor expressions rather than feeding the effective JSON form back into `EnvironmentMeta`. The internal declaration tuple excludes the synthesized `seats` parameter, which `EnvironmentMeta.to_json` adds when it emits public metadata. Composition tests cover a generated Flappy Bird template with its declaration intact.

A future variable-seat environment reads `parameters["seats"]` to size `possible_agents`; after reset, the episode asserts that `len(env.possible_agents)` equals the resolved seat count so a factory that ignores it fails loudly. `default_action` and `overlay` are unchanged: they receive the live environment, which already embodies the parameters.

Flappy Bird declares `pipe_gap` (`int`, default 100, min 60, max 200) and passes it into `FlappyBirdGame`, which already accepts a `pipe_gap` constructor argument. The overlay and renderer read the gap per pipe from state and the observation space is unbounded floats, so nothing else changes. This gives the stage one real end-to-end parameter.

### Lockstep TypeScript validation in the schema package

`schema/ts/src/environment.ts` gains `EnvParameter`, `EnvParameterChoice`, and `ParameterValue` types, an `isEnvParameter` guard folded into `isEnvironmentMeta`, `validateParameterValue`, and `resolveParameters(declarations, ...layers)` returning `{ values, issues }`. `int` uses `Number.isSafeInteger`; `float` requires `Number.isFinite`; choice values are non-empty strings; and multi-choice values are unique string arrays normalized to declaration order. The backend uses the shared functions to validate season overrides and session-start payloads, and the frontend uses them for forms and prefill, as thin adapters rather than a second implementation of the same rules.

The two resolvers report a rejected value differently on purpose: TypeScript collects issues and keeps the declaration default, which is what lets the admin API name a bad override and the public prefill still serve usable values, while Python raises on the first bad value, which is what the harness wants when a launch configuration is wrong. The shared fixtures therefore pin what is genuinely shared: per-value validation and normalization, the resolved values for layers both accept, and the set of entries both reject, each side asserting rejection in its own terms. The fixtures also carry the `seats` declaration, which the Python side compares against the synthesized one so the reserved bounds and the `max_slots` default are pinned by the shared file.

### Seasons override parameters through the existing config document

`OverridesSchema` in `backend/src/storage/season-config.ts` gains `parameters`, a record from name to boolean, finite number, string, or string array. The codec stays structure-only, as its own contract states; environment-aware validation happens in the admin API. `PUT /api/admin/seasons/:id/config` resolves the block against the environment's declarations and rejects any issue with a 400. Every match's slot count must equal the resolved `seats` value, whether that value came from the environment default or a season override. Parameter edits ride the existing destructive-edit `?force=true` confirmation flow unchanged.

### Session start accepts player tweaks and everything records the outcome

`POST /api/sessions` requires the `season_id` and complete resolved `parameters` map returned by the prefill endpoint, with the player's form changes applied. The orchestrator loads the current play-open season and returns a 409 `play_season_changed` when its id differs, so a page cannot silently start against another season. The submitted keys must exactly equal the effective declaration names; a missing or unknown key yields a 400 `invalid_parameters`. The orchestrator validates and normalizes each value against the current environment declarations, and applies no season layer beneath the submitted map: the map already carries the season values, so a layer underneath could not change a single value and would only let a stored override the environment no longer accepts fail a start the player got right. The request body schema checks only that `parameters` is an object, because the declarations are the authority on values and Ajv's request coercion would rewrite them on the way through. Sending the complete state means a config edit within the same season cannot replace an omitted value after the page loads.

The orchestrator resolves parameters before it validates the slot shape. Slot-shape validation sizes its required seats from the resolved `seats` value instead of `meta.max_slots`, and tests assert this error precedence. The resolved map is added to the launch argv, persisted on the session row, and returned by the session read API.

A new public endpoint `GET /api/environments/:envId/play-parameters` returns `{ season_id, values }` for the play-open season (`season_id` is null with pure defaults when play is closed), because season config is deliberately excluded from public season views. The start forms retain both fields and submit them together. A stored override the current declarations reject falls back to its environment default and is logged rather than failing the read, so an operator's stale config cannot take public play offline. The environment page distinguishes a failed prefill read from a genuinely closed play window, instead of reporting the former as the latter.

One module owns this resolution for every consumer: the admin config write, the run trigger, the public prefill, and the seat count each read it from there, so the same stale config cannot produce four different outcomes.

Automated run creation treats the season config read inside `createRunWithSchedule`'s transaction as the frozen config. The transaction also reads the eligible ready submissions through the shared roster query rather than a second copy of its predicate, then passes the frozen config and roster to the pure schedule builder and to the parameter and official LLM policy resolvers. The builder returns a typed rejection rather than throwing or returning nothing, so an empty schedule and a drifted parameter override both reach the operator as classified failures (409 `empty_schedule` and 400 `invalid_parameters`) instead of an untyped 500, and "no run" has one representation rather than two. Otherwise it writes `config_snapshot`, `parameters_snapshot`, `llm_policy_snapshot`, `submission_snapshot`, and the scheduled games before committing. Every persisted run artifact therefore comes from one transactionally consistent input. The workflow runner passes the frozen parameter map to every game. `season_run_games` needs no new column because every match is validated against the one season-wide `seats` value and every game's recording header carries the map.

In the harness, `LiveConfig` requires `parameters` with shallow shape validation in `parse_config`. `Episode` takes the map and validates it as a complete one: every effective name must be present and no unknown name may appear. Filling a missing name with its default there would let a game run on a value nobody chose and then record it as though it had been. It calls `entry.make` with the normalized values and stamps the same values into the recording header. Environment factories read a typed value through a harness accessor rather than an `assert`, which `python -O` would strip. `parameters` is required in `RecordingHeader`, `build_header`, and `schema/recording-header.schema.json`, so every newly valid recording carries it. The CLI, local play, tests, and composed template resolve pure defaults explicitly before they construct `LiveConfig` or `Episode`.

### Storage and generated artifacts

`sessions.parameters` and `season_runs.parameters_snapshot` are JSON-text columns added by editing the flat initial migration in place, per the repository's migration convention. `uv run python scripts/generate.py` regenerates `backend/src/generated/environments.json` (now carrying `parameters` per environment), the packaged schema copies, and the recording-header TypeScript types.

JSON text remains a storage detail. Shared backend codecs encode normalized parameter maps on write and decode them into typed objects on read. Session storage and API projections return a parameter object, never the encoded string. The workflow runner decodes and validates `parameters_snapshot` once per run before launching any game, then reuses that map for every launch.

The template and dependency-set version remain unchanged. The current `deps-v1` image definition already copies the harness and environments from the working source tree, so rebuilding it includes Stage 14. Developers recreate the database, rebuild local session images, and recompose templates after this schema and contract change. The implementation adds no migration, compatibility branch, version gate, or legacy artifact test.

### Frontend: one dynamic form, a play-season section, and admin overrides

A new `frontend/src/lib/parameters.ts` holds the pure logic: the visibility rule, form initialization, validation, formatting, and `resolvedSeatCount`. A numeric parameter is hidden when `min` equals `max`, and a scalar `choice` is hidden when it has one option. A non-empty `multi_choice` always stays visible because even one option permits both the empty and selected states.

`frontend/src/components/ParameterFields.vue` renders the visible declarations as a form: `int`, `float`, and `string` through `UiField` with `UiInput`; `bool` through `UiSelect` with On and Off options, matching the established messaging-override idiom; `choice` through `UiSelect`; `multi_choice` through a new `UiCheckboxGroup` primitive. A numeric field's hint carries the declaration description and the allowed range. It renders nothing when no parameter is visible, exposes parsed values through its model, and reports validity so parents can gate their start buttons. An invalid value shows its `UiField` error as the user edits, so a disabled start button is always explained by a visible message rather than silently refusing. The parent retains hidden values from the prefill response and merges visible edits into that complete map.

`UiCheckboxGroup` is a new `frontend/src/components/ui/` primitive: a fieldset with a visible legend, labeled options, a string-array model emitted in options order, hint and error wiring mirroring `UiField`, and token-only styling. It appears on the `/styleguide` route and in the design-system inventory, and the season config editor's ad hoc model-alias checkbox fieldset is refactored onto it.

The environment page gains a play-season section directly above the play and rate section, shown while a season is open for play: "Open for Play" followed by the season name as its heading, the season's description markdown, and a quiet "Settings:" summary listing only the visible parameter values. A season with nothing visible to list says "No special settings." instead of dropping the line, because a player reading that line wants an answer either way. The section owns the "Play" action. The section below it is headed "Play and Rate" followed by the same season name, so the listed agents are plainly the ones playable and ratable in that season. The play dialog title names the season too. When play is closed, the empty-state copy says that no season is currently open for play. The multi-seat decision reads the resolved seat count instead of `meta.max_slots`. The play-season section and the boolean-as-select control are approved visual patterns.

The replay viewer shows the same settings for the episode it is replaying, read from the recording header's resolved parameter map through the shared `describeParameters` helper. Its status strip trades the "Seed" fact for a "Settings" one summarizing the count, with the visible values and the seed behind it in a tooltip: the strip stays one compact row, and the seed keeps its place as one of the run's settings rather than a fact of its own. The tooltip is the new `UiTooltip` primitive, extracted from `LlmCostTooltip` so cost figures and settings hover, focus, and pin identically; `LlmCostTooltip` becomes that primitive filled with `LlmCostDetails`.

The start flows thread the form through: `StartForm` places it above the seed field and adds the fetched `season_id` and complete resolved `parameters` map to its payload; `SeatAssignmentDialog` places it between the intro sentence and the seat grid, so the `seats` control (when visible) sits above the grid it resizes, and derives its seat ids reactively from the resolved seat count (growing fills new seats with the Naive agent, shrinking reseats the human at the first in-range human-capable seat or disables start); `WatchAgentPicker` keeps its instant single-slot start only when no visible parameters exist and otherwise routes through the dialog. When an unrated agent's **Rate** action opens the dialog, it preselects that agent into every resolved seat and disables the parameters, seat assignments, and seed. The ordinary watch and play paths remain editable. The instant path still submits the complete prefetched map, so Hearts and Spades behavior is unchanged today.

The season config editor gains an "Environment Parameters" card listing every declared parameter, including single-valued ones, since the hide rule is user-facing only and operators may still override. Every row has an explicit inherit-or-override mode so an empty string remains a valid string override and no control needs a sentinel value; the inherit option is labeled "Environment default (value)", matching the messaging override's `messagingDefaultLabel` idiom. Override mode reveals the type-appropriate input, including `UiCheckboxGroup` for multi-choice. The `seats` row carries the hint "Every match's slot count must equal this value," because a seats override is the one parameter that can invalidate the match design elsewhere on the page. Values are validated against the declarations before save and canonicalized for dirty tracking. The editor serializes only declarations from the current registry.

#### Mockups (Revise existing UI if needed)

The play-season section above the play and rate section head (which loses its "Season: …" tip). Drop the play section, if any:

```text
Open for Play: Spring 2026                        [Play]
A faster season with narrower pipes.     (markdown)
Settings: Pipe gap 90

Play and Rate: Spring 2026
  Naive agent  [Built-in]                      [Watch]
  Agent #3     [Not rated]                     [Rate]
```

A season with no visible parameters keeps the line and answers instead:

```text
Open for Play: Spring 2026                        [Play]
No special settings.
```

The replay viewer's status strip, with the episode's settings summarized and their values on hover:

```text
[Replay] Settings 2 settings · Ticks 412 · Owner maya · Created 12 Jun 2026 · LLM 1,080 units
                  ╰─ Pipe gap  90
                     Seed      4821
```

The single-slot play dialog (Flappy Bird), parameters above the seed field:

```text
┌ Play Flappy Bird — Spring 2026 ─────────────────── ✕ ┐
│ Pipe gap                [ 90            ]             │
│ Vertical opening between pipes. 60–200.               │
│ Seed (optional)          [ random        ]            │
│ Step time limit (ms)    [ 100           ]             │
│ [Start playing]  [Cancel]                             │
└───────────────────────────────────────────────────────┘
```

The multi-seat dialog for a future variable-seat environment, with the parameter form between the intro and the seat grid so the `seats` control sits above the grid it resizes (every current environment hides `seats`, so today this section shows only any other visible parameters):

```text
┌ Play Hearts — Autumn 2026 ──────────────────────── ✕ ┐
│ Pick your seat; assign agents to the rest.            │
│ Seats                    [ 4 ]                        │
│ 3–6.                                                  │
│ Scoring variant          [ Standard ▾ ]               │
│ ──────────────────────────────────────                │
│ Seat 1   You  seated                                  │
│ Seat 2   [ Naive agent ▾ ]  [Sit here]                │
│ Seat 3   [ Naive agent ▾ ]  [Sit here]                │
│ Seat 4   [ Naive agent ▾ ]  [Sit here]                │
│ ──────────────────────────────────────                │
│ Seed (optional)          [ random ]                   │
│ Step time limit (ms)     [ 30000  ]                   │
│ [Start playing]  [Cancel]                             │
└───────────────────────────────────────────────────────┘
```

The `UiCheckboxGroup` primitive (legend, options, hint):

```text
Expansions
[x] Moving pipes
[ ] Night mode
[ ] Wind gusts
Pick any combination.
```

The season config editor's Environment Parameters card, one row inheriting and one overriding:

```text
┌ Environment Parameters ───────────────────────────────┐
│ Pipe gap   [ Environment default (100) ▾ ]            │
│                                                       │
│ Seats       [ 4 (default) ]                           │
│   1–4. Every match's slot count.                      │
└───────────────────────────────────────────────────────┘
```

## Tests

- Harness: declaration structural checks, JSON-safe integer and finite-float cases, boolean-as-integer traps, choice uniqueness, `effective_parameters` and `resolve_parameters` layering, episode re-resolution, the seat-count assertion, and the recording-header field.
- Environments and templates: Flappy Bird constructed through `entry.make` with an overridden `pipe_gap`; Hearts and Spades accepting and ignoring the required map; every factory seam receiving a resolved map; and a composed Flappy template retaining its parameter declarations and running headlessly with resolved defaults.
- Schema package: the extended metadata guard plus the TypeScript validator and resolver running the shared Python/TypeScript value fixtures.
- Backend: season-config and parameter-storage codec round-trips; admin validation for parameter values and exact resolved seat counts; a run-creation regression proving the ready roster, schedule, empty-schedule result, and all snapshots use the transaction's frozen config; orchestrator validation of exact full-map keys and stale season ids; decoded session and run reads; workflow runner threading; and the public play-parameters endpoint.
- Frontend unit: the parameters library (visibility, initialization, validation, description, and seat count), including a visible one-option multi-choice; `ParameterFields`; `UiCheckboxGroup`; `UiTooltip` and the `RunMetadata` detail rows built on it; the environment page's settings summary and its no-special-settings line; the replay viewer's settings summary and tooltip; and updates to the seat-assignment dialog, watch-picker, API client, and admin console suites.
- Playwright: the Flappy play dialog prefills the season value, a tweak starts a session whose row and recording header carry it, and the replay of that session summarizes the same settings and reveals them on hover; a changed play season is rejected before launch; the Flappy watch flow opens the dialog; Hearts and Spades journeys are unchanged; and an admin parameter override round-trips to the public play prefill.

## Risks

- Parameter resolution precedes slot-shape validation, and the orchestrator tests pin that error order.
- Numeric JSON round-trips are subtle: the shared safe-integer, finite-number, and boolean rejection fixtures pin the Python and TypeScript semantics.
- Reactive seat grids can drop assignments or evict the human when the seat count shrinks; the grow-and-reseat rules and their tests cover this, and the concern stays theoretical while every environment is fixed-seat.
- A session start page can outlive its play-open season. The required expected `season_id` turns that race into a typed 409 before a row or container is created, while the complete parameter map preserves the state loaded by the page when only the config changed.
- The run-creation transaction owns the frozen config, eligible submission roster, schedule, and every snapshot so they remain consistent.
- Local databases, images, or composed templates from an earlier checkout are incompatible by design and must be recreated.
- Variable seats interact with `human_slots` and the scheduler's Naive fill in ways this stage does not settle; the environment spec records them as open questions for the first variable-seat environment.

## Documentation and plan updates

Update the specifications alongside implementation:

- Revise [Environments](../docs/specs/environment.md): the metadata layers table and a new configurable-parameters section covering the declaration shape, the reserved `seats` rule, resolution order, and the single-value hide rule.
- Revise [Leaderboard](../docs/specs/leaderboard.md): the per-season configuration list gains parameter overrides and their interaction with match slot counts.
- Revise [Execution](../docs/specs/execution.md): the launch configuration gains the required resolved `parameters` field.
- Revise [Interaction](../docs/specs/interaction.md): play and watch starts carry the expected play-open season and the complete parameter state loaded by the page.
- Revise [Recording](../docs/specs/recording.md): the header records the resolved parameters used by the game.
- Revise [Frontend](../docs/specs/frontend.md): the play-season section and its settings line, parameter forms, the replay viewer's episode settings, resolved-seat behavior, and season-aware start contract.
- Revise the [design system](../docs/contributors/frontend/design-system.md) inventory for `UiCheckboxGroup` and `UiTooltip`.

Revise the contributor environment and template guides for declaring parameters, using the required factory signature, and rebuilding disposable development artifacts. Update `plans/stage-02/environments-and-metadata.md`, `plans/stage-06/1-season-config-and-storage.md`, `plans/stage-06/3-admin-api-and-gating.md`, `plans/stage-07/4-session-start-slots-api.md`, and `plans/stage-13-unified-rendering.md` to describe the required factory, config, session-start, live-runner, and template contracts.

## Implementation order

1. Harness declaration types, numeric and choice validation, resolution, and the required factory signature.
2. Harness plumbing: episode parameters, live configuration, and the recording header with its schema.
3. Environment factories, all internal and composed-template factory call sites, template metadata generation, and the Flappy Bird `pipe_gap` declaration.
4. Schema package types, guards, resolver, and shared cross-language fixtures, then regeneration of the committed artifacts.
5. Storage columns, the season-config codec extension, and the storage interfaces.
6. Admin API validation, exact resolved seat counts, and transactionally frozen schedule and run snapshots.
7. Orchestrator resolution, the expected-season and complete-parameters start body, the play-parameters endpoint, and session reads.
8. Workflow runner threading.
9. Frontend: client types, the parameters library, `UiCheckboxGroup` with its styleguide entry, `ParameterFields`, the start and watch flows, the environment page banner, and the season config editor card.
10. Specification, guide, and earlier-stage plan revisions, followed by regeneration of the database, current session image, and composed development templates.

## Exit criteria

- Flappy Bird's pipe gap is tweakable end to end: the play dialog prefills the season value, a player tweak reaches the game, and the recording header records the value the session ran with.
- A season parameter override prefills public play and governs automated runs through snapshots and games derived from one transactionally frozen config.
- Session start submits the expected play-open season and complete resolved form state, rejects a changed season before launch, and records the normalized values it ran.
- Hearts and Spades play, watch, and admin flows behave exactly as before.
- The environment page names the play-open season, shows its description and effective settings, and says that watching and playing use them.
- Season config edits with invalid parameter overrides or match counts that differ from resolved `seats` are rejected with typed reasons, and destructive edits still require force.
- The template and dependency-set version remain unchanged. A freshly generated database, rebuilt current session image, and recomposed template are the only supported artifacts.
- `uv run ruff check --fix .` and `uv run ruff format .` have been applied after Python changes.
- `uv run python scripts/ci.py python`, `typescript`, `generated-code-fresh`, `docs`, and `frontend-e2e` pass.
