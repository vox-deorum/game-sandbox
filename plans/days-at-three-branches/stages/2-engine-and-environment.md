# Step 2: Simulation engine and PettingZoo environment

Status: planned.

Part of [the plan](../README.md). This is build-order step 2: the whole [ruleset](../ruleset.md) as a Python engine over the cell grid [village.md](../village.md) specifies, with the PettingZoo environment, metadata, and both builtins on top. It runs on a hand-authored fixture village until step 4 brings the real generator. The hands-on surface is full cast_5 and cast_10 days through the harness, recorded to JSONL inside the size budget and replaying identically.

## Why this is its own seam

The engine is the physics everything else trusts, and the environment is the platform face that the harness, recorder, backend, and web app consume. Building them together against a fixture village gets the full vertical slice running early, and step 7's template helpers are pin-tested against this engine rather than a second implementation of the rules.

## What to build

### The engine in two layers

pymunk (the Chipmunk2D bindings) owns movement: `physics.py` builds one static `pymunk.Space` from the layout at reset and steps it once per tick, so the engine's own cost per tick sits far below the 250 millisecond cadence. Plain Python owns everything else: perception, prop logic, ground classes, and speech range are closed-form tests on positions and shapes, which keeps them exactly reproducible by step 7's stdlib-only helper package. pymunk is version-pinned in `environments/pyproject.toml` and reaches the sandbox image through the existing wheel dependency flow; the template layer and the builtins stay stdlib-only. `env.py` is the only module importing gymnasium, pettingzoo, or numpy.

The map's two layers are the base of the engine, and they stay apart all the way down:

- The cell grid answers speed, passability, and sight. Impassable cells, which is water and every building wall, enter the physics space as coalesced rectangles rather than one box per cell, so a body sliding along a river or a wall never catches on an internal seam. Sight is a walk over the same grid, reading each class's sight-blocking flag.
- Placed props answer collision individually. Interactive props and scenery enter as the box or inscribed-circle shapes their catalog records declare, so a walker slides around the pump and stops square against a bench. The layout, use selection, prop perception, renderer, and template clearance helpers all obtain that shape from the prop's type token.
- Characters are circles, and Chipmunk resolves the pushing and sliding the ruleset describes.

| Module | Responsibility |
| --- | --- |
| `rules.json` + `rules.py` | The village frame, ground classes, emotes, character profile, phases, day length, physics substeps, and their import-time validating loader |
| `catalog.json` + `catalog.py` | The building template, interactive prop, and scenery catalogs, their validating loader, and the four prop transitions |
| `grid.py` | The `Grid` type: the frame, the ground rows, cell and point conversion, neighbour walks, flood fill, and the supercover raycast |
| `geometry.py` | Heading wrap and vectors, distance, nearest point on a rect and on a circle, the vision cone test |
| `layout.py` | `Layout`: the grid, semantic buildings, props, scenery, spawn, building site painting, derived blocked rectangles and prop shapes, `ground_at`, `body_clear`, `doorway`, and the start-pose formula |
| `fixture.py` | The hand-authored fixture village |
| `generation/` | `build_village(seed) -> Layout` and the stages that fill the seam |
| `physics.py` | The static `pymunk.Space` build and the per-tick movement step |
| `perception.py` | Sight, hearing, prop visibility, the bell |
| `prop_use.py` | Use selection, contention, hold and release, transitions |
| `engine.py` | `DayConfig`, character and prop state, `Day.step(orders)` and `Day.perception(id)`: the tick cycle |
| `env.py` | The `ParallelEnv`, `make_env`, `default_action`, spaces, player and character id mapping, the broadcast hook |
| `overlay.py` | `extract_overlay_static` and `extract_overlay` |
| `observation_types.py` | Stdlib TypedDicts for the observation and action |
| `naive.py`, `scripted_visitor.py` | The two builtins |

### The shared data files

