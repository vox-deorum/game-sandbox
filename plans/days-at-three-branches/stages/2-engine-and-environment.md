# Step 2: Simulation engine and PettingZoo environment

Status: planned.

Part of [the plan](../README.md). This is build-order step 2: the whole [ruleset](../ruleset.md) as a Python engine over the cell grid [village.md](../village.md) specifies, with the PettingZoo environment, metadata, and both builtins on top. It runs on a hand-authored fixture village until step 4 brings the real generator. The hands-on surface is full cast_5 and cast_10 days through the harness, recorded to JSONL inside the size budget and replaying identically.

## Why this is its own seam

The engine is the physics everything else trusts, and the environment is the platform face that the harness, recorder, backend, and web app consume. Building them together against a fixture village gets the full vertical slice running early, and step 7's template helpers are pin-tested against this engine rather than a second implementation of the rules.

## What to build

### The engine in two layers

pymunk (the Chipmunk2D bindings) owns movement: `physics.py` builds one static `pymunk.Space` from the layout at reset and steps it once per tick, so the engine's own cost per tick sits far below the 250 millisecond cadence. Plain Python owns everything else: perception, prop logic, ground classes, and speech ranges are closed-form tests on positions and shapes, which keeps them exactly reproducible by step 7's stdlib-only helper package. pymunk is version-pinned in `environments/pyproject.toml` and reaches the sandbox image through the existing wheel dependency flow; the template layer and the builtins stay stdlib-only. `env.py` is the only module importing gymnasium, pettingzoo, or numpy.

The grid supplies ground speed and passability, including water as the solid ground class. The catalog supplies every object shape and opacity rule. That division is the base of the engine:

- Impassable ground enters the space as coalesced rectangles rather than one box per cell, so a body sliding along water never catches on an internal seam.
- Structural props, interactive props, and scenery enter as the collision shapes their catalog records declare. Structural wall instances can remain individual catalog shapes.
- Characters are circles, and Chipmunk resolves the pushing and sliding the ruleset describes.

Each emitted object instance reserves distinct cells and carries its catalog shape as its collision truth. The layout, use selection, prop perception, renderer, and template clearance helpers all obtain that shape from its type token.

| Module | Responsibility |
| --- | --- |
| `rules.json` + `rules.py` | The village frame, ground classes, emotes, character profile, phases, day length, and their import-time validating loader |
| `catalog.json` + `catalog.py` | The semantic building, structural prop, interactive prop, and scenery type catalogs, their validating loader, and the transition-kind registry |
| `generation.json` + generation loader | Immutable generator tuning, validated at import |
| `grid.py` | The `Grid` type: the frame, the ground rows, cell and point conversion, neighbour walks, flood fill, and the supercover raycast |
| `geometry.py` | Heading wrap and vectors, distance, nearest point on a rect and on a circle, the vision cone test |
| `layout.py` | `Layout`: grid, semantic buildings, structural and interactive props, scenery, spawn, derived masks and solid shapes, `ground_at`, `body_clear`, and the start-pose formula |
| `fixture.py` | The hand-authored fixture village |
| `generation/` | `build_village(seed) -> Layout` and the stages that fill the seam |
| `physics.py` | The static `pymunk.Space` build and the per-tick movement step |
| `perception.py` | Sight, hearing, concealment, prop visibility, the bell |
| `prop_use.py` | Use selection, contention, hold and release, transitions through the registry |
| `engine.py` | `DayConfig`, character and prop state, `Day.step(orders)` and `Day.perception(id)`: the tick cycle |
| `env.py` | The `ParallelEnv`, `make_env`, `default_action`, spaces, player and character id mapping, chat hooks |
| `overlay.py` | `extract_overlay_static`, `extract_overlay`, and the strict `decode_overlay` authority |
| `observation_types.py` | Stdlib TypedDicts for the observation and action |
| `naive.py`, `scripted_visitor.py` | The two builtins |

### The shared data files

Two JSON files carry everything both ends need, and both are validated at import the way Skirmish at Crane Reach loads `tile_types.json`. Step 3's renderer imports the same two files by relative path.

