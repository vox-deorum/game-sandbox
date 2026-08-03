# Step 1: Rules Engine

Status: complete.

Part of [the Skirmish at Crane Reach plan](../README.md). This is build-order step 1: the complete [ruleset](../ruleset.md) as pure, heavily tested Python, with every variant and reproducible results for a seed and scripted orders. No PettingZoo, Gymnasium, or harness imports. The hands-on surface is a seeded scripted match runner on the command line.

## Why this is its own seam

Everything above the engine, the environment wrapper, the overlay, the renderer's legality checks, the helpers, and the builtin consumes rules that must already be exact. Building the rules pure first means the hardest correctness work (battlefield guarantees, activation resolution, scoring formulas) is tested without any platform machinery in the loop, and the AEC wrapper in step 2 stays a thin adapter.

## What to build

The package directory `environments/skirmish_crane/` is created here and added to `environments/.envignore`, the mechanism `local_play/` uses, so the platform installs it without treating it as a publishable environment until step 3. Regenerate with `npm run sync:envs` so the wheel-packages block includes it while the entry points do not.

Modules are flat top-level files, because template composition (`scripts/_envs.py::_template_spec`) ships only top-level package files to students:

| Module | Owns |
| --- | --- |
| hexes.py | Axial (q, r) coordinates, the on-field predicate R <= q + r <= 3R, the six direction deltas in digit order, hex distance, neighbors, the square tile array with void outside the hexagonal field |
| paths.py | The canonical path codec for ids 0 through 1554 |
| battlefield.py | Seeded generation under the ruleset guarantees |
| movement.py | Path legality and walking |
| combat.py | Strike resolution and damage |
| scoring.py | Capture scoring, end conditions, 0-100 team scores |
| engine.py | Rounds, activation order, order application, perception |
| ascii_runner.py | The dev-only terminal runner and renderer described below |

### Hex geometry

One module owns the geometry. Directions are numbered 1 through 6 clockwise from northeast, and a direction's opposite is found by adding 3 and wrapping 7, 8, and 9 back to 1, 2, and 3. Point rotation keeps the path order and opposes every direction. Retracing reverses the path order and opposes every direction, so `[1, 2]` retraces as `[5, 4]`. Distance is hex distance, (|dq| + |dr| + |dq + dr|) / 2. The field of radius R holds 3R^2 + 3R + 1 tiles inside a square array of side 2R + 1; cells outside the hexagon are terrain void, impassable, and never occur inside the field.

### Path ids

`encode_path` maps the empty path to 0 and every sequence of one through four directions to ids 1 through 1554 (6 + 6^2 + 6^3 + 6^4 = 1554), ordered by length and then lexicographically with the last direction varying fastest. The top id is derived from the step limit rather than written down, so the two cannot drift. `decode_path` is its inverse. Both reject invalid values with `ValueError`. The encoding is part of the stable student contract, so it is pinned here before any consumer exists. The template helper in step 6 owns the matching public implementation and pins it against this codec.

### Battlefield generation

Generation is constructive rather than check-and-reject: generate one half, point-reflect through (q, r) to (2R - q, 2R - r), and the symmetry guarantee holds by construction. Water passages are carved first so their count (2 or 3) and width (2 to 4) hold by construction; hills, forests, and marshes scatter on the half and mirror. Spawns mirror each other. Capture zones are seven-tile blocks (a passable center plus its six passable neighbors) placed as one central zone plus mirrored pairs. Chosen centers are kept at least 3 apart in hex distance, which is exactly the threshold that keeps two seven-tile footprints disjoint, so no unit can ever stand in two zones and score both in one round. Turning capture zones on forces three passages, because only the three-wide central gap keeps the middle tile passable and an odd zone count always needs a central zone there. Connectivity of passable tiles is verified by flood fill, with a bounded, seed-deterministic redraw loop when a draw fails.

A generated battlefield is immutable. It stores the square grid directly as `tiles[r][q]`, the same shape participants receive through perception, with void outside the hexagon; spawns are an immutable mapping keyed by side. There is no separate mutable tile dictionary to drift from the grid.

