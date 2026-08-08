# Step 7: Season 4 Starter Tactical Blocks

Status: complete.

Part of [the Skirmish at Crane Reach plan](../README.md). This is build-order step 7 and the closing step: the predefined tactical block library that [pedagogy.md](../pedagogy.md) promises as Season 4's on-ramp. It ships in two layers: atomic helper additions to the template's `sandbox/crane/` package, and `banner`, a worked example carrying the block library and a placeholder assignment. The hands-on surface is a block-driven side maneuvering coherently in the browser.

## Why this is its own seam

Season 4's design issue is decentralized strategy as assignment: each unit instance selects a tactical block and a goal. The starter blocks give that strategic layer a working action space on day one of the season, and they are student-facing library code with their own interface contract and quality bar, distinct from the helpers they build on.

## The agent the library serves

Season 4 runs the army seat plan, 8 footmen, 6 archers, and 6 cavalry per side, on a field of extent 10 with terrain and abilities on, one capture zone at the field center (the center tile plus its six neighbors), a capture target of 200, and a round cap of 1000.

A working Season 4 agent is, per unit instance: re-evaluate its (block, goal) pair every few rounds by shallow lookahead, coordinate through observation, stable roster ids, and delayed messages, and let the chosen block produce each activation's order. Its match arc names every block the library needs:

1. **Opening.** Everyone converges on the zone: footmen head for zone tiles, archers for a standoff ring behind them, cavalry swings wide. Blocks: `advance` for plain closing, `flank` for closing while ending out of enemies' likely strike range.
2. **Contact.** Footmen enter and hold the zone, bracing shield walls, since adjacency to an allied footman gives 1 less damage taken and charge immunity. Archers hold the range-6 band, stepping back as enemies close. Cavalry takes displacement-3 lanes when the +2 charge bonus actually lands. Blocks: `capture`, `shield_wall`, `kite`, `charge`, and `hold_ground` for guarding a point that is not the zone.
3. **Attrition.** Wounded units disengage toward safety, cavalry alternates strike and withdrawal, striking only when no other enemy can answer at the landing tile, and footmen interpose between enemy runners and the archers. Blocks: `fall_back`, `harass`, `screen`.
4. **Endgame.** The zone scores only when exactly one side stands in it, so hold it alone when uncontested and step in to deny it when the enemy holds it. Block: `capture`, which gets a unit onto the ground and keeps it there. Reading who else is standing in the zone, and deciding when denying it is worth more than holding somewhere else, is the assignment layer's call, which is what `zone.occupants` is in the helper package for.

The arc describes the student's search agent. The shipped example wires a static placeholder assignment through the same interface, so the slot the search fills stays visible and replaceable.

## What to build

### Template helper additions

New atomic helpers in `template/sandbox/crane/`, each a fact the observation states only indirectly. None of them route, score, or embed a policy, so the package's no-pathfinder rule holds.

- `units.STATS`, a new `units` namespace: per-type hit points, movement, attack range, damage, and vision. The observation carries neither enemies' movement nor their range, so the package carries the table.
- `zone.zones(observation)`, a new `zone` namespace: the capture zones from the battlefield, empty when capture is off.
- `zone.at(observation, position)`: the zone containing a tile, or None.
- `zone.occupants(observation, zone)`: the visible units standing in the zone, including the observing unit itself. Students split by side and derive contest state themselves. Capture progress needs no helper; it reads straight off the observation.

In code the stats are one table, not a copy of one, though the student guide still restates them in prose for a reader who is not writing Python yet. `environments/skirmish_crane/unit_stats.py` holds the `UnitStats` dataclass and the `UNIT_STATS` values that the rules engine plays by, and it imports nothing but the standard library so compose can place it at `sandbox/unit_stats.py` through the same `env_sandbox_modules` mapping that already places `observation_types.py`. `units.STATS` is that object, so students read `units.STATS["archer"].attack_range` and the numbers cannot drift from the rules. The helper package still pulls in no PettingZoo, Gymnasium, or NumPy, which the import-lightness probe test enforces, and which is why the helper reads the flat copy rather than importing the engine.