`rules.json`:

- `village`: `cells_x`, `cells_y`, and `cell_size`. Grid and overlay code read these values; the fixture and art assets target the shipped frame.
- `ground`: an ordered array of classes, each with a token, a single-character grid code, a speed, a `passable` flag, and an optional `conceals` flag, plus the token of the class the map fills with. Water is the impassable class and reed is the concealing one, both by flag rather than by name.
- `emotes` (the nine names in action-id order), `profile` (body radius, vision degrees and range, hearing, talk, shout, prop reach, the running threshold), `phases` (contiguous from tick 1 to `day_ticks`), the off-variant phase name, and `day_ticks`.

The loader validates a positive frame and cell size, unique single-character codes inside the observation charset, exactly one impassable class, a fill class that exists and is passable, exactly nine unique emotes, positive profile values, and phase contiguity. Tests pin the shipped values against the ruleset's tables.

`catalog.json` holds ordered semantic building templates, structural prop types, interactive prop types, and scenery types. The ruleset is the sole human-readable exact catalog table. These arrays carry schema and implementation data:

- A building template has its footprint, identity and placement fields, residence and district metadata, a floor-terrain override, the structural type references for its perimeter and doorway, and its allowed interior interactive prop types.
- A structural prop type is non-interactive and declares its footprint, collision shape, passability, and opacity. The wall type is solid and opaque. The doorway type is passable and transparent.
- An interactive prop type has its identity, activity, footprint, collision shape, states, start state, transition, placement fields, and district metadata.
- A scenery type has its identity, footprint, collision shape, placement fields, and opacity.

Collision records declare a box or circle and any smaller solid extents inside the reserved cells. Changing one record reaches physics, the collision overlay, and reach calculations together. A placed building is a semantic group, not a collision object: its expansion writes the floor-terrain override and emits its structural prop instances. Interior interactive props may occupy building floor cells. Every emitted structural, interactive, and scenery object instance occupies cells distinct from every other emitted object instance.

The loader validates unique snake_case tokens across object types, positive footprints, shapes that fit their reservations, valid structural passability and opacity, valid interactive states and transitions, and interior interactive props that fit within their building floor. It validates that each building template can emit its declared wall and doorway types. Counts and other shipped catalog facts stay in the ruleset. The loader exposes canonical order, and residence seating follows the residence templates rather than a constant.

The transition registry in `catalog.py` maps a kind token to a small state machine with begin, hold, release, and tick hooks. Four ship: toggle, occupancy, timed, and none. Adding a fifth is a registry entry and a data shape, and no other module enumerates the kinds.

The package is data-extensible for types that use existing transition, placement, and art mechanisms. A new interactive prop type supplies a catalog record, a placement token the generator already knows, and art. A new ground class supplies a `rules.json` record and a tile. A new building template uses the existing floor, structural expansion, placement, and art mechanisms. No engine module lists supported types or assumes an object's shape.

`generation.json` stays Python-only maintainer tuning, validated at import, with its groups following the generation stages.

### The grid and the layout

`grid.py` owns the map primitive. A `Grid` carries the frame and the ground rows as a tuple of strings, and answers `code_at(cell)`, `cell_of(point)`, `centre_of(cell)`, `in_frame(cell)`, `neighbours(cell)`, `flood(start, passable)`, and `raycast(a, b, blocked)` as a supercover cell walk. Every one of them is index arithmetic, and none of them knows what the codes mean.

`layout.py` builds a `Layout` from a grid, semantic building placements with their selected doorway cells, interactive props, scenery, and the spawn. It is the single expansion boundary: each building template overrides its site with floor terrain and emits structural wall and doorway records. It then derives the static model once:

- `blocked`: impassable-ground cells, including water, coalesced deterministically into rectangles whose union is exactly those cells.
- `solids`: one placed collision shape per structural prop, interactive prop, and scenery item, built from its catalog record, cells, and facing.
- `opaque`: the placed shapes selected by catalog opacity flags.
- `conceal`: a connected-component id per cell of each concealing class, so concealment is an equality test between two component ids.
- `object_occupancy`: final cells of emitted structural, interactive, and scenery instances, used to keep object instances distinct. It does not treat a semantic building record or floor terrain as an occupied collision object.

