# Step 7: Season 4 Starter Tactical Blocks

Status: planned.

Part of [the Skirmish at Crane Reach plan](../README.md). This is build-order step 7 and the closing step: the predefined tactical block library that [pedagogy.md](../pedagogy.md) promises as Season 4's on-ramp. It ships in two layers: atomic helper additions to the template's `sandbox/crane/` package, and `banner`, a worked example carrying the block library and a placeholder assignment. The hands-on surface is a block-driven side maneuvering coherently in the browser.

## Why this is its own seam

Season 4's design issue is decentralized strategy as assignment: each unit instance selects a tactical block and a goal. The starter blocks give that strategic layer a working action space on day one of the season, and they are student-facing library code with their own interface contract and quality bar, distinct from the helpers they build on.

## The agent the library serves

Season 4 runs the army seat plan, 8 footmen, 6 archers, and 6 cavalry per side, on a field of extent 10 with terrain and abilities on, one capture zone at the field center (the center tile plus its six neighbors), a capture target of 200, and a round cap of 1000.

A working Season 4 agent is, per unit instance: re-evaluate its (block, goal) pair every few rounds by shallow lookahead, coordinate through observation, stable roster ids, and delayed messages, and let the chosen block produce each activation's order. Its match arc names every block the library needs:

1. **Opening.** Everyone converges on the zone: footmen head for zone tiles, archers for a standoff ring behind them, cavalry swings wide. Blocks: `advance` for plain closing, `flank` for closing while ending out of enemies' likely strike range.
2. **Contact.** Footmen enter and hold the zone, bracing shield walls, since adjacency to an allied footman gives 1 less damage taken and charge immunity. Archers hold the range-6 band, stepping back as enemies close. Cavalry takes displacement-3 lanes when the +2 charge bonus actually lands. Blocks: `capture`, `shield_wall`, `kite`, `charge`, and `hold_ground` for guarding a point that is not the zone.
3. **Attrition.** Wounded units disengage toward safety, cavalry alternates strike and withdrawal, striking only when no other enemy can answer at the landing tile, and footmen interpose between enemy runners and the archers. Blocks: `fall_back`, `harass`, `screen`.
4. **Endgame.** The zone scores only when exactly one side stands in it, so hold it alone when uncontested and step in to deny it when the enemy holds it. Block: `capture`, contest-aware.

The arc describes the student's search agent. The shipped example wires a static placeholder assignment through the same interface, so the slot the search fills stays visible and replaceable.

## What to build

### Template helper additions

New atomic helpers in `template/sandbox/crane/`, each a fact the observation states only indirectly. None of them route, score, or embed a policy, so the package's no-pathfinder rule holds.

- `units.STATS`, a new `units` namespace: per-type hit points, movement, attack range, damage, and vision, mirroring the guide's unit table. The observation carries neither enemies' movement nor their range, so the package carries the table.
- `zone.zones(observation)`, a new `zone` namespace: the capture zones from the battlefield, empty when capture is off.
- `zone.at(observation, position)`: the zone containing a tile, or None.
- `zone.occupants(observation, zone)`: the visible units standing in the zone, including the observing unit itself. Students split by side and derive contest state themselves. Capture progress needs no helper; it reads straight off the observation.

The additions join the canonical guide's helpers table and reach every student at the next template version bump. They are facts, not strategy.

### The example package

`environments/skirmish_crane/examples/banner/` follows the marcher and vanguard layout: `README.md`, `agent.py`, `blocks.py`, and `tests/test_banner.py`. Banner is a publication candidate: this step leaves `PUBLISHED_EXAMPLES` unchanged, and adding banner to it when Season 4 opens is recorded in the plan's Later work.

`agent.py` imports `blocks` at module top. The harness isolates top-level imports per player, while an import inside `act` would resolve against the last-loaded player's directory and be shared across players.

### The block interface

A block is a pure decision function: `decide(observation, memory, goal)` returns a mask-legal action Dict built through the helpers, or None meaning the situation is not the block's. `memory` is the unit's own instance dict, with block state under namespaced keys, and `goal` is a position or None. No classes with hidden state: the unit's code owns its memory, matching the ruleset's no-shared-controller rule.

The dispatch contract in `agent.py`: run the assigned block, on None run `advance(goal)`, and stay when even that returns nothing.

Blocks are mask-driven, not planners: they enumerate the legal path ids, land each with `tile.at_path_end`, and score landing tiles only, since intermediate tiles have no effect under Season 4 parameters. No A\* and no route memory; long-range routing stays student work, which is what keeps the library from trivializing the seasons' core techniques.

