# Step 1: Rules Engine

Status: planned.

Part of [the tactical game plan](../README.md). This is build-order step 1: the complete [ruleset](../ruleset.md) as pure, heavily tested Python, with every variant, deterministic from a seed. No PettingZoo, Gymnasium, or harness imports. The hands-on surface is a seeded ASCII match runner on the command line.

## Why this is its own seam

Everything above the engine, the environment wrapper, the overlay, the renderer's legality checks, the helpers, and the builtin, consumes rules that must already be exact. Building the rules pure first means the hardest correctness work (battlefield guarantees, walk-then-strike resolution, scoring formulas) is tested without any platform machinery in the loop, and the AEC wrapper in step 2 stays a thin adapter.

## What to build

The package directory `environments/tactical_game/` is created here and added to `environments/.envignore`, the mechanism `local_play/` uses, so the platform installs it without treating it as a publishable environment until step 3. Regenerate with `npm run sync:envs` so the wheel-packages block includes it while the entry points do not.

Modules are flat top-level files, because template composition (`scripts/_envs.py::_template_spec`) ships only top-level package files to students:

| Module | Owns |
| --- | --- |
| hexes.py | Axial (q, r) coordinates, the on-field predicate R <= q + r <= 3R, the six direction deltas in digit order, hex distance, neighbors, the square tile array with void outside the hexagonal field |
| paths.py | The canonical decode_path(id) for ids 1 through 1554 |
| battlefield.py | Seeded generation under the ruleset guarantees |
| movement.py | Path legality and walking |
| combat.py | Strike resolution and damage |
| scoring.py | Capture scoring, end conditions, 0-100 team scores |
| engine.py | Rounds, activation order, order application, perception |

### Hex geometry

One module owns the geometry. Directions are numbered 1 through 6 clockwise from northeast, so reversing a path adds 3 to each digit modulo 6. Distance is hex distance, (|dq| + |dr| + |dq + dr|) / 2. The field of radius R holds 3R^2 + 3R + 1 tiles inside a square array of side 2R + 1; cells outside the hexagon are terrain void, impassable, and never occur inside the field.

### Path ids

decode_path maps ids 1 through 1554 to every sequence of one through four directions (6 + 6^2 + 6^3 + 6^4 = 1554), ordered by length and then lexicographically with the last direction varying fastest. The encoding is part of the stable student contract, so it is pinned here with literal vectors before any consumer exists; the template helper in step 6 owns the matching encoder and pins against this decoder.

### Battlefield generation

Generation is constructive rather than check-and-reject: generate one half, point-reflect through (q, r) to (2R - q, 2R - r), and the symmetry guarantee holds by construction. Water passages are carved first so their count (2 or 3) and width (2 to 4) hold by construction; hills, forests, and marshes scatter on the half and mirror. Spawns mirror each other. Capture zones are seven-tile blocks (a passable center plus its six passable neighbors) placed as one central zone plus mirrored pairs. Connectivity of passable tiles is verified by flood fill, with a bounded, seed-deterministic redraw loop when a draw fails.

### Order resolution

One order is a path of at most four steps, possibly empty, plus optionally one named enemy target. Resolution is walk, then strike:

- The walk checks the path step by step from full movement points: a step needs an empty passable tile and enough unspent points, the first step is always permitted at full points, and a negative balance ends the path.
- The strike resolves from the final tile. The named target is struck if it is alive, was visible at activation, and is within attack range of the final tile. Otherwise the unit strikes an enemy drawn uniformly, from the match seed, among the in-range enemies at minimum hex distance. No enemy in range means no strike; the strike is otherwise mandatory.
- Damage stacks in a fixed order: charge, hill up and down, forest cover, shield wall, floor of 1. Charge is same-activation: a cavalry move whose start and end tiles are at hex distance 3 or more adds 2 damage to that activation's strike. A killed unit is removed immediately and never activates later in the round.

### Determinism

Three independent seed-derived RNG streams: battlefield generation, per-round activation draws, and automatic-strike draws. Variant toggles never perturb activation order, and an extra strike never shifts a later draw. The same seed and the same decisions replay the identical battle.

### ASCII runner

A small dev-only runner plays scripted sides and prints the field round by round. It is the step's hands-on surface and stays useful later for replaying recordings in a terminal.

## Tests

Pure pytest under `environments/tactical_game/tests/`, no Docker, no DB:

- Battlefield guarantees swept over field_extent 5 through 22, all variant combinations, and a seed batch: 180-degree symmetry, one connected passable region, passage count and width, zone placement on passable tiles at every declared count.
- decode_path pinned with literal vectors ([northeast] = 1, [northwest] = 6, [northeast, northeast] = 7, [northwest x4] = 1554) and structural properties (ordering, length blocks).
- Movement matrices: the always-permitted first step, cost accounting into negative balance, occupied and impassable rejections, the four-step limit.
- Strike resolution: named-target priority, the automatic draw at minimum distance, mandatory strike, no strike out of range, visibility checked at activation.
- The damage truth table across charge, hill, forest, and shield wall, including the floor of 1 and the charge displacement rule.
- Capture scoring: sole occupancy earns 1, contested and empty earn nothing, seven-tile membership.
- All four end-condition score formulas pinned against hand-worked totals, elimination and capture, wins, losses, and draws, including the round-cap tiebreaks.
- Determinism: identical replay from a fixed seed, and stream independence (toggling terrain does not change round 1's activation order).

## Done when

A seeded scripted match runs to completion at both compositions (1-1-1 and 8-6-6) with every variant on, prints round by round in ASCII, and replays identically from the same seed. The test suite above is green. The package is installed but ignored: it appears in the wheel-packages block and not in the entry points, and the shared conformance suite does not see it.