Two JSON files carry everything both ends need, and both are validated at import the way Skirmish at Crane Reach loads `tile_types.json`. Step 3's renderer imports the same two files by relative path.

`rules.json`:

- `village`: `cells_x`, `cells_y`, and `cell_size`. Grid and overlay code read these values; the fixture and art assets target the shipped frame.
- `ground`: an ordered array of classes, each with a token, a single-character grid code, a speed, a `passable` flag, and a `blocks_sight` flag, plus the token of the class the map fills with. Water and wall are impassable and wall blocks sight, all by flag rather than by name, so a new class is a data entry and no module tests a token.
- `emotes` (the nine names in action-id order), `profile` (body radius, vision degrees and range, hearing range, prop reach, the running threshold), `phases` (contiguous from tick 1 to `day_ticks`), the off-variant phase name, `day_ticks`, and `physics.substeps`.

The loader validates a positive frame and cell size, unique single-character codes inside the observation charset, at least one impassable class, a fill class that exists and is passable, exactly nine unique emotes, positive profile values, and phase contiguity. Tests pin the shipped values against the ruleset's tables.

`catalog.json` holds ordered building templates, interactive prop types, and scenery types. The ruleset is the sole human-readable exact catalog table. These arrays carry schema and implementation data:

- A building template has its site footprint, identity and placement fields, residence and district metadata, the ground-class tokens its site painting uses for the interior, the perimeter, and the doorway run, the doorway run's length, and its allowed interior interactive prop types.
- An interactive prop type has its identity, activity, footprint, collision shape, states, start state, transition, placement fields, and district metadata.
- A scenery type has its identity, footprint, collision shape, and placement fields.

Collision records declare a box or a circle and any smaller solid extent inside the reserved cells. Changing one record reaches physics, the collision overlay, and reach calculations together. A placed building is a semantic group, not a collision object: painting its site is the whole of its geometry, and interior interactive props may stand on its floor cells. Every placed prop and scenery instance occupies cells distinct from every other one.

The loader validates unique snake_case tokens, positive footprints, shapes that fit their reservations, valid interactive states and transitions, interior props that fit within their building floor, and that every ground-class token a building template names exists in `rules.json`. Counts and other shipped catalog facts stay in the ruleset.

`catalog.py` holds the four prop transitions, toggle, occupancy, timed, and none, as a small table of begin, hold, release, and tick functions keyed by kind. Adding a fifth is an entry and a data shape.

`generation.json` is the generator's own tuning, listed in [village.md](../village.md), validated when the generation package imports.

### The grid and the layout

`grid.py` owns the map primitive. A `Grid` carries the frame and the ground rows as a tuple of strings, and answers `code_at(cell)`, `cell_of(point)`, `centre_of(cell)`, `in_frame(cell)`, `neighbours(cell)`, `flood(start, passable)`, and `raycast(a, b, blocked)` as a supercover cell walk. Every one of them is index arithmetic, and none of them knows what the codes mean.

`layout.py` builds a `Layout` from a base grid, semantic building placements with their chosen doorway side, interactive props, scenery, and the spawn. It is the single site-painting boundary: each building template paints its rect with its interior, perimeter, and doorway ground classes, so no other module knows how a building becomes cells. It then derives the static model once:

- `blocked`: impassable-ground cells, water and wall alike, coalesced deterministically into rectangles whose union is exactly those cells.
- `solids`: one placed collision shape per interactive prop and scenery item, built from its catalog record, cells, and facing.
- `occupancy`: the final cells of placed props and scenery, used to keep instances distinct.

Sight needs no derived structure at all, because it is the grid: `raycast` reads each class's `blocks_sight` flag straight off the ground rows.

`blocked` and `solids` together are the static collision model, and `physics.py` and step 7's clearance helpers both read them, so a helper cannot describe a village the engine does not collide with. The layout also provides `ground_at(point)` as one lookup, `body_clear(point)` as the body circle against the blocked rectangles and placed shapes around it, `doorway(building_id)` as the door cells found on that building's own perimeter, and the start-pose formula, which seats each residence's housemates on its floor facing that doorway.