`blocked` and `solids` together are the static collision model, and `physics.py` and step 7's clearance helpers both read them, so a helper cannot describe a village the engine does not collide with. The layout also provides `ground_at(point)` as one lookup, `body_clear(point)` as the 0.4 m circle against the blocked rectangles and placed shapes around it, and the start-pose formula. Start poses find the doorway structural records owned by each residence. Building floor and structure expansion comes from the shared catalog, so no consumer recreates building geometry.

`fixture.py` hand-authors one complete village as ASCII ground rows plus semantic building, interactive prop, and scenery placements. The layout builder expands the building templates, keeping the fixture readable while exercising the full catalog contract. Its exact cells are the implementer's, held to village.md's guarantees as invariant tests.

### Physics

Characters are circle bodies of radius 0.4 with infinite moment, zero friction, and zero restitution. Each tick the engine sets a body's velocity to the commanded heading's unit vector times the commanded fraction times the speed limit of the ground class under the body's pre-tick cell, steps the space, then zeroes every velocity, so nothing coasts. Contact stops or deflects a mover along the surface; nothing passes through a solid or another character.

- A character commanding speed 0 is immovable for the tick (its body is static for that step): the ruleset's speed 0 turns in place and stays exactly put, movers slide around standers, and a stander is never shoved. Two movers in contact push and slide with equal mass.
- The static space holds the layout's coalesced blocked-ground rectangles, the four boundary walls, and one shape per structural prop, interactive prop, and scenery item. Coalescing gives each water run one surface rather than a row of abutting per-cell boxes with interior seams.
- The tick is stepped in 8 substeps, so the largest per-substep displacement of 0.125 m stays far below the one-cell thickness of a wall plus the body radius and nothing tunnels. The ground speed limit is sampled once per tick at the pre-tick cell, not per substep.
- After the step the engine reads positions straight from the solver; `moved` is the position-to-position distance. Observations carry float32, and the overlay rounds to centimetres at encode time. There is no intermediate quantization layer.
- Determinism scope: Chipmunk is deterministic for the same build stepping the same operations, so same-process double rollouts and same-platform replays are exact, which is what the determinism tests assert. Cross-platform bit identity is not promised; committed recordings are replayed, never re-simulated, so nothing depends on it. The engine draws no randomness.

### The tick cycle

`Day.step(orders)` takes a complete character-keyed order map and runs one tick:

1. Degrade commanded values per the ruleset: a heading of 360 wraps to 0, a non-finite heading or speed degrades to heading unchanged or speed 0, and the default order is speed 0, heading unchanged, expression none.
2. Resolve expressions on the pre-tick pose, the same state the observations showed: prop selection, stillness, and availability per the rules below, with same-tick contention going to the first claimant in character order, npc_0 upward and the visitor last. That order is not player order: the visitor is `player_0`, the NPCs occupy `player_1` upward, and the engine works in character ids while the environment owns the mapping.
3. Move everyone together through the movement solver.
4. Apply prop transitions for the tick's end: occupancy releases, timed reverts.
5. Advance the tick; perception and the day phase (when daynight is on) are served from the new state.

### Prop use and perception

Interactive-prop selection follows the ruleset: the nearest interactive prop by distance to the nearest point of its collision shape within 1.5 m reach, with an unblocked line to that same point, judged on the pre-tick pose, ties broken by canonical prop order, stillness required (commanded speed above 0 resolves the expression to none), and a prop already held resolving to none with no fall-through to the second nearest. A character holds a use by choosing it again, and releases by choosing anything else, by moving, or by leaving reach. Every state change runs through the transition registry, so the engine never names a prop type.

Perception, all computed from the engine's character positions: the 120 degree cone on the heading out to 12 m with the raycast over `opaque`, so structural walls block while doorway props, interactive props, and scenery do not; hearing at 6 m any facing under the same raycast; concealment by concealing-class component id, vision only; interactive-prop states under that cone and line applied to the nearest point of each prop's collision shape; and the bell perceived by everyone while ringing, whatever the distance and whatever stands between.