The additions join the canonical guide's helpers table and reach every student at the next template version bump. They are facts, not strategy.

### The example package

`environments/skirmish_crane/examples/banner/` follows the marcher and vanguard layout: `README.md`, `agent.py`, `blocks.py`, and `tests/test_banner.py`. Banner is published: it is the environment's single entry in `PUBLISHED_EXAMPLES`, so the publisher pushes it to the `examples/skirmish_crane/banner` branch of the student repository, while marcher and vanguard stay internal.

`agent.py` imports `blocks` at module top. The harness isolates top-level imports per player, while an import inside `act` would resolve against the last-loaded player's directory and be shared across players.

### The block interface

A block is a pure decision function: `decide(observation, memory, goal)` returns a mask-legal action Dict built through the helpers, or None meaning the situation is not the block's. `memory` is the unit's own instance dict, with block state under namespaced keys, and `goal` is a position or None. No classes with hidden state: the unit's code owns its memory, matching the ruleset's no-shared-controller rule.

The dispatch contract in `agent.py`: run the assigned block, and on None run `advance(goal)`. There is no third branch, because `advance` always has an answer: standing still is a landing, and the stay bit is unconditionally set in every mask.

Blocks are mask-driven, not planners: they enumerate the legal path ids, land each with `tile.at_path_end`, and score landing tiles only, since under Season 4 parameters the tiles a path crosses on the way change nothing. Season 6's wasteland is the exception, charging hit points for every tile entered, and the module docstring says so where a student will meet it. No A\* and no route memory; long-range routing stays student work, which is what keeps the library from trivializing the seasons' core techniques.

### Internal helpers

`blocks.py` shares a few composite reads across blocks, module-private with underscore names and documented as free to change: pairing each reachable landing tile with the fewest-steps path that gets there, listing the visible enemies whose movement plus attack range covers a tile, choosing a strike target from a landing tile (lowest hit points first, then nearest), and checking whether a footman on a tile would stand beside a footman of its own side, the shield wall condition. The charge block asks that last question of the defender's side, the shield wall block of its own.

The threat read is an estimate and says so in its docstring, since the blocks that lean on it would otherwise promise safety they cannot deliver. It ignores terrain, it sees only what the unit sees while every enemy's reach is longer than its vision, and it assumes one enemy activation when a reshuffled order can grant two. A tile it calls quiet is the better bet, not a safe one.

### The block menu

Ten blocks, each typed to a job and testable in isolation:

| Block | Behavior | Empty-handed when |
| --- | --- | --- |
| hold_ground(goal) | Keep within a short tether of the goal, striking what comes in range | Never; staying qualifies |
| advance(goal) | Endpoint closest to the goal, striking when possible; also the dispatch fallback | Never |
| kite(goal) | Keep the nearest visible enemy inside firing range while maximizing distance to it; standing still qualifies at maximum range | No visible enemy |
| charge(goal) | Displacement 3 or more into a strike, preferring defenders the bonus actually hits (not in forest, not covered by a shield wall) | Unit is not cavalry, abilities are off, or no such path |
| capture(goal) | Get inside the zone the goal belongs to and stay there, preferring tiles nearest its center | Goal is not in a zone |
| fall_back(goal) | Maximize the minimum distance to visible enemies, tiebreak toward the goal | No visible enemy |
| screen(goal) | Stand between the goal and the enemy nearest the goal, within a short tether of it | No visible enemy |
| flank(goal) | Close distance to the goal over landing tiles no visible enemy can strike next activation | No visible enemy, or no such tile also closes the distance |
| harass(goal) | Strike from a tile only the victim could answer, then withdraw next activation to the quietest tile near the goal, striking there if something is in range | No visible enemy |
| shield_wall(goal) | Hold near the goal, preferring tiles adjacent to a visible allied footman; footman only | Unit is not a footman |

### The assignment hook

