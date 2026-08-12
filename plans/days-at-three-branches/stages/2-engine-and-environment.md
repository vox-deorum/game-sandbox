# Step 2: Engine and environment

Status: complete.

Part of [the plan](../README.md). This step ships the Three Branches Python engine, a mechanics-first fixture village, the PettingZoo environment, recording overlays, builtins, and the minimum registered authoring surface. The fixture is a stable engine test input until step 4 replaces production layout generation.

## Implementation

- `rules.json` and `catalog.json` load into frozen data records with strict unknown-key rejection. Ground codes are `r`, `p`, `b`, `g`, `i`, `d`, `f`, `e`, `w`, and `x`.
- `Layout` is immutable and `Day` is the only mutable game state. Module-level grid, geometry, perception, and prop functions hold the rules without extra framework layers.
- `build_village(seed)` currently returns a fresh mechanics-first fixture and deliberately ignores its seed. The fixture has three channels, road bridges, every building and prop type, five homes, paths, scenery, visitor spawn, and residence poses.
- Pymunk owns collision. Characters have mass 1, infinite moment, zero friction, and zero restitution. A zero-speed character is kinematic for the tick. The selected substep count is the smallest one that passes the no-tunnelling check.
- The engine resolves each parallel tick from one pre-tick state: command degradation, expression and prop candidates, simultaneous movement, contention and transitions, time advance, then perception.
- `env.py` alone imports Gymnasium, PettingZoo, and NumPy. It builds spaces once, emits isolated plain observations, implements both seat plans, rewards, termination, chat hooks, and overlay extraction.
- `naive` and `scripted_visitor` are stdlib-only state machines. Production runs use fresh entropy. Their recorded actions remain an exact replay source with a fixed layout on the same build.
- Registration includes a neutral temporary renderer that displays only the environment title and tick, a placeholder thumbnail, a stand-still raw-observation template, the internal `sweeper` example, canonical guide, Docker smoke coverage, and compose inventory. Step 3 replaces the renderer and step 7 replaces the student stubs.

## Lean tests

Keep six contract-focused modules. Do not add suites for private helpers, literal fixture coordinates, every malformed-field permutation, repeated space containment, or framework behavior already covered elsewhere.

| Module | Coverage |
| --- | --- |
| `test_data_and_math.py` | Shipped data, representative invalid data, grid conversion, raycasts, headings, distances, and cone boundaries. |
| `test_layout_and_physics.py` | Fixture guarantees, shapes, clearance, wall and corner sliding, pushing, zero-speed immobility, boundaries, and no tunnelling. |
| `test_engine.py` | One table-driven case per transition, contention, perception, doors, bell, phases, and tick order. |
| `test_environment_and_chat.py` | Plans, spaces, mappings, defaults, invalid actions, terminal rewards, recipient policy, and message timing. |
| `test_overlay_and_builtins.py` | Overlay shape and rounding, builtin behavior with controlled test entropy, stdlib-only imports, and staged byte equality. |
| `test_full_day.py` | One cast_5 and one cast_10 day, observation containment, size report, budget compliance, and replay from captured actions. |

Run Ruff, Python and TypeScript CI, generated-code checks, examples, documentation checks, Docker integration, shared conformance, and the complete browser suite before handoff.

## Done

The fixture engine completes cast_5 and cast_10 days. Fixed layout plus fixed actions replay identically on the same build. The registered package, Docker image, compose inventory, stubs, and staged builtins are present.