### Environment and spaces

`env.py` builds the parallel environment on the engine, with the action and observation spaces from the [environment specification](../environment.md). The visitor is `player_0` and `npc_i` is `player_(i+1)`, fixed in two small mapping functions. Spaces are built once in the constructor from the resolved frame and catalogs and shared across players: fixed-count composites as `Tuple` (the buildings, structural props, ground rows, and roster), variable-count as `Sequence` (interactive props and scenery), Box leaves as 0-dimensional float32 arrays, and Text fields with the charsets and lengths the specification fixes. The engine retains one immutable internal village snapshot per episode. Each observation receives an isolated plain `Dict` mapping decoded from that snapshot. Static records contain type token, cell, facing, and owner where applicable, never shape or footprint dimensions.

Both seat plans are declared, cast_5 first as the default: seat_0, the cast, holds `player_1` upward, and seat_1, the visitor, holds `player_0` and is restricted to `scripted_visitor`. Both gameplay parameters, and the six season presets pinned by a literal-table test.

An action outside the space raises naming the player, so the harness attributes the forfeit; values inside the space degrade rather than fail. `default_action` returns the player's current heading, speed 0, action 0. Rewards are 0 every tick and 100 to every player on tick 1200, termination not truncation, `env.agents` empties at the end, and no `result_scores` hook. The reset observation carries tick 1 and the terminal observation keeps tick 1200.

### Speech

The environment ships the two chat hooks; delivery mechanics are all platform. `chat_policy(sender)` lists the characters within 3 m talk range with an unblocked line, nearest first with roster order breaking distance ties, and the nearest as the default recipient. `broadcast_recipients(sender)` bounds an NPC shout to 15 m and the visitor's broadcast to 3 m, unblocked lines, through the step 1 hook. Two timing facts are normative because the harness imposes them: the talk policy is evaluated against the pre-step state, since chat hooks run while actions are collected, and broadcast audiences resolve at end-of-tick state, since delivery happens after the step. The once-per-recipient-per-tick rule is harness-enforced, so the environment supplies ordering only. Watchers receive every delivered message under the platform visibility rule, the cap is 200 code points, and a line recorded on tick T reaches inboxes during T+1 after actions are chosen, so the earliest reaction is tick T+2, as the ruleset states.

### The compact overlay

The version 1 overlay uses the recording contract's static and dynamic split: `overlay_static` is captured once after reset in the header, and each step carries only its dynamic data. Both use single-character keys, base36 fields, positions in integer centimetres, angles in tenths of degrees, and cells as base36 indices.

- Header `overlay_static` holds the frame (cell counts and the cell size in centimetres), the ground rows run-length encoded, semantic buildings as type index and origin cell, structural objects as type index, cell, and owner, interactive objects as type index, cell, and facing, scenery as type index and cell, and the spawn. Its decoded static records expose the type token, cell, facing, and owner where applicable, and omit collision shapes and footprint dimensions because the catalog is the source. Ids derive from catalog order. Because the decoder reads the frame from the payload, grid and overlay consumers do not hold a copy of the village dimensions.
- The dynamic section: the tick, one 14-character record per character in roster order (x, y, heading, moved, expression id, and a two-character use-target prop index, with `zz` for none), a prop-state string matching the static interactive-prop roster length, and the terminal flag. Bell and phase are derived on decode, from the bell prop's state and from the tick plus the daynight flag.
- `decode_overlay` is the strict authority for replay consumers and takes both dynamic and header-static data: exact key sets, record lengths, catalog and pose counts, ground rows summing to the declared frame, cells inside the frame, coordinate and angle ranges, and expression and target consistency (a use implies moved 0, no two characters hold one prop), decoding to friendly JSON in metres, cells, and words. A terminal frame must name the final tick. The nonterminal state that offers the final action also names it, so both consecutive states are valid.

