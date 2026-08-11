# Three Branches: Village Specification

This document specifies Three Branches, the village of Days at Three Branches: its landscape, buildings, props, and the rules that generate them. The [ruleset](ruleset.md) stays the source of game rules; this document is the source of place. The setting behind it lives in the [worldview](worldview.md).

There is no canonical map. The village is whatever these rules generate from the match seed. Every season pins the same default seed, so the course plays one familiar village throughout, while any seed still yields a valid village.

## Frame and scale

The village is a grid of square cells, in the shape a conventional top-down RPG map takes.

- `rules.json` fixes the frame: `cells_x`, `cells_y`, and `cell_size`. The shipped village and its generation guarantees use 100 by 100 cells of 1 metre. Grid and overlay code read those values rather than copying them.
- The origin is the southwest corner, x runs east and y runs north. Cell `(cx, cy)` is zero-indexed from that corner and covers `cx * cell_size` to `(cx + 1) * cell_size` metres east and `cy * cell_size` to `(cy + 1) * cell_size` metres north. Its centre is `((cx + 0.5) * cell_size, (cy + 0.5) * cell_size)`.
- Characters keep continuous positions in metres. The grid constrains the map, not the cast: a villager stands anywhere, and only walls, props, scenery, and water occupy whole cells.
- The boundary is impassable on all four sides.
- Nothing here fixes a coordinate. Every rule is a construction step with bounds, and every bound is expressed in cells.

## Grounds

Every cell carries one ground class. The classes, their single-character grid codes, and their speed limits live in `rules.json`. This generator places water for the trunk and channels, road on the raised road, path on footpaths, bridge at crossings, open on remaining walkable land and building sites, field on the lower terraces, and reed on wet banks and channel mouths.

Where placed grounds overlap, the earlier construction stage wins: a footpath through a reed flat carries path ground, and a crossing over water carries bridge ground. A cell's class is the whole of its rule, so water is impassable because its class says so and a crossing is walkable because its class says so.

Reed is the concealing class, flagged as such in `rules.json`. Any class can carry that flag; reed is the one that does.

## Waterways

- The trunk river enters the north edge within its middle third, 5 to 7 cells wide, and meanders south, its course shaped by the seed's terrain so the water reads grown rather than drafted.
- Between two fifths and three fifths of the way down the village, the trunk forks into three channels, 3 to 4 cells wide, that fan out and reach the south edge. Adjacent mouths land at least 20 cells apart. The fork is the village's namesake and its visual centre.
- The branches share only the small fork and confluence area. Past it, a course rejects or reroutes self-contact and contact with either sibling, so all three channels stay distinct to their mouths. Water is impassable everywhere.
- Reed flats gather on low wet banks and at the channel mouths.

## The road and paths

- The raised road enters at the west edge, winds east, and exits the east edge, 4 to 5 cells wide.
- The road runs south of the fork, so it crosses each channel exactly once and never crosses the trunk. Its cells over water carry bridge ground, and a crossing extends one cell of apron onto each bank.
- Footpaths, 2 to 3 cells wide, branch from the road to the well plaza, every home cluster, and every shrine. Paths curve; nothing in the village runs straight for long.
- Any route the village's connectivity depends on is at least 2 cells wide, so a 0.8 m body walking at an angle never jams in it.
- The visitor's spawn point is fixed on a road cell 1 metre in from the west edge, clear of every footprint.

## Districts

Districts are anchors along the road and channels, not fixed positions:

- The well plaza sits in the crook of the fork: an open clearing holding the well pump, reached by a footpath from the road.
- The market sits on the road's middle stretch, its stalls scattered loosely on both sides of the road with the notice board among them.
- The inn stands on the road's east stretch, facing the road.
- The repair shed and the beacon bell stand on the road's west stretch, so the visitor walking in passes them first.
- Homes gather in two or three loose clusters on banks the terrain favours, each cluster reached by a footpath and, when it lies across water, a crossing.
- Fields step down in low terraces between the home clusters and the south edge, their furrows following the channel curves.

## Buildings and interiors

