# Three Branches: Village Specification

This document owns the seeded layout, placement, spawn, and generation guarantees for Three Branches. [Ruleset](ruleset.md) owns game rules, including NPC home assignment. [Worldview](worldview.md) supplies the setting.

There is no canonical map. The match seed generates a valid village. Step 4 blesses one course default seed; later [per-season configuration](../../docs/specs/seasons.md#per-season-configuration) pins that same seed for every season.

Construction order is terrain fields, water, ground classes, road and spawn, building sites, footpaths, then accessories. The generator records cell ownership and an interaction witness for each prop. Tests use those records to check guarantees.

`generation.json` holds every generator number. [Generation tuning](#generation-tuning) names the keys and groups; code and tests read values from the file.

## Frame and scale

`rules.json` fixes `cells_x`, `cells_y`, and `cell_size`: the shipped frame is 100 by 100 cells at 1 metre each. Code reads those values.

The origin is the southwest corner. x runs east and y north. Zero-indexed cell `(cx, cy)` covers `cx * cell_size` to `(cx + 1) * cell_size` metres east and `cy * cell_size` to `(cy + 1) * cell_size` metres north. Its centre is `((cx + 0.5) * cell_size, (cy + 0.5) * cell_size)`.

Characters use continuous metre positions. The grid constrains the map, while ground classes and placed props occupy cells. All four frame edges are impassable. Rules express bounds in cells without fixing coordinates.

## Grounds

Each cell has one ground class, which controls speed, standing, and sight. `rules.json` holds its code and properties.

The generator places water, road, path, bridge, field, reed, and open ground. Building sites paint floor, wall, and door ground before footpaths and accessories. Later painting wins: a footpath through reed uses path ground and a crossing over water uses bridge ground.

Water and wall are impassable. Wall alone blocks sight. Door ground carries sight, hearing, and speech like open ground.

## Waterways

- The trunk enters the north edge inside `water.entry_band`, at a width from `water.trunk_width`, and meanders south along seed-shaped terrain.
- Within `water.fork_band` below the north edge, it forks into three channels at widths from `water.channel_width`. They fan to the south edge, with mouths at least `water.mouth_separation` apart.
- Outside the shared fork and confluence area, a channel rejects or reroutes self-contact and sibling contact. Water is impassable.
- Courses stay beyond `water.edge_margin` and collect reed flats on wet banks and at channel mouths.

## The road and paths

- The raised road enters from the west, winds across the village, exits east, and uses width `network.road.width`.
- It runs south of the fork, crosses each channel exactly once, never crosses the trunk, and paints bridge ground over water with `network.road.apron` of bank on each side.
- Footpaths curve from the road to the well plaza, each home cluster, and each shrine at width `network.path.width`. Routes do not run straight for long.
- The connectivity flood fill uses the same body clearance as physics.
- The visitor spawns on a road cell `network.spawn.edge_inset` from the west edge, with `network.spawn.clearance` free of every footprint.

## Districts

Districts are seed-placed anchors along the road and channels.

- The well plaza occupies the fork crook, holds the well pump, and connects to the road by a footpath.
- The market occupies the road's middle stretch, with loosely scattered stalls and the notice board.
- The inn faces the east road stretch.
- The repair shed and beacon bell stand at the west road stretch.
- Homes form `sites.cluster_count` loose bank-side clusters. Each has a footpath and, when necessary, a crossing.
- Fields terrace between home clusters and the south edge, following channel curves.

## Buildings and interiors

Building types and dimensions are in the [canonical catalog](ruleset.md#canonical-catalog). An instance is a semantic group: homes provide ids, while inn and shed identify interior prop placement.

- A site is an unrotated axis-aligned rectangle. Its selected doorway side paints floor inside, wall around the perimeter, and a 2-cell door run through that side.
- Doorways face their planned footpath approach and open to walkable cells, never water, another footprint, or the boundary.
- Walls block movement, sight, presence, and speech. Doorways carry all four.
- The inn hearth and repair bench sit inside against the wall opposite the doorway. Homes have no interior props. Each home has an outside garden plot flush with the exterior wall opposite its doorway. When centering an odd-size difference, use the lower-index position.
- Homes are numbered `home_0` through `home_4` in placement order. [Ruleset home assignment](ruleset.md#the-village) maps NPCs to them. Cast size does not change the layout.

## Props

The [canonical catalog](ruleset.md#canonical-catalog) owns interactive types, activities, and states. This document owns placement.

- Stalls sit on both market-road sides. Lanterns use road stations, denser at market. Benches go at the well plaza, market, and inn front. Shrines occupy road bends, and the notice board is in the market.
- Garden plots use the home-doorway rule. The hearth and repair bench use their interior placements. The pump is in the well plaza and the bell beside the west road.
- An interactive prop reserves its catalog rectangle, uses its catalog collision shape, faces a cardinal direction, and is never angled. Its underlying ground remains unchanged.
- Every interactive prop has a connected, body-clear standing cell within ruleset reach of its collision shape and an unblocked line to it.

## Scenery

Scenery types are in the [canonical catalog](ruleset.md#canonical-catalog). Red pines occupy road stations and scattered open cells, with optional companions. Market crates sit beside stalls. Scenery is solid but does not break connected walkable ground, doorway approaches, or prop reach.

Reed flats and field furrows are ground, not objects. White cranes are renderer ambience with no cell, position, or rule.

## Generation order and guarantees

Generation consumes the match seed's generation stream in the opening construction order. Accessories include interactive props, scenery, and lanterns. The retained ownership and witness records let tests verify placement without reproducing generator logic.

Every seed satisfies:

- Stable features appear once: well pump, market, inn, repair shed, and beacon bell.
- Walkable cells, crossings and building floors included, form one body-clear connected region.
- Five homes exist and every doorway run opens onto walkable cells.
- Every interactive prop has a connected, body-clear standing cell in reach of its collision shape with an unblocked line.
- Building sites do not overlap sites, water, road, boundary, or placed props. Each keeps `sites.margin` clear cells. Interior props stay on floor, leave doorway runs open, and do not overlap props.
- Visitor spawn is on the road at `network.spawn.edge_inset`, clear of every footprint.
- Water enters north inside `water.entry_band` and exits south in exactly three runs at least `water.mouth_separation` apart. Beyond the shared fork and confluence, branches neither self-contact nor contact siblings.
- The road spans west to east, crosses every channel once and the trunk never. Road and path crossings use bridge ground. A channel has at most one footpath crossing.

## Generation tuning

`generation.json` contains all generator tuning and is validated when the generation package imports. Its groups follow construction order.

| Group | What it holds |
| --- | --- |
| `fields` | Elevation and moisture noise: lattice spacing, octave count, per-octave spacing and amplitude, and southward slope bias. |
| `water` | `entry_band`, `fork_band`, `trunk_width`, `channel_width`, `mouth_separation`, `edge_margin`, walker step and brush, and momentum, downhill, and fork-pull weights. |
| `grounds` | Moisture and elevation thresholds for reed and field, plus majority-smoothing passes. |
| `network` | `road` width, search costs, turn cost, crossing-angle cost, apron; `path` width and merge discount; `spawn` `edge_inset` and `clearance`. |
| `sites` | `margin`, `cluster_count`, and bank scores for proximity, flatness, dryness, and separation. |
| `accessories` | One nested catalog-placement group, such as `accessories.pine`, `accessories.lantern`, and `accessories.stall`, with spacing, candidate budgets, scatter probability, and companion rules. |
| `redraw` | Redraw cap. |

A value belongs here when changing it changes the village. Visual-only tuning belongs to renderer presentation configuration.

## Naming

Use functional labels: well plaza, market, inn, repair shed, bell, and west, centre, and east channels. Further names and lore stay out under the [worldview naming guide](worldview.md#naming-guide).