### Order resolution

One order is a path of at most four steps, possibly empty, plus optionally one named enemy target. The engine resolves the walk and strike as one activation:

- The walk checks the path step by step from full movement points: a step needs an empty passable tile and enough unspent points, the first step is always permitted at full points, and a negative balance ends the path. That step-by-step walk is the single authority on legality. Applying an order asks it directly and reports an unwalkable path from the error it raises. Perception separately enumerates every walkable path, because the ruleset requires the observation to advertise them, but that enumeration never decides whether a submitted order is legal.
- The strike resolves from the final tile. The named target is struck if it is alive, was visible at activation, and is within attack range of the final tile. Otherwise the unit strikes an enemy drawn uniformly from the in-range enemies at minimum hex distance, using the match-play stream. No enemy in range means no strike; the strike is otherwise mandatory.
- Damage stacks in a fixed order: charge, hill up and down, forest cover, shield wall, floor of 1. Charge is same-activation: a cavalry move whose start and end tiles are at hex distance 3 or more adds 2 damage to that activation's strike. A killed unit is removed immediately and never activates later in the round.
- The scorer names the terminal condition. Elimination outranks a capture win and the round cap, so the caller reports which conditions were met and the scoring module decides the reason from them. Nothing else computes a reason string.

### Randomness and determinism

The match seed derives two independent RNG streams: battlefield generation and match play. The match-play stream supplies per-round activation shuffles and automatic-strike draws in execution order. An automatic strike can change later match-play draws. Scripted orders with the same seed replay the same battle. Builtin agents may make their own random choices, so their exact decisions are not part of this engine guarantee.

### ASCII runner

A small dev-only runner plays scripted sides and prints the field round by round. It is the step's hands-on surface and stays useful later for replaying recordings in a terminal.

## Tests

Pure pytest under `environments/skirmish_crane/tests/`, no Docker, no DB:

- Battlefield guarantees swept over field_extent 5 through 22, all variant combinations, and a seed batch: 180-degree symmetry, one connected passable region, passage count and width, zone placement on passable tiles at every declared count, and no two zones sharing a tile.
- The complete path codec: literal vectors ([] = 0, [northeast] = 1, [northwest] = 6, [northeast, northeast] = 7, [northwest x4] = 1554), every id from 0 through 1554 round-tripped, and invalid values rejected with `ValueError`.
- Movement matrices: the always-permitted first step, cost accounting into negative balance, occupied and impassable rejections, the four-step limit.
- Strike resolution: named-target priority, the automatic draw at minimum distance, mandatory strike, no strike out of range, visibility checked at activation, and execution-order use of the match-play stream.
- The damage truth table across charge, hill, forest, and shield wall, including the floor of 1 and the charge displacement rule.
- Capture scoring: sole occupancy earns 1, contested and empty earn nothing, seven-tile membership.
- All four end-condition score formulas pinned against hand-worked totals, elimination and capture, wins, losses, and draws, including the round-cap tiebreaks. Elimination landing on the capped round is covered in both modes, since it must score and name itself as elimination rather than as the round cap.
- Randomness and determinism: identical replay from a fixed seed and scripted orders, battlefield generation does not consume match-play draws, and an automatic strike can affect a later match-play draw.
- Perception: the observation advertises the same walkable paths and nameable targets the engine will accept, and every structure it hands out is immutable, so a participant cannot write back into match state.
- The messages flag is inert at this stage: orders carry no message field, and a match plays out identically with the flag on and off.
- A killed unit is skipped for the rest of the round, while the initial rosters still list it and remain immutable.

## Done when

A seeded scripted match runs to completion at both compositions (1-1-1 and 8-6-6) with every variant on, prints round by round in ASCII, and replays identically from the same seed. The test suite above is green. The package is installed but ignored: it appears in the wheel-packages block and not in the entry points, and the shared conformance suite does not see it.
