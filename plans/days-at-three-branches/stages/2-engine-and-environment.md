# Step 2: Simulation engine and PettingZoo environment

Status: complete.

Part of [the plan](../README.md). This is build-order step 2: the whole [ruleset](../ruleset.md) as a Python engine, with pymunk resolving movement and the PettingZoo environment, metadata, and both builtins on top. It runs on a hand-authored fixture village until step 4 brings the real generator. The hands-on surface is full cast_5 and cast_10 days through the harness, recorded to JSONL inside the size budget and replaying identically.

## Why this is its own seam

The engine is the physics everything else trusts, and the environment is the platform face that the harness, recorder, backend, and web app consume. Building them together against a fixture village gets the full vertical slice running early, and step 7's template helpers are pin-tested against this engine rather than a second implementation of the rules.

## What to build

### The engine in two layers

pymunk (the Chipmunk2D bindings) owns movement: `physics.py` builds one static `pymunk.Space` from the layout at reset and steps it once per tick, so the engine's own cost per tick sits far below the 250 millisecond cadence. Plain Python owns everything else: perception, prop logic, ground classes, and speech ranges are closed-form tests on positions, which keeps them exactly reproducible by step 7's stdlib-only helper package. pymunk is version-pinned in `environments/pyproject.toml` and reaches the sandbox image through the existing wheel dependency flow; the template layer and the builtins stay stdlib-only.

The package mirrors the Skirmish at Crane Reach split: `env.py` is the only module importing gymnasium, pettingzoo, or numpy.

| Module | Responsibility |
| --- | --- |
| `rules.json` + `rules.py` | Rule constants and their import-time validating loader |
| `props.json` + `prop_types.py` | The prop catalog and its import-time validating loader |
| `geometry.py` | Closed-form primitives for the non-physics rules: heading wrap and vectors, distance, cone test, segment intersection, point in polygon and rectangle |
| `layout.py` | The static layout types, derived collision chains, ground classifier, and start-pose formulas |
| `fixture.py` | The hand-authored fixture village |
| `generation.py` | `build_village(seed) -> Layout`, the seam step 4 fills; this step's body ignores the seed and returns the fixture |
| `physics.py` | The pymunk space build and the per-tick movement step |
| `perception.py` | Sight, hearing, reed concealment, prop visibility, the bell |
| `prop_use.py` | Use selection, contention, hold and release, transitions |
| `engine.py` | `DayConfig`, character and prop state, `Day.step(orders)` and `Day.perception(id)`: the tick cycle |
| `env.py` | The `ParallelEnv`, `make_env`, `default_action`, spaces, player and character id mapping, chat hooks |
| `overlay.py` | `extract_overlay` and the strict `decode_overlay` authority |
| `observation_types.py` | Stdlib TypedDicts for the observation and action |
| `naive.py`, `scripted_visitor.py` | The two builtins |

### The shared data files

`environments/three_branches/props.json` holds the prop catalog as a `props` array in the ruleset's table order. Each record carries `token`, `title`, `activity`, `states`, `start`, `transition` (`{"kind": "toggle" | "occupancy" | "timed" | "none"}` with `ticks` present exactly for timed), `footprint` (`{"width", "depth"}` in meters), `count`, and `district` (a placement token for step 4's generator). The loader validates snake_case unique tokens, states within the observation charset with `start` among them, the transition shapes with exactly two states for every stateful kind and a resting second-state start for occupancy and timed props, and positive footprints and counts, and exposes `PROP_TYPES` in canonical order plus the derived total; tests pin the shipped values against the ruleset's table and the total at 31.

`environments/three_branches/rules.json` holds the constants both ends draw on: `emotes` (the nine names in action-id order), `ground` (an ordered array of classes, each with a single-character grid code and a speed, and `water` flagged impassable), `profile` (body radius, vision degrees and range, hearing, talk, shout, prop reach, the running threshold), `phases` (contiguous from tick 1 to `day_ticks`), the off-variant phase name, and `day_ticks`. The loader validates exactly nine unique emotes, unique single-character grid codes, positive speeds and profile values, and phase contiguity; tests pin the shipped values against the ruleset's tables.

