# The Tactical Game: Ruleset

The tactical game is a battle between two detachments, Red and Blue, fighting over ground in Crane Reach. Every unit on a side runs a separately constructed copy of one submitted program. Coordination happens through perception and delayed messages, never through a shared controller or shared memory.

The game is one environment plus four variants: terrain, abilities, messages, and capture. Seasons switch variants on and set parameters such as field size and unit counts. The season schedule is at the end of this document; the teaching arc behind it lives in [pedagogy.md](pedagogy.md).

## Conventions

- The field is a hexagon of pointy-top hexagonal tiles: a center tile plus R concentric rings, 3R^2 + 3R + 1 tiles in all, where R is the season's field radius.
- Coordinates are axial (q, r), each running 0 to 2R. The center is (R, R), and a pair in that range is on the field exactly when R <= q + r <= 3R, which is hex distance at most R from the center.
- A tile has six neighbors, one per direction: east (+1, 0), west (-1, 0), northeast (+1, -1), northwest (0, -1), southeast (0, +1), southwest (-1, +1).
- Range and vision use hex distance: (|dq| + |dr| + |dq + dr|) / 2. Each neighbor is at distance 1.
- A tile holds at most one unit.
- The match seed determines the battlefield, the activation order of every round, and every automatic-strike draw. The same seed and the same unit code replay the identical battle.

## Rounds and activation

A match is a sequence of rounds. Each round, every living unit activates exactly once, in an order shuffled from the match seed and redrawn every round. After the last activation of the round, capture zones score (capture variant) and the end conditions are checked.

On its activation, a unit first receives the current state and selects one order. It then receives its inbox through the chat hook. The unit's code must store any received messages in its own instance state, where they can inform its next activation. The game then resolves the selected order immediately: the walk, then the strike. Later activations in the same round see the result.

## The battlefield

Every match plays on a field generated from the match seed, under fixed guarantees:

- The field is point-symmetric: rotated 180 degrees about the center, (q, r) onto (2R - q, 2R - r), it maps onto itself, and the two sides' spawn positions mirror each other. Neither side gets better ground.
- All passable tiles form one connected region.
- Without the terrain variant, every tile is grass. With it, the generator lays water that leaves two or three passages, each 2 to 4 tiles wide, between the two halves of the field, and scatters hills, forests, and marshes symmetrically.
- With the capture variant, zones sit on passable tiles, placed symmetrically: one central zone when there is one, one central and two mirrored when there are three.

Each tile has a terrain and at most one feature. Effects stack.

| Tile | Move cost | Effect |
| --- | --- | --- |
| Grass (terrain) | 1 | None. The whole field before Season 2. |
| Hill (terrain) | 2 | High ground: attacks from a hill against lower ground deal 1 extra damage, and attacks from lower ground against a hill deal 1 less. A unit on a hill sees 1 tile farther. |
| Water (terrain) | impassable | Shapes the passages. |
| Forest (feature) | +1 | Cover: a unit in forest takes 1 less damage from attacks made at a distance greater than 1, and the charge bonus never applies against it. |
| Marsh (feature) | +2 | Slow ground. Occurs on grass only. |

Vision and attacks ignore terrain everywhere: terrain prices movement and adjusts damage, and it never blocks sight or arrows.

## Units

| Stat            | Footman | Archer | Cavalry |
| --------------- | ------- | ------ | ------- |
| Hit points      | 12      | 6      | 10      |
| Movement points | 2       | 2      | 4       |
| Attack range    | 1       | 6      | 1       |
| Damage          | 3       | 2      | 3       |
| Vision          | 4       | 6      | 6       |

- Every unit has a stable id of the form side_type_index, such as red_archer_2, fixed for the whole match.
- A unit at 0 or fewer hit points is removed immediately.

Composition per side: Seasons 1 and 2 field one unit of each type. Season 3 onward fields 8 footmen, 6 archers, and 6 cavalry.

## Orders

A unit issues exactly one order per activation: a path of at most four steps, possibly empty, and optionally one named enemy target. The unit walks the path, then strikes once if any enemy is within its attack range of its final tile. An empty path with no target, the default when a unit's code is late or supplies no action, stands still and still strikes when enemies are in range.

Each path step enters a tile adjacent to the previous one. The order is legal only when the unit can walk the complete path from the current state. The unit starts every activation with its full movement points and checks the path step by step:

- A step needs an empty, passable tile and enough unspent points to pay its cost. A unit that still has all of its movement points may always take one step onto any empty passable tile, whatever the cost.
- Each step spends the tile's cost. The balance may fall below zero after the always-permitted first step, in which case that tile must be the end of the path.
- After the path passes these checks, the unit walks the complete path.