`fixture.py` hand-authors one complete village as ASCII ground rows for the land plus semantic building, prop, and scenery placements. The layout paints the building sites, keeping the fixture readable while exercising the full catalog contract. Its exact cells are the implementer's, held to village.md's guarantees as invariant tests.

### Physics

Characters are circle bodies of the profile's radius with infinite moment, zero friction, and zero restitution. Each tick the engine sets a body's velocity to the commanded heading's unit vector times the commanded fraction times the speed limit of the ground class under the body's pre-tick cell, steps the space, then zeroes every velocity, so nothing coasts. Contact stops or deflects a mover along the surface; nothing passes through a solid or another character.

- A character commanding speed 0 is immovable for the tick (its body is static for that step): the ruleset's speed 0 turns in place and stays exactly put, movers slide around standers, and a stander is never shoved. Two movers in contact push and slide with equal mass.
- The static space holds the layout's coalesced blocked rectangles, the four boundary walls, and one shape per interactive prop and scenery item.
- The tick is stepped in `physics.substeps` substeps. The shipped value is the smallest that passes the no-tunnel case at maximum speed against the thinnest solid in the catalog, which is what the test measures rather than assumes. The ground speed limit is sampled once per tick at the pre-tick cell, not per substep.
- After the step the engine reads positions straight from the solver; `moved` is the position-to-position distance. Observations carry float32, and the recording rounds to centimetres at encode time. There is no intermediate quantization layer.
- Determinism scope: Chipmunk is deterministic for the same build stepping the same operations, so same-process double rollouts and same-platform replays are exact, which is what the determinism tests assert. Cross-platform bit identity is not promised; committed recordings are replayed, never re-simulated, so nothing depends on it. The engine draws no randomness.

### The tick cycle

`Day.step(orders)` takes a complete character-keyed order map and runs one tick:

1. Degrade commanded values per the ruleset: a heading of 360 wraps to 0, a non-finite heading or speed degrades to heading unchanged or speed 0, and the default order is speed 0, heading unchanged, expression none.
2. Resolve expressions on the pre-tick pose, the same state the observations showed: prop selection, stillness, and availability per the rules below, with same-tick contention going to the first claimant in character order, which puts the visitor first.
3. Move everyone together through the movement solver.
4. Apply prop transitions for the tick's end: occupancy releases, timed reverts.
5. Advance the tick; perception and the day phase (when daynight is on) are served from the new state.

### Prop use and perception

Interactive-prop selection follows the ruleset: the nearest interactive prop by distance to the nearest point of its collision shape within the profile's reach, with an unblocked line to that same point, judged on the pre-tick pose, ties broken by canonical prop order, stillness required (commanded speed above 0 resolves the expression to none), and a prop already held resolving to none with no fall-through to the second nearest. A character holds a use by choosing it again, and releases by choosing anything else, by moving, or by leaving reach. Every state change runs through its transition, so the engine never names a prop type.

Perception is all computed from the engine's character positions: the profile's cone and vision range with a `raycast` over the sight-blocking classes, so walls block while doorways, props, and scenery do not; hearing at the profile's hearing range, any facing, under the same raycast; interactive-prop states under that cone and line applied to the nearest point of each prop's collision shape; and the bell perceived by everyone while it rings, whatever the distance and whatever stands between.

### Environment and spaces

`env.py` builds the parallel environment on the engine, with the action and observation spaces from the [environment specification](../environment.md). Character index and player index are the same number, so the mapping is one pair of one-line functions: character 0 is the visitor and `player_0`, and `npc_i` is character i+1 and `player_(i+1)`. Spaces are built once in the constructor from the resolved frame and catalogs and shared across players: fixed-count composites as `Tuple` (the buildings, ground rows, and roster), variable-count as `Sequence` (props and scenery), Box leaves as 0-dimensional float32 arrays, and Text fields with the charsets and lengths the specification fixes. The engine retains one immutable internal village snapshot per episode, and each observation receives an isolated plain `Dict` projected from it.

