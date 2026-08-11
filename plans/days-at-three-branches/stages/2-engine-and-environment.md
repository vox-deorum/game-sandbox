# Step 2: Simulation engine and PettingZoo environment

Status: planned.

Part of [the plan](../README.md). This step implements [the ruleset](../ruleset.md) on the grid [village.md](../village.md) defines, with the PettingZoo environment, metadata, and two builtins on a hand-authored fixture until step 4 supplies generated villages. Full cast_5 and cast_10 harness days record to JSONL and replay identically.

## Scope

The engine is the physics and rules authority. The environment is the face used by the harness, recorder, backend, and web app. Step 7 pins its helpers to this implementation, not a second rule implementation.

`pymunk` owns movement. `physics.py` builds one static `pymunk.Space` from the layout at reset and advances it once per tick. Plain Python owns perception, prop logic, ground classes, and speech range. Step 7 helpers, builtins, and template code are stdlib-only. `pymunk` is pinned in `environments/pyproject.toml` and reaches the sandbox through the wheel-dependency flow. `env.py` is the only module importing gymnasium, pettingzoo, or numpy.

The engine models the map and characters as follows:

- Grid cells carry speed, passability, and sight. Water and building walls become deterministic coalesced collision rectangles. Sight walks the grid using each class's `blocks_sight` flag.
- Interactive props and scenery use their catalog box or inscribed-circle shapes. Layout, use selection, perception, the renderer, and clearance helpers resolve those shapes from the type token.
- Characters are circles, with pushing and sliding resolved by Chipmunk.

| Module | Responsibility |
| --- | --- |
| `rules.json`, `rules.py` | Frame, ground classes, emotes, profile, phases, day length, physics substeps, and validating loader |
| `catalog.json`, `catalog.py` | Building, interactive-prop, and scenery catalogs, validating loader, and four transition kinds |
| `grid.py`, `geometry.py` | Grid arithmetic, flood and supercover raycast; headings, vectors, distances, nearest points, and vision cones |
| `layout.py`, `fixture.py` | `Layout`, site painting, static collision model, queries, start poses, and the hand-authored village |
| `generation/` | `build_village(seed) -> Layout`; step 4 fills this seam |
| `physics.py`, `perception.py`, `prop_use.py`, `engine.py` | Movement, perception, prop use, and `Day` state and ticks |
| `env.py`, `overlay.py`, `observation_types.py` | `ParallelEnv`, factory, spaces, player mapping, direct-recipient policy, broadcast hook, recording extraction, and stdlib TypedDicts |
| `naive.py`, `scripted_visitor.py` | Shipped builtins |

## Data, layout, and engine

`rules.json` and `catalog.json` are import-time-validated shared data files that the renderer reads by relative path. `rules.json` contains the village frame, ordered ground records and fill class, emote order, character profile, contiguous phases, off-variant phase, day length, and substeps. Its loader validates positive dimensions and profile values, unique valid grid codes, an existing passable fill class, an impassable class, nine unique emotes, and contiguous phases.