Both loaders run at import, the way Skirmish at Crane Reach loads `tile_types.json`, and step 3's renderer imports the same two JSON files by relative path. Rule changes become data edits, not parallel code edits on two sides.

### Layout types and the fixture village

`layout.py` defines the static layout in the shape of the observation's `village` Dict: channels (trunk first), road, and footpaths as centerline-and-width polylines, bridges as center, heading, width, and span, buildings as rectangles with a doorway, fields and reed banks as polygons, the 31 props with rotations, scenery circles, and the spawn point. From these it derives, once per layout:

- Wall segments: each building's perimeter with its 1.2 m doorway gap removed, so the doorway edge splits into two segments and a building carries up to five. Movement collision and line of sight use these same segments.
- Water collision geometry: each channel's two bank lines as static segments, solid caps at shared channel endpoints, a gap where a bridge deck crosses, and short rails along the deck sides. Water needs no special rule in the solver; banks and fork caps are ordinary static geometry, and decks are the authored gaps in it.
- The ground classifier `ground_at(point)`, priority highest first: bridge decks (road), water (the channel shapes), road and footpath shapes, field polygons, reed polygons, open. Decks must outrank water and water the road shape, because the 4 to 5 m road is wider than its 2 to 3 m deck where it crosses a channel. The classifier feeds speed limits, the reed and field rules, and the overlay's ground grid; impassability itself is the bank geometry.
- Start poses as formulas, not authored data: each home holds two slots offset 0.6 m either side of its center-to-doorway axis, `npc_i` starts in `home_(i mod 5)` slot `i // 5` facing the doorway, and the visitor starts at the spawn facing along the road.

`fixture.py` hand-authors one complete village. The observation schema fixes the inventory (four channels, seven buildings, 31 props), so the fixture is a full 100 by 100 village with simple geometry rather than a reduced one: the trunk forking near (50, 65) into three channels with mouths at least 20 m apart, the road entering at (0, 25) and crossing each channel once on a bridge, the spawn at (1.0, 25.0), the repair shed and bell on the west stretch, the market with its stalls, crates, board, and lanterns mid-road, the well plaza with pump and benches in the crook of the fork, the inn with hearth and benches on the east stretch, two shrines with roof posts at road bends, home clusters of three and two on the channel banks with garden plots against their walls, two field polygons, at least two reed banks each large enough for two characters, and pine clusters. Exact coordinates are the implementer's, held to the invariant tests: stable features placed once, doorways opening onto walkable ground, one connected walkable region (flood fill over a 0.25 m sampling of the static body-clear test), every prop with a standing position in reach along an unblocked line with room for the body, footprints disjoint, the spawn clear, the road crossing each channel exactly once on a deck, and a bank gap at every deck.

### Physics

Characters are circle bodies of radius 0.4 with infinite moment, zero friction, and zero restitution. Each tick the engine sets a body's velocity to the commanded heading's unit vector times the commanded fraction times the speed limit of the ground class under the body's pre-tick position, steps the space, then zeroes every velocity, so nothing coasts. Contact stops or deflects a mover along the surface; nothing passes through a solid or another character.

- A character commanding speed 0 is immovable for the tick (its body is static for that step): the ruleset's speed 0 turns in place and stays exactly put, movers slide around standers, and a stander is never shoved. Two movers in contact push and slide with equal mass.
- The tick is stepped in 8 substeps, so the largest per-substep displacement (0.125 m) stays safely below wall thickness plus body radius and nothing tunnels. The ground speed limit is sampled once per tick at the pre-tick position, not per substep.
- Static solids: wall segments, the four boundary walls, scenery circles, prop footprint boxes, water bank chains, and shared-endpoint fork caps. A body may overhang the water line by up to its radius, which is intended: it is what lets two characters pass on a 2 m deck.
- After the step the engine reads positions straight from the solver; `moved` is the position-to-position distance. Observations carry float32, and the overlay rounds to centimeters at encode time. There is no intermediate quantization layer.
- Determinism scope: Chipmunk is deterministic for the same build stepping the same operations, so same-process double rollouts and same-platform replays are exact, which is what the determinism tests assert. Cross-platform bit-identity is not promised; committed recordings are replayed, never re-simulated, so nothing depends on it. The engine draws no randomness.