Both seat plans are declared, cast_5 first as the default: seat_0, the cast, holds `player_1` upward, and seat_1, the visitor, holds `player_0` and is restricted to `scripted_visitor`. Both gameplay parameters ship, and the six season presets are pinned by a literal-table test.

An action outside the space raises naming the player, so the harness attributes the forfeit; values inside the space degrade rather than fail. `default_action` returns the player's current heading, speed 0, action 0. Rewards are 0 every tick and 100 to every player on tick 1200, termination not truncation, `env.agents` empties at the end, and no `result_scores` hook. The reset observation carries tick 1 and the terminal observation keeps tick 1200.

### Speech

The environment ships one chat hook, and delivery mechanics are all platform. `broadcast_recipients(sender)` returns the characters within the profile's hearing range of the sender with an unblocked line, resolved at end-of-tick state since delivery happens after the step. There is no `chat_policy`, because a line has no addressee to rank. The cap is 200 code points, one line per character per tick, and a line recorded on tick T reaches inboxes during T+1 after actions are chosen, so the earliest reaction is tick T+2. Every client receives every delivered line, human controllers included, because every line is a broadcast.

### The recording

A recording is one JSONL file: a header line, then one line per recorded transition. Two payloads carry the village, and the split between them is what keeps the file small.

**The header carries the static map, once.** `extract_overlay_static(day)` writes `overlay_static` at reset, in exactly the shape the observation's `village` field takes:

```json
{
  "size": { "cells_x": 100, "cells_y": 100, "cell_size": 1.0 },
  "ground": ["oooowwwwoooo…", "…"],
  "buildings": [{ "id": "home_0", "type": "home", "cell": { "x": 12, "y": 40 } }],
  "props": [{ "id": "stall_0", "type": "stall", "cell": { "x": 51, "y": 33 }, "facing": "north" }],
  "scenery": [{ "type": "pine", "cell": { "x": 8, "y": 61 } }],
  "spawn": { "x": 1.5, "y": 50.5 }
}
```

The ground rows are the whole of the map's geometry, walls, doorways, floors, water, and roads alike, so a building needs no record beyond its id, type, and origin. Nothing repeats it: no recorded state carries a village field, and the renderer reads it once at mount and builds its tile layers, roofs, prop bases, and collision layer from it for the whole session. At the shipped frame it is about 10 KB.

**Each recorded state carries only what can differ between two ticks.** `extract_overlay(day)` writes:

```json
{
  "tick": 412,
  "phase": "morning",
  "characters": [
    { "id": "visitor", "x": 34.12, "y": 50.5, "heading": 90.0, "moved": 0.75,
      "expression": { "type": "wave", "target": "none" } }
  ],
  "props": { "stall_0": "open", "bell": "silent" },
  "terminal": false
}
```

- `characters` runs in character order, the visitor first, one record per character in the roster.
- `props` names every interactive prop and its current state word. The bell's ringing state is one of them, so nothing carries it twice.
- Positions and `moved` are rounded to centimetres and headings to a tenth of a degree at encode time. That rounding is what makes a replayed frame identical to the live frame it came from.

That is about 1.6 KB per tick, so a cast_10 day lands near 2 MB, comfortably inside the platform's 10 MiB recording budget. One test measures a full day against that platform budget; the environment declares no tighter cap of its own.

Everything is plain JSON with the same words the ruleset uses: no packing, no index tables, no second vocabulary to learn. The renderer reads these documents through declared TypeScript types and checks the top-level shape once at mount, so there is no separate decoder authority and no cross-language fixture to keep in step.

