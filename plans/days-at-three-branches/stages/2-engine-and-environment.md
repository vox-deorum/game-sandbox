# Step 2: Engine and environment

Status: complete.

Part of [the plan](../README.md). This step ships the Three Branches Python engine, a mechanics-first fixture village, the PettingZoo environment, recording overlays, builtins, and the minimum registered authoring surface. The fixture is a stable engine test input until step 4 replaces production layout generation.

## Implementation

- `rules.json` and `catalog.json` load into frozen data records through the shared checks in `validation.py`, with strict unknown-key rejection. Ground codes are `r`, `p`, `b`, `g`, `i`, `d`, `f`, `e`, `w`, and `x`, and everything downstream reads that list rather than restating it. A cell measures one metre, which loading enforces, because layout shapes and poses use a cell index as a coordinate. A prop that transitions carries exactly two states, so its active state is always the other one.
- `Layout` is immutable and `Day` is the only mutable game state. Module-level grid, geometry, perception, and prop functions hold the rules without extra framework layers. A layout derives its blocked rectangles and solid shapes once, when it is built.
- Engine, PettingZoo, observations, chat, props, and recording overlays share one identity space. `player_0` is the visitor, and `player_1` through `player_n` are the cast. No character-id translation exists.
- `build_fixture()` returns a fresh mechanics-first fixture with three channels, road bridges, every building and prop type, five homes, paths, scenery, visitor spawn, and residence poses. It is the engine, physics, and perception test map. Step 4 owns `build_village(seed)`, which generates the village a match plays on.
- Pymunk owns collision. Characters have mass 1, infinite moment, zero friction, and zero restitution. A zero-speed character is kinematic for the tick. The selected substep count is the smallest one that passes the no-tunnelling check, and the space states its contact correction rate for that substep so separation cannot carry a body further than a command could.
- The engine resolves each parallel tick from one pre-tick state: command degradation, expression and prop selection, simultaneous movement, prop transitions, time advance, then perception. Selection names the tick's one user per prop, in roster order with the visitor first, and that single record drives the transitions.
- `env.py` alone imports Gymnasium, PettingZoo, and NumPy. It builds spaces once from the rules and catalog, dresses the perceptions the engine returns rather than recomputing them, implements both seat plans, rewards, termination, chat hooks, and overlay extraction. Each observation gets its own mappings, so no player can reach another's; the ground rows are immutable strings and are shared.
- `naive` and `scripted_visitor` are stdlib-only state machines. Production runs use fresh entropy. Their recorded actions remain an exact replay source with a fixed layout on the same build.
- Registration includes a neutral temporary renderer that displays only the environment title and tick, a placeholder thumbnail, a stand-still raw-observation template, the internal `sweeper` example, canonical guide, Docker smoke coverage, and compose inventory. Step 3 replaces the renderer and step 7 replaces the student stubs.

## Lean tests

Keep six contract-focused modules. Do not add suites for private helpers, literal fixture coordinates, every malformed-field permutation, repeated space containment, or framework behavior already covered elsewhere.

| Module | Coverage |
| --- | --- |
| `test_data_and_math.py` | Shipped data, representative invalid data, grid conversion, raycasts, wrapping, distances, and cone boundaries. |
| `test_layout_and_physics.py` | Fixture guarantees, shapes, clearance, wall and corner sliding, pushing, zero-speed immobility, boundaries, and no tunnelling. Tests place characters through `Day.place`. |
| `test_engine.py` | One table-driven case per transition, contention, perception, doors, bell, phases, and tick order. |
| `test_environment_and_chat.py` | Plans, spaces, canonical player ids, defaults, invalid actions, terminal rewards, recipient policy, and message timing. |
| `test_overlay_and_builtins.py` | Overlay shape and rounding, builtin behavior with controlled test entropy, stdlib-only imports, and staged byte equality. |
| `test_full_day.py` | One cast_5 and one cast_10 day, observation containment, size report, budget compliance, and replay from captured actions. |

Run Ruff, Python and TypeScript CI, generated-code checks, examples, documentation checks, Docker integration, shared conformance, and the complete browser suite before handoff.

## Done

The fixture engine completes cast_5 and cast_10 days. Fixed layout plus fixed actions replay identically on the same build. The registered package, Docker image, compose inventory, stubs, and staged builtins are present.