Grid-aligned features run long, so the run-length ground rows compress far better than a sampled map would. Tests cap the canonical static payload below 12 KiB, the full header below 16 KiB, and the cast_10 recording below 2 MiB, measured at the fixture and re-measured at step 4's blessed seed. The full-day timing case keeps each engine transition plus serial charged agent work below the 250 millisecond cadence, each builtin call below its step budget, and reset plus all calls below each agent's episode budget.

### Metadata and the builtins

`META` per the design's platform metadata table: simultaneous stepping, `recommended_episode_ticks=1200`, a 250 millisecond `pace_interval_ms` and `view_interval_ms`, `human_timeout_ms=None`, `step_limit_ms=250`, `episode_limit_ms=120000`, messaging on with the 200 code point cap, `llm=True`, `human_players` as the single entry `player_0`, and the renderer key `three-branches-village`.

The `naive` builtin is the platform baseline and performs a seeded random walk. It first follows its spawn heading so it can leave its building, then changes heading at seeded intervals and turns again when a commanded walk is stalled. It never uses props, emotes, or chat. The `scripted_visitor` builtin seeds `random.Random` from the seed its `reset` receives, builds a waypoint graph from the road and path cells of its setup observation, and wanders vertex to vertex at walking speed; on seeing an NPC not on cooldown it approaches, waves once, sends one canned line through the chat hook, lingers a few ticks, replies briefly if answered, sets a cooldown, and resumes; commanded speed with `moved` 0 on two consecutive ticks triggers a short detour heading. All randomness comes from the reset seed, both builtins hold their own small movement maths, and neither imports the engine. Both are staged byte-identically under `backend/images/session-base/deps-v1/builtin/three_branches/` with manifests, guarded by byte-equality tests.

### Registration and the minimal real stubs

Discovery is all-or-nothing: a package under `environments/` is either listed in `.envignore` or subject to the full conformance suite, whose authoring-shape test requires `environment.md`, a renderer with exactly one thumbnail, a template, and at least one example, and whose renderer-ownership test forbids a `renderer/` directory on an ignored package. So the package sits in `.envignore` with no renderer directory while the engine milestones land. The final milestone removes that line and registers a minimal real stub under the production contracts:

- Ship a trivial `renderer/index.ts` with the key `three-branches-village` and a thumbnail. Step 3 replaces it with the real renderer and watch surface. Ship a raw-observation stand-still `template/agent.py` with its README, an embryonic `examples/sweeper/` smoke example, and an `environment.md` factual stub. Step 7 replaces those student-facing stubs behind the same contracts.
- Run `npm run sync:envs` for the pyproject entry point and the backend catalog, add `three_branches` to both hand-listed Dockerfile smoke lines, add `("three_branches", "sweeper")` to the compose inventory pin, and stage the builtin copies.
- The forfeit floor needs no score-module change: `forfeitScore` already returns 0 by default, which is this environment's floor.

### Build order

Seven milestones, each ending green:

1. Data and grid: the package skeleton behind `.envignore` with pymunk pinned, the two shared JSON files and their loaders, the transition registry, generator-only `generation.json` and its loader, and `grid.py` and `geometry.py` with exhaustive unit tests.
2. Layout and fixture: the layout types, the derived static model, `ground_at` and `body_clear`, the ASCII fixture village, and the `generation` seam returning it.
3. Physics and engine: `physics.py`, `perception.py`, `prop_use.py`, `engine.py`, the full tick cycle on the fixture.
4. Environment: `env.py`, spaces, id mapping, chat hooks, `META`, `ENTRY`, presets, `observation_types.py`. Episode-driven tests construct `ENTRY` directly, so no registration is needed yet.
5. Overlay: the codec, the budget measurement, replay determinism through the harness.
6. Builtins: both agents, staged copies, byte-equality.
7. Registration and conformance: the `.envignore` removal, the minimal real stubs, `sync:envs`, the Dockerfile lines, the compose pin, the full conformance suite green for three_branches defaults, and the cast_10 seconds-per-tick measurement recorded.

## Tests

One file per cluster under `environments/three_branches/tests/`. Every suite that needs a village takes it explicitly, so the fixture's cells stay valid whatever the generator later does, and every suite that needs a placement derives it from the layout at runtime rather than pinning a coordinate.

