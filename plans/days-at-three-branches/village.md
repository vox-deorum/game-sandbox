# Three Branches: Village Specification

This document specifies Three Branches, the village of Days at Three Branches: its landscape, buildings, props, and the rules that generate them. The [ruleset](ruleset.md) stays the source of game rules; this document is the source of place. The setting behind it lives in the [worldview](worldview.md).

There is no canonical map. The village is whatever these rules generate from the match seed. Every season pins the same default seed, so the course plays one familiar village throughout, while any seed still yields a valid village.

## Frame and scale

- The village is exactly 100 by 100 meters, with the origin at the southwest corner, x running east and y running north.
- The boundary is impassable on all four sides.
- Nothing in this document fixes a coordinate. Every rule is a construction step with bounds.

## Waterways

- The trunk river enters the north edge within its middle third, 5 to 7 m wide, and meanders south, its course shaped by the seed's terrain so the water reads grown rather than drafted.
- Between two fifths and three fifths of the way down the village, the trunk forks into three channels, 4 to 6 m wide, that fan out and reach the south edge. Adjacent mouths land at least 20 m apart. The fork is the village's namesake and its visual center.
- The channels meander the same way. Water is impassable everywhere.
- Reed flats gather on low wet banks and at the channel mouths.

## The road and paths

- The raised road enters at the west edge, winds east, and exits the east edge, 4 to 5 m wide.
- The road runs south of the fork, so it crosses each channel exactly once, roughly square-on, at a bridge, and never crosses the trunk.
- A bridge's deck is a rectangle along its crossing route, 2 to 3 m wide, spanning its channel bank to bank plus 1 m of apron on each bank; every deck carries road ground.
- Footpaths, 1.5 to 2.5 m wide, branch from the road to the well plaza, every home cluster, and every shrine. Paths curve; nothing in the village runs straight for long.
- The visitor's spawn point is fixed on the road's centerline, 1 m in from the west edge, clear of every footprint.

## Grounds

The ruleset's ground table sets the speed limits; this document places the classes:

| Ground      | Placed                                                   |
| ----------- | -------------------------------------------------------- |
| Road        | the raised road's surface, every bridge, every footpath  |
| Open ground | all remaining walkable land, building interiors included |
| Fields      | the furrowed terraces along the lower channel banks      |
| Reed bank   | the reed flats on outer bends and at the channel mouths  |

Where placed grounds overlap, the earlier row wins: a footpath through a reed flat carries road ground.

## Districts

Districts are anchors along the road and channels, not fixed positions:

- The well plaza sits in the crook of the fork: an open clearing holding the well pump, reached by a footpath from the road.
- The market sits on the road's middle stretch, its stalls scattered loosely on both sides of the road with the notice board among them.
- The inn stands on the road's east stretch, facing the road.
- The repair shed and the beacon bell stand on the road's west stretch, so the visitor walking in passes them first.
- Homes gather in two or three loose clusters on banks the terrain favors, each cluster reached by a footpath and, when it lies across water, a bridge.
- Fields step down in low terraces between the home clusters and the south edge, their furrows following the channel curves.

## Buildings and interiors

- Three building types, all enterable: the home (five instances, 6 by 5 m), the inn (one, 10 by 8 m), and the repair shed (one, 6 by 6 m). The outer rectangle of each building is its placement footprint.
- Every building is one room with a single permanent doorway opening, 1.2 m wide, facing the nearest path. The solid wall perimeter is the outer rectangle with that doorway gap removed, and the interior is walkable. Movement collision and line-of-sight checks use the same wall segments derived from this geometry. The opening carries sight, hearing, and speech normally.
- Doorways open onto walkable ground, never onto water, another footprint, or the boundary.
- The inn hearth stands inside the inn and the repair bench inside the shed, each against the wall opposite the doorway. Homes hold no interior props; each home's garden plot sits outside, flush against one exterior wall.
- Homes are numbered `home_0` through `home_4` in the order the generator places them, and `npc_i` lives in `home_(i mod 5)`, so cast_10 seats two villagers per home. The village always generates five homes, whatever the plan, so a seed yields one identical layout for cast_5 and cast_10 alike.

## Props

Activities, states, and the use rules are the ruleset's; this table places the instances and fixes the counts:

| Prop | Placement | Footprint | Count |
| --- | --- | --- | --- |
| Market stall | both sides of the road at the market | 1.5 x 1.5 m | 5 |
| Lantern post | spaced along the road, denser near the market | 0.6 x 0.6 m | 9 |
| Bench | the well plaza, the market, and the inn front | 1.6 x 0.5 m | 5 |
| Roadside shrine | road bends | 1.5 x 1.5 m plus roof posts | 2 |
| Notice board | the market | 0.6 x 0.6 m | 1 |
| Garden plot | against home walls, one per home | 2 x 2 m | 5 |
| Inn hearth | inside the inn | 0.6 x 0.6 m | 1 |
| Repair bench | inside the repair shed | 1.6 x 0.5 m | 1 |
| Well pump | the well plaza | 0.6 x 0.6 m | 1 |
| Beacon bell | beside the road's west stretch | 0.6 x 0.6 m | 1 |

- Every prop has a standing position in the connected walkable region within the ruleset's 1.5 m reach. A character can stand there with its full body clear of solid geometry and an unblocked line to the prop.

## Scenery

- Solid scenery blocks movement and never blocks perception: red pines in clusters of two to five, market crates and barrels (one or two beside each stall), and the four roof posts of each shrine. Solid scenery never breaks the connected walkable region, a doorway's approach, or a prop's reach.
- Passable scenery carries its ground class: reed flats are reed-bank ground, with the concealment and speed the ruleset gives them, and field furrows are field ground.
- White cranes are renderer ambience: no footprint, no position, no rules.

## Generation order and guarantees

The generator runs from the match seed's generation stream, in order: terrain and grounds, district anchors and buildings, the road network with its bridges and footpaths, scenery and props. Every seed satisfies:

- The stable features are each placed once: the well pump, the market, the inn, the repair shed, and the beacon bell.
- The walkable ground, bridges and building interiors included, is one connected region.
- Five homes exist, and every doorway opens onto walkable ground.
- Every prop has a connected walkable standing position within reach, with room for the full body, along an unblocked line.
- Building placement rectangles do not overlap one another, water, the road, the boundary, or exterior objects. Other exterior footprints do not overlap. An interior prop stays inside its building, leaves the doorway open, and does not overlap another prop.
- The visitor spawn sits on the road's centerline 1 m inside the west edge, clear of every footprint.
- Each channel carries the road's bridge and at most one footpath bridge; the trunk carries none.

## Naming

The village uses plain functional labels: the well plaza, the market, the inn, the repair shed, the bell, and the west, center, and east channels. Further names and lore stay out, per the worldview's naming guide.