### Metadata and the builtins

`META` per the design's platform metadata table: simultaneous stepping, `recommended_episode_ticks=1200`, a 250 millisecond `pace_interval_ms` and `view_interval_ms`, `human_timeout_ms=None`, `step_limit_ms=250`, `episode_limit_ms=120000`, messaging on with the 200 code point cap, `llm=True`, `human_players` as the single entry `player_0`, and the renderer key `three-branches-village`.

The `naive` builtin is the platform baseline and performs a seeded random walk. It first follows its spawn heading so it can leave its building, then changes heading at seeded intervals and turns again when a commanded walk is stalled. It never uses props, emotes, or speaks.

The `scripted_visitor` builtin seeds `random.Random` from the seed its `reset` receives and gives the cast something to react to. Its contract is behavioral rather than structural: it wanders the village all day without getting stuck, approaches an NPC it sees, waves, speaks a canned line, lingers briefly, replies briefly if answered, then moves on, and it repeats exactly for the same seed. How it chooses where to walk is the implementer's, and its reset cost stays inside the per-game budget.

Both builtins hold their own small movement maths and neither imports the engine. Both are staged byte-identically under `backend/images/session-base/deps-v1/builtin/three_branches/` with manifests, guarded by byte-equality tests.

### Registration and the minimal real stubs

Discovery is all-or-nothing: a package under `environments/` is either listed in `.envignore` or subject to the full conformance suite, whose authoring-shape test requires `environment.md`, a renderer with exactly one thumbnail, a template, and at least one example, and whose renderer-ownership test forbids a `renderer/` directory on an ignored package. So the package sits in `.envignore` with no renderer directory while the engine milestones land. The final milestone removes that line and registers a minimal real stub under the production contracts:

- Ship a trivial `renderer/index.ts` with the key `three-branches-village` and a thumbnail. Step 3 replaces it with the real renderer and watch surface. Ship a raw-observation stand-still `template/agent.py` with its README, an embryonic `examples/sweeper/` smoke example, and an `environment.md` factual stub. Step 7 replaces those student-facing stubs behind the same contracts.
- Run `npm run sync:envs` for the pyproject entry point and the backend catalog, add `three_branches` to both hand-listed Dockerfile smoke lines, add `("three_branches", "sweeper")` to the compose inventory pin, and stage the builtin copies.
- The forfeit floor needs no score-module change: `forfeitScore` already returns 0 by default, which is this environment's floor.

### Build order

Seven milestones, each ending green:

1. Data and grid: the package skeleton behind `.envignore` with pymunk pinned, the two shared JSON files and their loaders, the transition table, and `grid.py` and `geometry.py` with exhaustive unit tests.
2. Layout and fixture: the layout type, site painting, the derived static model, `ground_at`, `body_clear`, `doorway`, the ASCII fixture village, and the `generation` seam returning it.
3. Physics and engine: `physics.py`, `perception.py`, `prop_use.py`, `engine.py`, the full tick cycle on the fixture.
4. Environment: `env.py`, spaces, id mapping, the broadcast hook, `META`, `ENTRY`, presets, `observation_types.py`. Episode-driven tests construct `ENTRY` directly, so no registration is needed yet.
5. Recording: `overlay.py`, the budget measurement, replay determinism through the harness.
6. Builtins: both agents, staged copies, byte-equality.
7. Registration and conformance: the `.envignore` removal, the minimal real stubs, `sync:envs`, the Dockerfile lines, the compose pin, the full conformance suite green for three_branches defaults, and the cast_10 seconds-per-tick measurement recorded.

## Tests

One file per cluster under `environments/three_branches/tests/`. Every suite that needs a village takes it explicitly, so the fixture's cells stay valid whatever the generator later does, and every suite that needs a placement derives it from the layout at runtime rather than pinning a coordinate.