`assign(observation, memory)` returns a (block, goal) pair, computed once from standing knowledge and never revisited, explicitly labeled as the thing Season 4's search replaces. The static map spreads the side by unit number alone: footmen alternate between `capture` and `shield_wall` on the zone center, cavalry alternate between `charge` and `harass` and between the two tiles beside it, and archers take `kite` on the center itself. It exercises those five blocks plus the `advance` fallback, and the other four are the menu for the student's search.

Every goal sits on or beside the zone, which is load-bearing rather than cosmetic. A goal is where a unit walks when its block returns None, so a goal placed off the contested ground is an order to leave the battle and wait there: give archers a station behind the line and the survivors of a won fight stand on it, out of sight of each other, until the round cap. Goals on the zone end those same matches inside 40 rounds.

### Honest strength

The example's value is the interface and the menu, not ladder position. It stays weaker than vanguard because assignment intelligence is the season's own work: no lookahead, no routing, and conservative documented approximations.

### CI wiring

`scripts/tests/test_compose.py` pins both inventories, so its source list gains `("skirmish_crane", "banner")` and its published list stops being empty. `unit_stats.py` joins `env_sandbox_modules` in `scripts/_envs.py`.

Type-checking splits in two, because coverage that can quietly disappear is worth nothing. An environment's own `pyright_files` are required of every one of its composed examples, and `job_examples` in `scripts/ci.py` fails the build when one is missing, so a rename cannot silently drop a file from the check. `blocks.py` belongs to banner alone, so it goes in a second list, `pyright_example_files`, whose entries are checked in the trees that carry them and skipped in the trees that do not.

## Tests

`template/tests/test_crane.py` additions:

- `units.STATS` is the table the engine plays by, covering exactly the three unit types.
- Zone membership and occupants against constructed observations, and against raw battlefield state while driving a live episode.
- The import-lightness probe extended over the two new namespaces, which is the guarantee the flat `sandbox/unit_stats.py` copy exists to preserve.

`tests/test_banner.py`, in the vanguard pattern: hand-built observations, a wrapper asserting every returned order is mask-legal, and pinned-seed episodes whose parameters come from the environment metadata presets rather than re-declared literals.

- Per-block behavior on constructed observations, one assertion per block plus its empty-handed case: kite opens distance from an adjacent enemy and stays in firing range, charge picks a displacement-3 strike and prefers the defender the bonus lands on, capture stands in the zone even when a tile outside it is nearer the goal, fall_back raises the distance to the nearest enemy, screen ends on the line between goal and threat, flank takes a clear tile over a closer covered one, harass strikes and then withdraws across two activations, shield_wall picks a tile beside an allied footman, hold_ground stays tethered and names a victim, and advance closes distance. Every one of these fails when its block is swapped for `advance`, which is the check that keeps a scenario from passing on the fallback's behavior rather than the block's.
- The shipped assignment maps each unit type and number to the documented block and goal, falling back to the field center where a match has no zones. That exact mapping is pinned in one test, and the properties that should survive a student rewriting `assign` (every unit gets a block from `BLOCKS`, every goal sits on or beside the zone) in another, so replacing the placeholder means re-pinning one test rather than four.
- The dispatch fallback: an archer that can see nothing still returns a legal advancing order through `Agent.act`.
- Every block stays mask-legal across whole Season-4-parameter episodes. A wrapper runs all ten blocks on every activation, with the unit's own goal and again with None, and checks both mask components of every order returned. This is the test that proves the library can never forfeit a seat.
- A coherence bar: banner beats naive on pinned Season-4-parameter seeds, from the red seats and the blue seats. The bar is absolute; a bar relative to another example would flip whenever either side is tuned.

The tuning constants, the tether and the index splits, are defaults the coherence test may adjust.

## Done when

Banner plays a coherent capture match against naive in the browser under Season 4 parameters: the footmen advance into the zone and lock shields, the archers kite its rim, and the cavalry cycles charges and withdrawals. All block and helper tests are green, the example composes in CI, and the Skirmish at Crane Reach plan is complete end to end.
