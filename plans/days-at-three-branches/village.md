# Three Branches: Village Specification

This document specifies Three Branches, the village of Days at Three Branches: its landscape, buildings, props, and the rules that generate them. The [ruleset](ruleset.md) stays the source of game rules; this document is the source of place. The setting behind it lives in the [worldview](worldview.md).

There is no canonical map. The village is whatever these rules generate from the match seed. Every season pins the same default seed, so the course plays one familiar village throughout, while any seed still yields a valid village.

Every number this generator works to is a named key in `generation.json`, listed under [Generation tuning](#generation-tuning). This document names the keys and describes the shapes they produce; the values themselves live in the file, and the guarantee suite reads them from there rather than repeating them. Tuning the village is editing that file, not editing code or tests.

## Frame and scale

The village is a grid of square cells, in the shape a conventional top-down RPG map takes.

- `rules.json` fixes the frame: `cells_x`, `cells_y`, and `cell_size`. The shipped village and its generation guarantees use 100 by 100 cells of 1 metre. Grid and overlay code read those values rather than copying them.
- The origin is the southwest corner, x runs east and y runs north. Cell `(cx, cy)` is zero-indexed from that corner and covers `cx * cell_size` to `(cx + 1) * cell_size` metres east and `cy * cell_size` to `(cy + 1) * cell_size` metres north. Its centre is `((cx + 0.5) * cell_size, (cy + 0.5) * cell_size)`.
- Characters keep continuous positions in metres. The grid constrains the map, not the cast: a villager stands anywhere, and only ground classes and placed props occupy whole cells.
- The boundary is impassable on all four sides.
- Nothing here fixes a coordinate. Every rule is a construction step with bounds, and every bound is expressed in cells.

## Grounds

Every cell carries one ground class, and the class is the whole of the cell's rule: its speed, whether a body may stand there, and whether it blocks sight. The classes, their single-character grid codes, and those properties live in `rules.json`.

This generator places water for the trunk and channels, road on the raised road, path on footpaths, bridge at crossings, field on the lower terraces, reed on wet banks and channel mouths, and open on the remaining walkable land. Building sites are painted last, in floor, wall, and door.

Where placed grounds overlap, the earlier construction stage wins: a footpath through a reed flat carries path ground, and a crossing over water carries bridge ground.

Water and wall are the impassable classes. Wall is the only class that blocks sight, so a doorway carries sight, hearing, and speech into a house exactly as open ground does.

## Waterways

- The trunk river enters the north edge inside `water.entry_band` at a width drawn from `water.trunk_width`, and meanders south, its course shaped by the seed's terrain so the water reads grown rather than drafted.
- Inside `water.fork_band`, measured down from the north edge, the trunk forks into three channels at widths drawn from `water.channel_width`. They fan out and reach the south edge with adjacent mouths at least `water.mouth_separation` apart. The fork is the village's namesake and its visual centre.
- The branches share only the small fork and confluence area. Past it, a course rejects or reroutes self-contact and contact with either sibling, so all three channels stay distinct to their mouths. Water is impassable everywhere.
- Courses bow away from the frame under `water.edge_margin`, and reed flats gather on low wet banks and at the channel mouths.

## The road and paths

- The raised road enters at the west edge, winds east, and exits the east edge, at a width drawn from `network.road.width`.
- The road runs south of the fork, so it crosses each channel exactly once and never crosses the trunk. Its cells over water carry bridge ground, and a crossing extends `network.road.apron` of bank onto each side.
- Footpaths branch from the road to the well plaza, every home cluster, and every shrine, at a width drawn from `network.path.width`. Paths curve; nothing in the village runs straight for long.
- Path widths are chosen so a body walking at an angle never jams in a route the village's connectivity depends on. The guarantee that backs it is the connectivity flood fill, which walks the same body clearance the engine collides with.
- The visitor's spawn point is a road cell `network.spawn.edge_inset` in from the west edge, with `network.spawn.clearance` of ground around it kept free of every footprint.

## Districts

Districts are anchors along the road and channels, not fixed positions:

- The well plaza sits in the crook of the fork: an open clearing holding the well pump, reached by a footpath from the road.
- The market sits on the road's middle stretch, its stalls scattered loosely on both sides of the road with the notice board among them.
- The inn stands on the road's east stretch, facing the road.
- The repair shed and the beacon bell stand on the road's west stretch, so the visitor walking in passes them first.
- Homes gather in loose clusters, `sites.cluster_count` of them, on banks the terrain favours, each cluster reached by a footpath and, when it lies across water, a crossing.
- Fields step down in low terraces between the home clusters and the south edge, their furrows following the channel curves.

## Buildings and interiors

Building templates and their site dimensions are in the [canonical catalog](ruleset.md#canonical-catalog). A building instance is a semantic group: homes supply ids and ownership, and the inn and shed identify their allowed interior prop placement.

- A building occupies an axis-aligned site rect, never rotated. Placing it selects the doorway side, then paints the site: floor ground inside, wall ground around the perimeter, and a 2-cell run of door ground through the chosen side. The record itself carries only the id, type, and origin cell.
- Every building has one permanent doorway run on a side facing its planned footpath approach. A doorway is 2 cells wide so a body passes it comfortably at any angle, and its cells are found by reading the door ground on the building's own perimeter.
- Walls block movement, sight, presence, and speech. Doorways carry all four normally.
- Doorway cells open onto walkable cells, never onto water, another footprint, or the boundary.
- The inn hearth stands inside the inn and the repair bench inside the shed, each on floor ground against the wall opposite the doorway. Homes hold no interior props. Each home's garden plot stands outside, its long edge centred on and flush with the exterior wall opposite the doorway, extending outward from it. When that wall and the plot differ by an odd number of cells, the plot takes the lower-index of the two centred positions, so the placement stays on the grid and stays deterministic.
- Homes are numbered `home_0` through `home_4` in the order the generator places them, and `npc_i` lives in `home_(i mod 5)`, so cast_10 seats two villagers per home. A seed yields one identical layout for cast_5 and cast_10 alike.

## Props

Interactive-prop catalog data, activities, and states are in the [canonical catalog](ruleset.md#canonical-catalog). This document owns their placement:

- Stalls go on both sides of the road at the market. Lanterns use road stations, denser through the market. Benches go at the well plaza, market, and inn front. Shrines go at road bends, and the notice board goes in the market.
- Garden plots follow the home-doorway placement rule above. The inn hearth and repair bench use the interior placements above. The well pump goes in the well plaza and the beacon bell beside the west road.
- An interactive prop reserves its catalog cell rect, so nothing else is placed on those cells. It carries its catalog collision shape, facing is one of the four cardinal directions, and it is never placed at an angle. The ground under a prop keeps its own class.
- Every interactive prop has a standing cell in the connected walkable region within the ruleset's prop reach of the nearest point of its collision shape. A character can stand there with its full body clear of every solid and an unblocked line to that point.

## Scenery

- Scenery type data is in the [canonical catalog](ruleset.md#canonical-catalog). Red pines go at road stations and scattered open-land cells, with optional nearby companions, and market crates go beside stalls. Scenery is solid, so it never breaks the connected walkable region, a doorway's approach, or an interactive prop's reach.
- Reed flats and field furrows are not objects at all: they are ground classes, with the speed the ruleset gives them.
- White cranes are renderer ambience: no cell, no position, no rules.

## Generation order and guarantees

The generator runs from the match seed's generation stream, in order: terrain fields, water, ground classes, the road with its crossings and spawn, building sites with their site painting, footpaths, then accessories. Accessories are interactive props and scenery, including lanterns. Alongside the village it records which cells belong to which course and which cell witnesses each interactive prop, so the guarantees below are checkable without re-deriving the generator's own reasoning.

Every seed satisfies:

- The stable features are each placed once: the well pump, the market, the inn, the repair shed, and the beacon bell.
- The walkable cells, crossings and building floors included, form one connected region under body clearance.
- Five homes exist, and every doorway run opens onto walkable cells.
- Every interactive prop has a connected walkable standing cell within reach of the nearest point of its collision shape, with room for the full body and an unblocked line to that point.
- Building sites do not overlap one another, water, the road, the boundary, or placed props, and every site keeps `sites.margin` of clear cells around it. An interior prop stays on its building's floor, leaves the doorway run open, and does not overlap another prop.
- The visitor spawn sits on a road cell at `network.spawn.edge_inset`, clear of every footprint.
- Water reaches the north edge inside `water.entry_band` and the south edge in exactly three runs at least `water.mouth_separation` apart. Past the shared fork and confluence area, no branch self-contacts or contacts a sibling.
- The road spans the west edge to the east edge, crosses each channel exactly once and the trunk never, and every road or path cell over water carries bridge ground. Each channel carries at most one footpath crossing.

## Generation tuning

`generation.json` is the whole of the generator's tuning, validated when the generation package imports. Its groups follow the generation stages:

| Group | What it holds |
| --- | --- |
| `fields` | The elevation and moisture noise: lattice spacing, octave count, per-octave spacing and amplitude, and the elevation field's southward slope bias. |
| `water` | `entry_band`, `fork_band`, `trunk_width`, `channel_width`, `mouth_separation`, `edge_margin`, and the walker's step length, brush, and the weights blending its own momentum, the downhill gradient, and the pull toward the fork. |
| `grounds` | The moisture and elevation thresholds that select reed and field cells, and the majority-smoothing passes that turn them from speckle into terrain. |
| `network` | `road` (width, per-class search costs, turn cost, crossing-angle cost, apron), `path` (width and the discount that merges routes onto existing ones), and `spawn` (`edge_inset`, `clearance`). |
| `sites` | `margin`, `cluster_count`, and the weights scoring a bank region on proximity, flatness, dryness, and separation. |
| `accessories` | One nested group per catalog placement token, such as `accessories.pine`, `accessories.lantern`, and `accessories.stall`, holding spacing, candidate budgets, scatter probability, and companion rules. |
| `redraw` | The redraw cap. |

A key belongs here when changing it changes the village. Anything that changes how the village looks on screen rather than where things are lives in the renderer's own presentation configuration, so visual calibration can never move a building.

## Naming

The village uses plain functional labels: the well plaza, the market, the inn, the repair shed, the bell, and the west, centre, and east channels. Further names and lore stay out, per the worldview's naming guide.