- `test_rules_data`: the rules and catalog loaders reject malformed documents, including a collision shape larger than its own footprint and a building template naming a ground class that does not exist, and the shipped values are pinned against the ruleset's tables.
- `test_grid`: cell and point conversion at cell edges and centres, frame bounds, neighbour walks, flood fill over a hand-drawn mask, and the supercover raycast including the corner and axis-aligned cases.
- `test_geometry`: heading wrap, distance, nearest point on a rect and on a circle including the inside and corner cases, and cone edges.
- `test_layout_fixture`: every fixture invariant from village.md, site painting producing floor, wall, and doorway ground for each building rect, deterministic coalesced blocked rectangles whose union exactly covers impassable ground, one placed shape per prop and scenery item under each facing, prop occupancy distinct, interior props on building floor, `ground_at` spot pins, `body_clear` at a doorway and beside both a box and a circular prop, `doorway` finding each building's run, and the start poses.
- `test_physics`: sliding contact along a wall and around a corner, sliding around a circular prop where a box would stop a body square, speed-0 immobility (a stander is never displaced), no tunneling at maximum speed against the thinnest catalog solid, a crossing traversed, water blocking, doorway passage at an angle, ground speed limits per class, boundary confinement, heading 360 wrapping, and the default order.
- `test_engine_props`: selection, the reach edge, canonical-order ties, stillness, contention in character order with the visitor winning a tie against a villager, hold and release, each transition kind including toggle without retoggle, occupancy, timed refresh and reverts at the catalog's counts, and the stateless board.
- `test_engine_perception`: cone edges, wall blocking and doorway sight, hearing edges, props and scenery never blocking a line, the bell everywhere, prop visibility, and phases with daynight on and off.
- `test_environment`: spaces built once, `observation_space.contains` across a full episode, isolated plain observation mappings that cannot mutate the immutable internal village snapshot or another player's observation, reset and step mappings covering the roster exactly, roster order beginning with the visitor, rewards and termination on tick 1200, `default_action`, the preset literal table, use selection through `env.step` with the standing point found by a `body_clear` search, an out-of-space action raising with the player named, the id mapping, and one cast member's crash forfeiting the whole cast seat at floor 0 through an Episode.
- `test_chat`: broadcast bounds at the hearing edge, wall-blocked speech and speech through a doorway, the 200 code point cap, and delivery timing through the harness (a line on tick T readable during T+1, first reaction T+2). Placements come from a deterministic search over `env.day.layout`, so a failed search is a village quality signal rather than a stale coordinate.
- `test_overlay`: the static payload equal to the observation's `village` field, the dynamic payload carrying every character in character order and every interactive prop's state, rounding applied at encode, the terminal flag only on the final tick, and no recorded state carrying village data.
- `test_builtins`: naive performs the same random walk for the same seed, changes heading, recovers from stalls, and stays finite through the real engine; the scripted visitor is deterministic per seed, covers ground across a full day without stalling, approaches, waves, and speaks; staged copies are byte-equal for both; and neither imports the engine or any third-party package.
- `test_budget`: full cast_5 and cast_10 days each produce 1,201 recording frames and replay identically from the same seed, and the cast_10 recording fits the platform's 10 MiB budget. Each real builtin's combined `act` and optional `chat` fit the per-step budget, while `reset`, `act`, and `chat` together fit the per-game budget. Each tick's serial charged agent work and engine transition stay below the 250 millisecond cadence; reset is not part of a gameplay tick.

The shared conformance suite (`parallel_api_test`, the platform's stricter parallel subset, deterministic seeded rollouts, metadata round-trip) covers the rest automatically once the package is discovered.

## Done when

Full cast_5 and cast_10 days run through the harness on the fixture village, record inside the platform budget, and replay identically. Grid arithmetic passes at the shipped configured frame, the conformance suite is green for three_branches defaults, and the registration milestone has landed whole: catalog entry and minimal real stubs, Docker smoke lines, and staged builtins.