### Internal helpers

`blocks.py` shares a few composite reads across blocks, module-private with underscore names and documented as free to change: pairing each legal path id with its landing tile, listing enemies whose movement plus attack range covers a tile (a terrain-ignoring overestimate built on `units.STATS`), choosing a strike target from a landing tile (lowest hit points first, then nearest), and checking whether a footman of a given side at a tile would stand adjacent to a visible footman of the same side, the shield wall condition. The charge block asks that last question about the defender's side, the shield wall block about its own.

### The block menu

Ten blocks, each typed to a job and testable in isolation:

| Block | Behavior | Empty-handed when |
| --- | --- | --- |
| hold_ground(goal) | Keep within a short tether of the goal, striking what comes in range | Never; staying qualifies |
| advance(goal) | Endpoint closest to the goal, striking when possible; also the dispatch fallback | Never |
| kite(goal) | Keep the nearest visible enemy inside firing range while maximizing distance to it; standing still qualifies at maximum range | No visible enemy |
| charge(goal) | Displacement 3 or more into a strike, preferring defenders the bonus actually hits (not in forest, not covered by a shield wall) | No such path |
| capture(goal) | Contest an enemy-held zone, hold an uncontested one, never vacate a zone held alone; prefer free zone tiles, else adjacent ones | Goal is not a zone |
| fall_back(goal) | Maximize the minimum distance to visible enemies, tiebreak toward the goal | No visible enemy |
| screen(goal) | Stand between the goal and the nearest visible enemy, within a short tether of the goal | No visible enemy |
| flank(goal) | Close distance to the goal among landing tiles no visible enemy can strike next activation | No visible enemy, or no such tile |
| harass(goal) | Strike only when no enemy but the target can answer at the landing tile, otherwise circle near the goal out of melee reach | No visible enemy |
| shield_wall(goal) | Hold near the goal, preferring tiles adjacent to a visible allied footman; footman only | Unit is not a footman |

### The assignment hook

`assign(observation, memory)` returns a (block, goal) pair, computed once at reset from standing knowledge and never revisited, explicitly labeled as the thing Season 4's search replaces. The static map spreads the side without adaptivity: footmen alternate by roster index between `capture` and `shield_wall` at the zone center, archers get `kite` with a goal pulled back four tiles from the zone toward their own side through the constant direction field, and cavalry get `charge` with goals offset a few tiles to alternating sides of the zone. The spread keeps forty units from funneling onto one tile and exercises `capture`, `shield_wall`, `kite`, `charge`, and the `advance` fallback. The other five blocks are the menu for the student's search.

### Honest strength

The example's value is the interface and the menu, not ladder position. It stays weaker than vanguard because assignment intelligence is the season's own work: no lookahead, no routing, and conservative documented approximations.

### CI wiring

The example inventory assertion in `scripts/tests/test_compose.py` gains `("skirmish_crane", "banner")`, and the pyright file set in `scripts/_envs.py` gains per-example additions so banner's composed tree type-checks `blocks.py`. The template helpers are already covered by the `sandbox/crane/` entry.

## Tests

`template/tests/test_crane.py` additions:

- The `units.STATS` pin against the live engine, following the file's existing live-environment cross-check.
- Zone membership and occupants against constructed observations.

`tests/test_banner.py`, in the vanguard pattern: hand-built observations, a wrapper asserting every returned order is mask-legal, and pinned-seed episodes whose parameters come from the environment metadata presets rather than re-declared literals.

- Per-block behavior on constructed observations: kite opens distance from an adjacent enemy and stays in firing range, charge picks a displacement-3 strike and skips shield-walled or forested defenders, capture holds inside an uncontested zone and enters a contested one, fall_back raises the minimum threat distance, screen ends between goal and threat, flank closes distance while avoiding strikeable tiles, harass declines a strike another enemy could answer, shield_wall picks a tile beside an allied footman, hold_ground stays near the goal, and advance closes distance.
- A fuzz run drives every block through full Season-4-parameter episodes and asserts every returned order is mask-legal.
- A coherence bar: banner beats naive on a pinned Season-4-parameter seed set. The bar is absolute; a bar relative to another example would flip whenever either side is tuned.

The static goals in the assignment, the archer pull-back distance, the cavalry offsets, and the footman index split, are defaults the coherence test may adjust.

## Done when

Banner plays a coherent capture match against naive in the browser under Season 4 parameters: the footmen advance into the zone and lock shields, the archers kite its rim, and the cavalry cycles charges and withdrawals. All block and helper tests are green, the example composes in CI, and the Skirmish at Crane Reach plan is complete end to end.