`catalog.json` carries ordered templates and prop types, their identities, footprints, placement data, ground classes, states, transitions, and collision shapes. Its loader validates unique snake_case tokens, positive fitting shapes, valid states and transitions, valid interior props, and known ground classes. [ruleset.md](../ruleset.md) is the human-readable catalog authority. `catalog.py` maps toggle, occupancy, timed, and none to begin, hold, release, and tick functions. The generation package validates `generation.json`, which [village.md](../village.md#generation-tuning) owns.

`Grid` stores frame and ground rows, and provides cell and point conversion, bounds, neighbours, flood fill, and supercover raycasts without attaching meaning to codes. `Layout` is the sole site-painting boundary. From base grid, semantic buildings, props, scenery, and spawn it derives coalesced `blocked` rectangles, catalog-driven `solids`, and distinct prop `occupancy`. It exposes `ground_at`, `body_clear`, `doorway`, and residence start poses. `fixture.py` supplies ASCII land plus semantic placements; invariant tests hold its implementer-chosen cells to [village.md](../village.md).

Physics uses infinite-moment, zero-friction, zero-restitution character circles; four boundaries; and static ground and catalog solids. Per tick, it applies commanded heading and fraction to the pre-tick ground speed, advances `physics.substeps`, then clears velocity. Speed zero makes a character static for that tick: it turns in place and cannot be displaced. Movers have equal mass. The shipped substep count is the smallest that passes a maximum-speed, thinnest-solid no-tunnel test. Solver positions are float32 in observations; recording rounds only at encoding. Same-build rollouts and same-platform replays are exact. Cross-platform bit identity is not promised. The engine draws no randomness.

`Day.step(orders)` degrades commands, resolves expression eligibility and prop candidates from the pre-tick state, moves everyone together, resolves character-order prop contention and end-of-tick transitions, then advances the tick and serves the new perception and optional phase. `prop_use.py` and `perception.py` implement [the ruleset's](../ruleset.md#actions) use and perception contracts. A held prop has no fall-through target, walls block sight and hearing, props and scenery block neither, and everyone perceives the bell.

## Environment, recording, and builtins

`env.py` implements the parallel environment and spaces from [environment.md](../environment.md). Player and character indices match: the visitor is `player_0`, character 0; `npc_i` is `player_(i+1)`, character i+1. It builds fixed spaces once from resolved data, retains an immutable village snapshot, and projects isolated plain observation `Dict`s. Both seat plans ship, with cast_5 default: cast seat_0 owns `player_1` onward; visitor seat_1 owns `player_0` and is restricted to `scripted_visitor`. The six season presets use a literal-table test.

Out-of-space actions raise with player attribution. In-space values degrade. `default_action` keeps current heading, speed 0, action 0. Rewards are zero before tick 1200 and 100 to every player at tick 1200. The episode terminates, clears `env.agents`, and has no `result_scores` hook. Reset reports tick 1 and the terminal observation tick 1200.

Each message is either a range-limited broadcast or names one addressee. `env.py` implements both hooks. `chat_policy(sender)` offers player targets within hearing range and an unblocked line, with broadcast as the default `None`; it reads the pre-step policy state. `broadcast_recipients(sender)` applies the same range and line checks to the end-of-tick audience state. The 200-code-point cap applies to every message. Platform limits permit one broadcast and one direct message per allowed target. A line at T reaches inboxes during T+1 after actions; T+2 is the earliest response. Watchers and replay receive every delivered line. A visitor controller receives broadcasts delivered to `player_0` and direct lines sent to or from `player_0`.

`overlay.py` implements the static header and dynamic overlay specified in [environment.md#recording](../environment.md#recording). `extract_overlay_static` writes the observation-shaped village once at reset. `extract_overlay` writes each transition's tick, phase, ordered character pose and expression records, interactive-prop states, and terminal flag. It applies the specified rounding. The recording milestone adds a size report. The provisional 10 MiB environment target remains documented in `environment.md`; it is not a test or acceptance limit.

`META` follows [environment.md](../environment.md#platform-metadata): simultaneous stepping, 1200 recommended ticks, 250-millisecond pace and view intervals, no human timeout, 250-millisecond step limit, 120000-millisecond episode limit, 200-code-point messaging, LLM support, `player_0` as human player, and renderer key `three-branches-village`.

`naive` runs a seeded walk: it follows its spawn heading, changes heading at seeded intervals, and turns after a stalled command. It never uses props, emotes, or speech. `scripted_visitor` seeds `random.Random` in `reset`, wanders without getting stuck, approaches a seen NPC, waves, addresses that NPC with a canned line where appropriate, lingers, briefly replies to its interlocutor, and moves on. It repeats for a seed and stays within the per-game budget. Both keep their own small movement maths, do not import the engine, and are staged byte-identically under `backend/images/session-base/deps-v1/builtin/three_branches/` with manifests.

## Registration and milestones

Until the last milestone, the package is in `.envignore` with no renderer directory. Discovery requires the full authoring shape and forbids a renderer on an ignored package. Registration removes that line and ships the minimal real contracts: a `three-branches-village` `renderer/index.ts` and thumbnail; stand-still raw-observation template and README; `examples/sweeper/`; factual `environment.md`; and explicit `PUBLISHED_EXAMPLES = ()`. Step 3 replaces the renderer, and step 7 replaces the student-facing stubs.

Run `npm run sync:envs`, add `three_branches` to both Dockerfile smoke lists, add `("three_branches", "sweeper")` to the compose inventory pin, and stage builtin copies. The existing default `forfeitScore` of 0 is the environment's floor.

1. Add the ignored package skeleton, pinned pymunk, data loaders, transition table, grid, and geometry.
2. Add layout, site painting, static model, fixture, and fixture-returning generation seam.
3. Add physics, perception, prop use, and the fixture `Day`.
4. Add environment, spaces, mapping, direct-recipient policy, broadcast hook, metadata, entry, presets, and observation types. Episode tests construct `ENTRY` directly.
5. Add overlay extraction, the size report, and harness replay determinism.
6. Add builtins, staged copies, and byte-equality checks.
7. Register, add minimal stubs and inventory wiring, run conformance, and record cast_10 seconds per tick.

## Tests

All village tests take an explicit layout, and placement tests derive positions at runtime.

| Suite | Coverage |
| --- | --- |
| `test_rules_data`, `test_grid`, `test_geometry` | Reject malformed data, pin shipped tables, grid conversion, bounds, walks, flood and supercover edge cases, headings, distances, nearest points, and cone edges |
| `test_layout_fixture` | Village invariants, site painting, deterministic blocked union, one catalog shape per prop and scenery item under every facing, distinct occupancy, interior floors, ground and clearance probes beside box and circle props, doorways, and start poses |
| `test_physics` | Wall, corner, and circle sliding; speed-zero immobility; maximum-speed tunnelling; crossings, water, angled doorways, and boundaries; ground speeds, heading 360, and default order |
| `test_engine_props`, `test_engine_perception` | Selection, reach edge, canonical-order ties, stillness, visitor-first contention, hold and release, toggle without retoggle, occupancy, timed refresh and reverts, and stateless board; cone and hearing edges, walls and doors, non-blocking props, bell, prop visibility, and daynight variants |
| `test_environment`, `test_chat` | Stable spaces, full-episode containment, isolated observations, complete reset and step mappings, visitor-first roster, tick-1200 rewards and termination, defaults, literal presets, runtime-found use point, player-named invalid actions, mapping, and cast-seat floor-0 forfeit; pre-step direct-recipient policy and broadcast default, end-of-tick broadcast bounds, hearing-edge and wall changes, direct and broadcast delivery and visibility for watchers and visitor controllers, 200-code-point cap, independent message limits, and T/T+1/T+2 delivery timing |
| `test_overlay`, `test_builtins`, `test_budget` | Static village equality, ordered characters, all prop states, encode rounding, terminal-only flag, and no repeated village; builtin determinism, stalls, movement, approaches, waves, speech, staged byte equality, and no engine or third-party imports; JSONL line count, replay identity, reported cast_10 size, agent budgets, and serial-work-plus-engine cadence |

The shared conformance suite also runs parallel API checks, the stricter parallel subset, deterministic seeded rollouts, and metadata round trips once discovery is enabled.

## Done when

Full cast_5 and cast_10 fixture days run through the harness and replay identically. Grid arithmetic passes at the shipped frame, conformance is green for three_branches defaults, and registration, Docker, compose, stubs, and staged builtins have all landed.