### The tick cycle

`Day.step(orders)` takes a complete character-keyed order map and runs one tick:

1. Degrade commanded values per the ruleset: a heading of 360 wraps to 0, a non-finite heading or speed degrades to heading unchanged or speed 0, and the default order is speed 0, heading unchanged, expression none.
2. Resolve expressions on the pre-tick pose, the same state the observations showed: prop selection, stillness, and availability per the rules below, with same-tick contention going to the first claimant in character order, npc_0 upward and the visitor last. That order is not player order: the visitor is `player_0`, the NPCs occupy `player_1` upward, and the engine works in character ids while the environment owns the mapping.
3. Move everyone together through the physics step.
4. Apply prop transitions for the tick's end: occupancy releases, timed reverts.
5. Advance the tick; perception and the day phase (when daynight is on) are served from the new state.

### Prop use and perception

Prop selection per the ruleset: the nearest prop within 1.5 m reach with an unblocked line, judged on the pre-tick pose, ties broken by canonical prop order, stillness required (commanded speed above 0 resolves the expression to none), a prop already held resolves to none with no fall-through to the second nearest, and the three transition kinds driven by `props.json`: toggle flips only when a use newly begins, occupancy holds exactly while held, and timed refreshes its revert counter every held tick and reverts that many ticks after it was last held. A character holds a use by choosing it again, and releases by choosing anything else, by moving, or by leaving reach.

Perception, all computed from the engine's character positions: the 120 degree cone on the heading out to 12 m with walls-only line blocking (a sight line through a doorway gap is unblocked, and scenery and props never block), hearing at 6 m any facing with an unblocked line, reed concealment (bank identity is the containing reed polygon; a character standing in one is seen only by observers standing in the same one, vision only), prop states under the same cone and line rules, and the bell perceived by everyone while ringing, whatever the distance and whatever stands between.

### Environment and spaces

`env.py` builds the parallel environment on the engine, with the action and observation spaces from the [environment specification](../environment.md). The visitor is `player_0` and `npc_i` is `player_(i+1)`, fixed in two small mapping functions. Spaces are built once in the constructor and shared across players: fixed-count composites as `Tuple` (four channels, seven buildings, 31 props, the roster), variable-count as `Sequence`, Box leaves as 0-dimensional float32 arrays, and Text fields with the charsets and lengths the specification fixes. Both seat plans are declared, cast_5 first as the default: seat_0, the cast, holds `player_1` upward, and seat_1, the visitor, holds `player_0` and is restricted to `scripted_visitor`. Both gameplay parameters, and the six season presets pinned by a literal-table test.

An action outside the space raises naming the player, so the harness attributes the forfeit; values inside the space degrade rather than fail. `default_action` returns the player's current heading, speed 0, action 0. Rewards are 0 every tick and 100 to every player on tick 1200, termination not truncation, `env.agents` empties at the end, and no `result_scores` hook. The reset observation carries tick 1 and the terminal observation keeps tick 1200.

### Speech

The environment ships the two chat hooks; delivery mechanics are all platform. `chat_policy(sender)` lists the characters within 3 m talk range with an unblocked line, nearest first with roster order breaking distance ties, and the nearest as the default recipient. `broadcast_recipients(sender)` bounds an NPC shout to 15 m and the visitor's broadcast to 3 m, unblocked lines, through the step 1 hook. Two timing facts are normative because the harness imposes them: the talk policy is evaluated against the pre-step state, since chat hooks run while actions are collected, and broadcast audiences resolve at end-of-tick state, since delivery happens after the step. The once-per-recipient-per-tick rule is harness-enforced, so the environment supplies ordering only. Watchers receive every delivered message under the platform visibility rule, the cap is 200 code points, and a line recorded on tick T reaches inboxes during T+1 after actions are chosen, so the earliest reaction is tick T+2, as the ruleset states.

