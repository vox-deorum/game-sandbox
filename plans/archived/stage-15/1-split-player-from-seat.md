# Stage 15.1: Split player from seat

Status: complete.

Part of [Stage 15](../stage-15-wide-seats.md), build-order step 1.

## Outcome

The metadata, parameter, session, scheduler, and storage contracts distinguish PettingZoo players from assignable seats. Both Python and TypeScript resolve the same canonical seat-to-player layout from a complete parameter map. Every existing environment still uses player bounds, so each resolved seat contains exactly one player and behavior stays unchanged.

The hands-on check loads all three environments from the generated registry, starts the same solo sessions as before through the seat-named API, and inspects a resolved layout whose `seat_N` contains only `player_N`.

## Metadata declarations

Replace `EnvironmentMeta.min_slots`, `max_slots`, and `human_slots` in `harness/src/game_sandbox_harness/environment.py` with one tagged `layout` field and a top-level `human_players`. The layout is a frozen union of two variants:

- `PlayerBounds(min, max)`, the common case, where every player gets a seat of its own.
- `SeatPlans(plans)`, an ordered nonempty tuple of frozen `SeatPlan` values, each with a snake_case key, a nonempty title, and an ordered tuple of nonempty tuples of player indices.

The tag is the declaration style, so normal typed construction supplies exactly one variant. Runtime boundaries can still receive `None`, an object with an unknown tag, or JSON carrying fields from both variants, so `EnvironmentMeta.__post_init__` and `isEnvironmentMeta` reject those shapes before a factory can be registered:

- Player bounds are positive integers with `min <= max`.
- Plan keys are unique parameter names and titles are nonempty.
- Every plan has at least one seat, every seat has at least one player index, and indices are nonnegative integers.
- Flattening a plan's seats produces exactly `range(player_count)`: no duplicates, gaps, or nonzero starting index.
- A failure raises a `ValueError` naming the environment and the plan where applicable.

The generated metadata carries the same tag. A player-bounds environment writes `"layout": { "kind": "player_bounds", "min": N, "max": M }`, and a seat-plan environment writes `"layout": { "kind": "seat_plans", "plans": [...] }` where each plan is `{ key, title, seats: number[][] }`. The TypeScript type in `schema/ts/src/environment.ts` is the union discriminated on `kind`, sharing the remaining metadata fields. `isEnvironmentMeta` narrows on `kind`, rejects foreign variant fields, and then checks that variant's contents and the reserved parameter that matches it.

Keep `human_players` as player ids such as `player_0`, top-level and outside the layout. Human capability is a property of a PettingZoo player rather than of a declaration style. A later wide-seat assignment is human-playable when it has at least one capable member, and the first capable member in declared seat order becomes the human player.

Update `EnvironmentMeta.to_json()` and the generated registry format to match.

## Reserved parameters and layout resolution

Rename the synthesized `seats` integer parameter to `players`. It remains the first effective parameter for a player-bounds environment, uses that variant's `min` and `max`, and defaults to `max`. Reserve both `players` and `seat_plan`, so an environment cannot declare either in its ordinary `parameters`.

For a seat-plan environment, synthesize a first `seat_plan` choice parameter. Its values and labels come from the ordered plans and its default is the first plan key. A one-plan environment still publishes the one-option choice so every persisted parameter map names its layout.

Add one pure layout resolver in each language:

- Python owns the implementation used by environment factories, local play, and harness validation.
- `schema/ts/src/environment.ts` exports the TypeScript implementation used by the backend and frontend.

Each resolver accepts metadata and an already complete, validated parameter map. It returns the canonical plan key, ordered `seat_N` ids, the ordered `player_N` members of every seat, and derived `playerCount` and `seatCount` values. Under player bounds the plan key is `solo`, both counts equal the resolved `players` value, and `seat_N` maps to `player_N`. Under declared plans the counts and membership come only from the selected plan. A missing, wrongly typed, or unknown reserved value is an internal contract error rather than a fallback to a default.

Replace `resolvedSeatCount(values)` in `backend/src/environment-parameters.ts` and both `resolvedSeatCount(declarations, values, fallback)` and `seatCountOf(declarations, values)` in `frontend/src/lib/parameters.ts` with this shared resolver. Parameter resolution always runs before layout resolution. Call sites pass the resulting layout forward rather than deriving `player_${i}` or counting seats independently.

## Player-named harness runtime

Rename the harness types and fields that represent individual PettingZoo positions:

- `AgentSlot`, `ExternalSlot`, `Slot`, `SlotBinding`, and `_SlotState` become player-named.
- `slot_id` locals and arguments become `player_id`.
- The launch configuration's `slots` mapping becomes `player_bindings`, so it remains distinct from the existing `players` recording-attribution map.
- `EpisodeResult.failed_slot` becomes `failed_player`.
- `default_action(env, slot_id)` becomes `default_action(env, player_id)`.

Apply the rename through `harness/src/game_sandbox_harness/session.py`, `harness/src/game_sandbox_harness/live.py`, and `harness/src/game_sandbox_harness/live_io.py`, including parser errors and result envelopes. LLM credentials and telemetry remain keyed by `player_N`, because their budgets are enforced per PettingZoo player.

`Episode.start()` resolves the layout from the complete parameter map and asserts that `env.possible_agents` is the exact ordered `player_0` through `player_N-1` sequence for the derived player count. This assertion covers both metadata styles and catches a factory that ignores its reserved parameter.