The engine never plans a route. Turning a pathfinder's route into legal orders, and re-planning on later activations as the battlefield changes, is the unit's own code.

The strike resolves from the final tile:

- If the named target is alive, was visible at the moment of activation, and is within the unit's attack range of the final tile, the unit strikes it.
- Otherwise, with no target named or the named target out of reach, the unit strikes an enemy drawn uniformly, from the match seed, among the in-range enemies at minimum hex distance from the final tile.
- If no enemy is in range, no strike happens. The strike is otherwise mandatory: a unit avoids attacking only by ending out of range.
- An attack always hits. Damage is the attacker's damage stat, plus the charge bonus if it applies, adjusted by hill, forest, and shield wall, and never below 1. Damage applies immediately, and a unit it kills never activates later in the round.

The unit's observation identifies every walkable path and every nameable target, and a submitted order with an unwalkable path or an unnameable target is rejected. A nameable target is not a guaranteed strike: range is checked from the final tile at resolution, and an out-of-range name falls to the automatic draw above.

## Perception

At activation a unit receives:

- Itself: id, type, position, hit points, and movement points.
- Every unit within its vision radius, friend or enemy: id, side, type, position, and hit points.
- The round number, and both sides' capture scores when the capture variant is on.

This observation is the information available when the unit selects its order. Standing knowledge, available to every unit: the full generated battlefield, both sides' rosters, and the season's parameter values. Anything beyond vision travels by message; anything about the past, including messages received after a prior order, lives in that unit's own code.

## Variants

### terrain (Season 2 onward)

Enables the full terrain and feature table during generation: water passages, hills, forests, and marshes.

### abilities (Season 3 onward)

- Charge: a cavalry unit whose move moved at least 3 tiles strikes with 2 extra damage on that same activation. The distance between the starting and end tiles must >= 3.
- Shield wall: a footman adjacent to an allied footman takes 1 less damage from attacks, and the charge bonus never applies against it. A lone footman gets neither protection.

### messages (Season 3 onward)

A unit may send short text messages to living allied units, and broadcasts, which both sides hear. After a unit has acted, its chat hook receives any messages that arrived for it. A received message must be stored by the receiving unit if it is to affect that unit's next order. Messages never alter the order already selected for the current activation.

### capture (Season 4 onward)

A capture zone is seven tiles: a passable center tile plus its six neighbors, all passable. After each round, each zone is checked: if exactly one side has a living unit standing in it, that side earns 1 point. A contested or empty zone earns nobody anything. The first side to reach the capture target wins.

## Match end and team score

Every player on a side receives the identical final team score, between 0 and 100, including players whose units were removed earlier. Any win scores 70 to 100, a draw scores 50, and any loss scores 0 to 30.

Matches run until an end condition is met, under a round cap of 1000 rounds unless the season sets another value; a match still running after the capped round ends there.

Elimination matches (capture variant off) end when a side has no living units, or at the round cap.

- The side that eliminates the other wins.
- With h the winner's remaining hit points divided by its starting total: the winner scores 70 + 30h, and the eliminated side scores 0.
- At the round cap, the side with the higher total remaining hit points wins. With m = the hit point difference divided by the winner's starting total: the winner scores 70 + 30m, the loser scores 30(1 - m), and equal totals draw.

Capture matches end when a side is eliminated, when a side reaches the capture target, or at the round cap.

- A side that eliminates the other scores 100, and the eliminated side 0.
- Otherwise the higher capture score wins. Equal capture scores fall to total remaining hit points, and still-equal totals draw.
- With margin m = the capture score difference divided by the target, clamped between 0 and 1: the winner scores 70 + 30m, the loser scores 30(1 - m), and a draw scores 50 for both.

## Seasons

| Season | Field | Per side | terrain | abilities | messages | capture |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | radius 7 (15 across) | 1-1-1 | off | off | off | off |
| 2 | radius 7 (15 across) | 1-1-1 | on | off | off | off |
| 3 | radius 10 (21 across) | 8-6-6 | on | on | on | off |
| 4 | radius 10 (21 across) | 8-6-6 | on | on | on | 1 zone, target 200 |
| 5 | radius 10 (21 across) | 8-6-6 | on | on | on | 3 zones, target 200 |
| 6 | radius 10 (21 across) | 8-6-6 | on | on | on | 3 zones, target 200 |

Per side is footmen-archers-cavalry.