Building templates and their physical catalog data are in the [canonical catalog](ruleset.md#canonical-catalog). A building instance remains a semantic group: homes supply ids and ownership, and the inn and shed identify their allowed interior prop placement.

- A building occupies an axis-aligned site rect, never rotated. Its semantic placement selects the doorway, then the shared layout expansion gives the entire rect open ground and emits the template's wall and 2-cell doorway structural props. The building itself does not occupy cells.
- Every building has one permanent doorway run on a side facing its planned footpath approach. A doorway is 2 cells wide so a body passes it comfortably at any angle.
- Walls block movement, sight, presence, and speech. Doorways carry all four normally.
- Doorway cells open onto walkable cells, never onto water, another footprint, or the boundary.
- The inn hearth stands inside the inn and the repair bench inside the shed, each against the wall opposite the doorway. Homes hold no interior props. Each home's garden plot stands outside, its long edge centred on and flush with the exterior wall opposite the doorway, extending outward from it. When that wall and the plot differ by an odd number of cells, the plot takes the lower-index of the two centred positions, so the placement stays on the grid and stays deterministic.
- Homes are numbered `home_0` through `home_4` in the order the generator places them, and `npc_i` lives in `home_(i mod 5)`, so cast_10 seats two villagers per home. A seed yields one identical layout for cast_5 and cast_10 alike.

## Props

Interactive-prop catalog data, activities, and states are in the [canonical catalog](ruleset.md#canonical-catalog). This document owns their placement:

- Stalls go on both sides of the road at the market. Lanterns use road stations, denser through the market. Benches go at the well plaza, market, and inn front. Shrines go at road bends, and the notice board goes in the market.
- Garden plots follow the home-doorway placement rule above. The inn hearth and repair bench use the interior placements above. The well pump goes in the well plaza and the beacon bell beside the west road.
- An interactive prop reserves its catalog cell rect, so nothing else is placed on those cells. It carries its catalog collision shape, facing is one of the four cardinal directions, and it is never placed at an angle.
- Every interactive prop has a standing cell in the connected walkable region within the ruleset's 1.5 m reach of the nearest point of its collision shape. A character can stand there with its full body clear of every solid and an unblocked line to that point.

## Scenery

- Solid scenery type data is in the [canonical catalog](ruleset.md#canonical-catalog). Red pines go at road stations and scattered open-land cells, with optional nearby companions, and market crates go beside stalls. Solid scenery never blocks perception, breaks the connected walkable region, a doorway's approach, or an interactive prop's reach.
- Passable scenery is not an object at all: reed flats and field furrows are ground classes, with the concealment and speed the ruleset gives them.
- White cranes are renderer ambience: no cell, no position, no rules.

## Generation order and guarantees

The generator runs from the match seed's generation stream, in order: terrain fields, water, ground classes, the road with its crossings and spawn, sites and semantic building placements, footpaths, then accessories. Layout assembly expands the buildings into floor ground and structural props. Accessories are interactive props and scenery, including lanterns. Its immutable tuning is in `generation.json`. Alongside the village it records which cells belong to which course and which cell witnesses each interactive prop, so the guarantees below are checkable without re-deriving the generator's own reasoning.

Every seed satisfies:

- The stable features are each placed once: the well pump, the market, the inn, the repair shed, and the beacon bell.
- The walkable cells, crossings and building floors included, form one connected region.
- Five homes exist, and every doorway run opens onto walkable cells.
- Every interactive prop has a connected walkable standing cell within reach of the nearest point of its collision shape, with room for the full body and an unblocked line to that point.
- Building sites do not overlap one another, water, the road, the boundary, or exterior objects, and every site keeps a clear margin of open cells. An interior prop stays inside its walls, leaves the doorway run open, and does not overlap another object. Generator placement may reserve a building site while it is being built, but the finished building is represented only by structural props and allowed interior props in distinct cells.
- The visitor spawn sits on a road cell 1 metre inside the west edge, clear of every footprint.
- Water reaches the north edge inside its middle third and the south edge in exactly three runs at least 20 cells apart. Past the shared fork and confluence area, no branch self-contacts or contacts a sibling.
- The road spans the west edge to the east edge, crosses each channel exactly once and the trunk never, and every road or path cell over water carries bridge ground. Each channel carries at most one footpath crossing.

## Naming

The village uses plain functional labels: the well plaza, the market, the inn, the repair shed, the bell, and the west, centre, and east channels. Further names and lore stay out, per the worldview's naming guide.