### The compact overlay

Self-contained per the design and packed the way Skirmish at Crane Reach packs its overlay: single-character keys, base36 fields, positions in integer centimeters (three characters per coordinate), angles in tenths of degrees (three characters), small lengths in centimeters (two characters), `OVERLAY_VERSION = 1`.

- The static layout section repeats identically in every frame: channels, road, and footpaths as width plus packed points, bridges, the seven buildings in canonical order with ids implicit, the 31 props as position and rotation with footprints implicit through `props.json`, scenery, the spawn, and 100 run-length-encoded ground grid rows (1 m cells sampled at cell centers through the engine's `ground_at`, coded per `rules.json`), which step 3's tile renderer consumes directly.
- The dynamic section: the tick, one 13-character record per character in roster order (x, y, heading, moved, expression id, and the use-target prop index or a none marker), a 31-character prop-state string, and the terminal flag. Bell and phase are derived on decode, from the bell prop's state and from the tick plus the daynight flag.
- `decode_overlay` is the strict authority for replay consumers: exact key sets, record lengths, the fixed counts, coordinate and angle ranges, grid rows summing to 100, and expression and target consistency (a use implies moved 0, no two characters hold one prop), decoding to friendly JSON in meters and words. A terminal frame must name tick 1200. The nonterminal state that offers the final action also names tick 1200, so both consecutive states are valid.

The fixture measurement with the real builtins is 7,644,840 bytes for a recorded cast_10 day against the 10 MiB budget. A full 1,200-transition timing run averaged 2.019 milliseconds per environment transition, with a 3.023 millisecond maximum, a 3.029 millisecond maximum for all charged agent work plus the transition, and a 0.018 millisecond maximum for one agent's combined `act` and optional `chat`. The maximum builtin `reset` was 0.143 milliseconds; reset joins `act` and `chat` only for the per-game total, matching the harness accounting. Step 4 re-measures the generated village; if it breaches the recording budget, the named mitigations are 2 m grid cells and tighter scenery records.

### Metadata and the builtins

`META` per the design's platform metadata table: simultaneous stepping, `recommended_episode_ticks=1200`, a 250 millisecond `pace_interval_ms` and `view_interval_ms`, `human_timeout_ms=None`, `step_limit_ms=250`, `episode_limit_ms=120000`, messaging on with the 200 code point cap, `llm=True`, `human_players` as the single entry `player_0`, and the renderer key `three-branches-village`.

The `naive` builtin plays the default action, the platform baseline. The `scripted_visitor` builtin seeds `random.Random` from the seed its `reset` receives, builds a road-and-footpath waypoint graph from its setup observation, and wanders vertex to vertex at walking speed; on seeing an NPC not on cooldown it approaches, waves once, sends one canned line through the chat hook, lingers a few ticks, replies briefly if answered, sets a cooldown, and resumes; commanded speed with `moved` 0 on two consecutive ticks triggers a short detour heading. All its randomness comes from the reset seed, it holds its own small distance math, and neither builtin imports the engine. Both are staged byte-identically under `backend/images/session-base/deps-v1/builtin/three_branches/` with manifests, guarded by byte-equality tests.

### Registration and the minimal real stubs

Discovery is all-or-nothing: a package under `environments/` is either listed in `.envignore` or subject to the full conformance suite, whose authoring-shape test requires `environment.md`, a renderer with exactly one thumbnail, a template, and at least one example, and whose renderer-ownership test forbids a `renderer/` directory on an ignored package. So the package sits in `.envignore` with no renderer directory while the engine milestones land. The final milestone removes that line and registers a minimal real stub under the production contracts:

- Ship a trivial `renderer/index.ts` with the key `three-branches-village` and a thumbnail. Step 3 replaces it with the real renderer and watch surface. Ship a raw-observation stand-still `template/agent.py` with its README, an embryonic `examples/sweeper/` smoke example, and an `environment.md` factual stub. Step 7 replaces those student-facing stubs behind the same contracts.
- Run `npm run sync:envs` for the pyproject entry point and the backend catalog, add `three_branches` to both hand-listed Dockerfile smoke lines, add `("three_branches", "sweeper")` to the compose inventory pin, and stage the builtin copies.
- The forfeit floor needs no score-module change: `forfeitScore` already returns 0 by default, which is this environment's floor.

### Build order

Seven milestones, each ending green:

1. Data and geometry: the package skeleton behind `.envignore` with pymunk pinned, both JSON files and loaders, `geometry.py` with exhaustive unit tests.
2. Layout and fixture: the layout types, derived walls and bank chains, the ground classifier, the fixture village, the `generation.py` seam.
3. Physics and engine: `physics.py`, `perception.py`, `prop_use.py`, `engine.py`, the full tick cycle on the fixture.
4. Environment: `env.py`, spaces, id mapping, chat hooks, `META`, `ENTRY`, presets, `observation_types.py`. Episode-driven tests construct `ENTRY` directly, so no registration is needed yet.
5. Overlay: the codec, the budget measurement, replay determinism through the harness.
6. Builtins: both agents, staged copies, byte-equality.
7. Registration and conformance: the `.envignore` removal, the minimal real stubs, `sync:envs`, the Dockerfile lines, the compose pin, the full conformance suite green for three_branches defaults, and the cast_10 seconds-per-tick measurement recorded.

## Tests

One file per cluster under `environments/three_branches/tests/`:

- `test_rules_data`: both loaders reject malformed documents, shipped values pinned against the ruleset's tables, the prop total pinned at 31.
- `test_geometry`: the closed-form primitives, cone and intersection edges, polygon containment.
- `test_layout_fixture`: every fixture invariant, wall segments with doorway gaps, bank chains with deck gaps, ground classifier spot pins (deck over water, path through reeds), grid sampling.
- `test_physics`: sliding contact, speed-0 immobility (a stander is never displaced), no tunneling at maximum speed, deck crossing, bank blocking, doorway passage, ground speed limits per class, boundary confinement, heading 360 wrapping, the default order.
- `test_engine_props`: selection, the reach edge, canonical-order ties, stillness, contention in character order, hold and release, toggle without retoggle, occupancy, timed refresh and reverts at the table's counts, the stateless board.
- `test_engine_perception`: cone edges, wall blocking and doorway sight, hearing edges, reed same-bank and cross-bank, the bell everywhere, prop visibility, phases with daynight on and off.
- `test_environment`: spaces built once, `observation_space.contains` across a full episode, reset and step mappings covering the roster exactly, rewards and termination on tick 1200, `default_action`, the preset literal table, use selection through `env.step`, an out-of-space action raising with the player named, the id mapping, and one cast member's crash forfeiting the whole cast seat at floor 0 through an Episode.
- `test_chat`: policy ordering and default, broadcast bounds for NPC and visitor, wall-blocked speech, the cap, and delivery timing through the harness (a line on tick T readable during T+1, first reaction T+2).
- `test_overlay`: encode and decode round trips, each malformed field rejected, the static section byte-identical across frames, and decoder isolation from consumer mutations.
- `test_builtins`: naive plays the default action, staged copies byte-equal for both builtins, neither imports the engine or any third-party package, and the scripted visitor is deterministic per seed, wanders, approaches, and speaks its canned lines.
- `test_budget`: full cast_5 and cast_10 days each produce 1,201 recording frames inside the 10 MiB budget and replay identically from the same seed. Each real builtin's combined `act` and optional `chat` fit the per-step budget, while `reset`, `act`, and `chat` together fit the per-game budget. Each tick's serial charged agent work and engine transition must stay below the 250 millisecond cadence; reset is not part of a gameplay tick.

The shared conformance suite (`parallel_api_test`, the platform's stricter parallel subset, deterministic seeded rollouts, metadata round-trip) covers the rest automatically once the package is discovered.

## Done when

Full cast_5 and cast_10 days run through the harness on the fixture village, record inside budget, and replay identically, the conformance suite is green for three_branches defaults, and the registration milestone has landed whole: catalog entry and minimal real stubs, Docker smoke lines, and staged builtins.