- `test_rules_data`: the rules, catalog, and generation loaders reject malformed documents, including a collision shape larger than its own footprint, and the shipped catalog values are pinned against the ruleset's table.
- `test_grid`: cell and point conversion at cell edges and centres, frame bounds, neighbour walks, flood fill over a hand-drawn mask, and the supercover raycast including the corner and axis-aligned cases.
- `test_geometry`: heading wrap, distance, nearest point on a rect and on a circle including the inside and corner cases, and cone edges.
- `test_layout_fixture`: every fixture invariant from village.md, deterministic coalesced blocked rectangles whose union exactly covers impassable ground, one placed shape per structural, interactive, and scenery item under each facing, catalog-driven opaque and conceal masks, separate site reservation and object occupancy, building-floor interior props, `ground_at` spot pins, `body_clear` at a doorway and beside both a box and a circular object, and the start poses.
- `test_physics`: sliding contact along a wall and around a corner, sliding around a circular prop where a box would stop a body square, speed-0 immobility (a stander is never displaced), no tunneling at maximum speed, a crossing traversed, water blocking, doorway passage at an angle, ground speed limits per class, boundary confinement, heading 360 wrapping, and the default order.
- `test_engine_props`: selection, the reach edge, canonical-order ties, stillness, contention in character order, hold and release, each registry kind including toggle without retoggle, occupancy, timed refresh and reverts at the catalog's counts, and the stateless board.
- `test_engine_perception`: cone edges, wall blocking and doorway sight, hearing edges, concealment inside and across components, the bell everywhere, prop visibility, and phases with daynight on and off.
- `test_environment`: spaces built once, `observation_space.contains` across a full episode, isolated plain observation mappings that cannot mutate the immutable internal village snapshot or another player's observation, reset and step mappings covering the roster exactly, static records containing type, cell, facing, and owner where applicable but no shape or footprint dimensions, rewards and termination on tick 1200, `default_action`, the preset literal table, use selection through `env.step` with the standing point found by a `body_clear` search, an out-of-space action raising with the player named, the id mapping, and one cast member's crash forfeiting the whole cast seat at floor 0 through an Episode.
- `test_chat`: policy ordering and default, broadcast bounds for NPC and visitor, wall-blocked speech, the cap, and delivery timing through the harness (a line on tick T readable during T+1, first reaction T+2). Placements come from a deterministic search over `env.day.layout`, so a failed search is a village quality signal rather than a stale coordinate.
- `test_overlay`: encode and decode round trips, each malformed field rejected, a focused alternate-frame decode proving the codec reads its frame, catalog-derived shapes from type tokens, version 1 static data separated from every dynamic frame, and decoder isolation from consumer mutations.
- `test_builtins`: naive performs the same random walk for the same seed, changes heading, recovers from stalls, and stays finite through the real engine; staged copies are byte-equal for both builtins; neither imports the engine or any third-party package; and the scripted visitor is deterministic per seed, builds its graph from the observed road and path cells, wanders, approaches, and speaks its canned lines.
- `test_budget`: full cast_5 and cast_10 days each produce 1,201 recording frames and replay identically from the same seed. The cast_10 recording stays below 2 MiB and its header below 16 KiB. Each real builtin's combined `act` and optional `chat` fit the per-step budget, while `reset`, `act`, and `chat` together fit the per-game budget. Each tick's serial charged agent work and engine transition stay below the 250 millisecond cadence; reset is not part of a gameplay tick.

The shared conformance suite (`parallel_api_test`, the platform's stricter parallel subset, deterministic seeded rollouts, metadata round-trip) covers the rest automatically once the package is discovered.

## Done when

Full cast_5 and cast_10 days run through the harness on the fixture village, record inside budget, and replay identically. Grid arithmetic passes at the shipped configured frame, the overlay decoder passes its focused alternate-frame coverage, the conformance suite is green for three_branches defaults, and the registration milestone has landed whole: catalog entry and minimal real stubs, Docker smoke lines, and staged builtins.
