# Step 4: The village generator

Status: planned.

Part of [the plan](../README.md). This is build-order step 4: the seeded construction of Three Branches under [village.md](../village.md)'s guarantees, replacing the step 2 fixture village. The hands-on surface is any seed's village explored in the browser debug view through a local watch session, with the guarantee suite green across a pinned seed batch.

## Why this is its own seam

village.md is a complete generative specification with hard guarantees and no game rules. The generator is pure geometry over the layout types step 2 fixed, and building it after the debug renderer means every generation change is inspected visually in the real viewer instead of through a throwaway map tool.

## What to build

### The generation pipeline

village.md's fixed order, drawing only from the generation stream: boundary and river, road and bridges, district anchors, buildings and homes, footpaths, ground classes, scenery, props. Prop counts, footprints, and placement districts come from `props.json`. Every guarantee is enforced for every seed: the stable features placed once, one connected walkable region including interiors and bridges, ten homes with doorways onto walkable ground, a reachable walkable point within reach of every prop, no footprint overlaps or intrusions into water, road, or boundary, the spawn clear on the road centerline, and the per-channel bridge counts.

### The swap

`reset(seed)` builds the village from the generation stream instead of loading the fixture village. The layout types, observation schema, overlay, and renderer are untouched: the generated layout flows through the same contract the fixture village proved. The fixture village stays available to the engine tests that want a known map.

## Tests

- The guarantee property suite across a pinned seed batch.
- Same-seed determinism, byte for byte.
- Meander, radius, width, and count bounds from village.md.
- Connectivity by flood fill across walkable ground, bridges, and interiors.
- The observation's `village` Dict equals the generated layout, field for field.
- The recording size budget re-measured on a full cast_10 day over the generated village.

## Done when

Any seed renders as a valid, connected, fully guaranteed village in the browser debug view, and the suite is green across the batch.
