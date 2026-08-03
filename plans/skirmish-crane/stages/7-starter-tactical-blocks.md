# Step 7: Season 4 Starter Tactical Blocks

Status: planned.

Part of [the Skirmish at Crane Reach plan](../README.md). This is build-order step 7 and the closing step: the predefined tactical block library that [pedagogy.md](../pedagogy.md) promises as Season 4's on-ramp, shipped in the template layer with tests. The hands-on surface is a block-driven side maneuvering coherently in the browser.

## Why this is its own seam

Season 4's design issue is decentralized strategy as assignment: each unit instance selects a tactical block and a goal. The starter blocks give that strategic layer a working action space on day one of the season, and they are student-facing library code with their own interface contract and quality bar, distinct from the helpers they build on.

## What to build

`template/sandbox/blocks.py` on top of `sandbox/crane.py`, plus a README section showing how to wire blocks into an agent.

### The block interface

A block is a pure decision function: `decide(observation, memory, goal)` returns a mask-legal action Dict built through the helpers, or None meaning the block has nothing useful, which falls through to stay. `memory` is the unit's own instance dict and `goal` is a position or None. No classes with hidden state: the unit's code owns its memory, matching the ruleset's no-shared-controller rule.

Blocks are mask-driven, not planners: they enumerate the legal path bits, call `decode_path` from the crane helper, and score endpoints by distance to goal, range bands, and cover. They do not duplicate the path codec. No A\* and no route memory; long-range routing stays student work, which is what keeps the library from trivializing Seasons 2 through 4.

### The starter set

Five blocks, each typed to a job and testable in isolation:

| Block | Behavior |
| --- | --- |
| hold_ground(goal) | Keep position near the goal, striking what comes in range |
| advance(goal) | Close distance toward the goal |
| kite(goal) | Open distance from the nearest threat and end in firing range, the archer's shape |
| charge(goal) | Select a path with displacement 3 or more toward a strike when one exists, the cavalry's shape |
| capture(goal) | Stand inside the zone, contest-aware |

### The assignment hook

`assign(observation, memory)` returns a (block, goal) pair. The shipped default assigns by unit type with a static goal (the field center or the first zone), explicitly labeled as the thing Season 4's search replaces.

### Staying optional for Seasons 1 through 3

Nothing imports the module by default; the starter agent does not use it. The README frames it as Season 4 material. Strength is deliberately honest: good enough to give the strategic layer a real action space, not a free ladder climb. Publication timing (in the day-one template or in the template version bumped before Season 4) is a course-ops choice recorded in the plan's Later work; the repo ships the module either way.

## Tests

`template/tests/test_blocks.py`:

- Per-block behavior on constructed observations: kite opens distance from an adjacent enemy and ends in firing range, charge picks a displacement-3 path when one reaches a strike, capture holds inside the zone, hold_ground stays near the goal, advance closes distance.
- A fuzz run drives every block through full real-environment episodes and asserts every returned action is mask-legal.
- The default assignment plays an episode-level coherence run: a block-driven side beats naive on a pinned seed set while staying beatable by the step 6 worked example.

## Done when

A scratch agent wired per the README (driven by a test, so no second example package exists) plays a block-driven side that maneuvers coherently in the browser: the archers kite, the cavalry charges, the footmen hold ground near a goal. All block tests are green, and the Skirmish at Crane Reach plan is complete end to end.