Update `schema/recording-header.schema.json`, `schema/step-state.schema.json`, the generated TypeScript types, and Python and TypeScript protocol fixtures for the player-named runtime fields. The existing recording `players` object keeps its name because it already attributes each `player_N`. The new seat-to-player recording header field belongs to [step 3](3-results-and-binding.md).

## Seat-named platform contracts

The browser and backend continue assigning one request entry per assignable unit, so their overloaded slot vocabulary becomes seat vocabulary:

- `StartRequest.slots`, `SlotAssignment`, and `validateSlotShape` in `backend/src/session/orchestrator.ts` become `seats`, `SeatAssignment`, and `validateSeatShape`.
- `MAX_HUMAN_SLOTS` becomes `MAX_HUMAN_SEATS`.
- `StartRequest.humanSlotTimeoutMs` becomes `humanTimeoutMs`, since it is the human move-clock override rather than an id.
- `LiveSessionInit.externalSlots` in `backend/src/session/live-session.ts` becomes `externalPlayers`, and the relay's `input` gate moves onto it from `humanSlots`. The external set is the players a human actually controls, which is what an input command has to name.
- `LiveSessionInit.humanSlots` is then removed, because the environment's human-capable list has no other consumer in the live session.
- Session API payloads, socket authorization state, frontend API types, and `SeatAssignmentDialog.vue` emit `seat_N` keys.
- An ordinary `SeatAssignment` remains a Naive or submission binding. Its human variant may carry one companion agent binding. The companion is forbidden for a singleton and becomes required for a wide seat in [step 3](3-results-and-binding.md), so the request shape does not change when the first wide layout arrives.
- The human option is available when the resolved seat contains at least one entry from `human_players`. The first such member in seat order is the human player, and the backend derives and validates it authoritatively rather than trusting a client-provided player id.

At this step all resolved seats are singletons. Still validate the request against the resolver's exact seat-id set rather than against a numeric count, so [step 3](3-results-and-binding.md) can expand a wide seat without changing the request contract.

Rename the session and season persistence fields in the flat initial schema:

- `session_submissions.slot_id` becomes `seat_id`.
- `season_run_games.slots` becomes `seats`.
- `game_results.slot_index` becomes `seat_index`.

Carry those names through the Kysely row types, queries, admin payloads, test factories, and views. There is no forward migration. Existing development databases are recreated as required by the Stage 15 overview.

Rename `MatchConfig.slots`, `SlotSpec`, and `SLOT_SPECS` to their seat equivalents. The scheduler still receives one submission per resolved seat and keeps the existing ordered or unordered assignment rule. Admin validation compares a match's assignment length with `layout.seatCount`, not a value read directly from the parameters.

The existing environment registrations in `environments/*/__init__.py` adopt the `PlayerBounds` layout only. Flappy Bird, Hearts, and Spades all remain one player per seat in this step. Update `scripts/_template_gen.py`, `scripts/_envs.py`, and `scripts/generate.py`, then regenerate `backend/src/generated/environments.json`, generated schema types, and owned fixtures with the normal generator rather than editing outputs by hand.

## Specification edits

This step changes the environment contract, so it revises [Environments](../../docs/specs/environment.md): the player and seat vocabulary, the tagged layout with its two declaration styles, the `players` and `seat_plan` reserved parameters, and the derived player and seat counts. It also revises the seat vocabulary in [Interaction](../../docs/specs/interaction.md) as far as grid sizing from a resolved layout, leaving a human occupying a wide seat to [step 4](4-spades-partnership-plan.md).

Both files use the word `seats` today to mean one PettingZoo position. Read every occurrence rather than replacing the word, because after this step some of them mean the wider unit and some mean a player.

## Tests

Python metadata and parameter tests cover:

- Player bounds synthesizing `players`, defaulting to the maximum, and resolving the canonical singleton `solo` layout.
- Declared plans synthesizing `seat_plan` in declaration order and deriving both counts without a separate player value.
- An uneven valid plan with one one-player seat and one three-player seat.
- Rejection of duplicate plan keys, empty plans, empty seats, duplicate indices, missing indices, a nonzero first index, a gap, a missing or unknown layout tag, and a JSON layout carrying fields from both variants.
- Reserved-name collisions for both `players` and `seat_plan`.
- `Episode.start()` accepting the exact derived `possible_agents` list and rejecting a factory with the wrong size or order in either declaration style.

Schema TypeScript tests use shared valid and invalid JSON fixtures to pin the same wire decisions and verify that the exported resolver agrees with Python on canonical solo and uneven layouts.

Backend, storage, scheduler, and frontend tests follow the request and field renames. They verify exact `seat_N` shape validation, singleton human capability, rejection of an unnecessary companion on a singleton, the relay refusing an `input` command naming a human-capable player the session does not actually expose, parameter resolution before layout resolution, and unchanged schedules for every existing one-player-per-seat environment.

## Done when

All metadata and session boundaries use player for a PettingZoo position and seat for an assigned unit. Python and TypeScript produce identical canonical layouts, all generated artifacts are fresh, the current environments run with unchanged singleton behavior, and the metadata, harness, schema, backend session, scheduler, and storage roots no longer contain `min_slots`, `max_slots`, `human_slots`, or the reserved `seats` parameter.

Two player-shaped `slot` names deliberately survive here, because renaming them is inseparable from the work that gives them a seat to sit beside: `SlotConfig` in `backend/src/session/launch-config.ts` and `aggregateSeat` in `backend/src/workflow/aggregate.ts` both move in [step 3](3-results-and-binding.md). Environment, renderer, example, and guide vocabulary is completed in [step 2](2-environment-player-rename.md).
