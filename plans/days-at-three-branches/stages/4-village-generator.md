# Step 4: The village generator

Status: in progress. Gate A is approved, and gate B is implemented and awaiting owner review.

Part of [the plan](../README.md). This step replaces the step 2 fixture behind unchanged `build_village(seed)` with a seeded Three Branches village under [village.md](../village.md). It has two owner-reviewed gates: land and water, then settlement, routes, and dressing. The step ends with the guarantee suite across a pinned seed batch and one owner-blessed course default seed.

## Correctness, review, and configuration

### Correctness and review

The generator paints cells and places rectangles over step 2 grid types. Engine, environment, recording, and renderer contracts do not change. [village.md](../village.md#generation-order-and-guarantees) and tests define the mechanical guarantees. The owner assesses whether a village looks grown rather than drafted through `npm run play -- three_branches watch --seed N` with the collision overlay enabled. Record each sign-off and its date in this file. No review tooling is added.

### Configuration and data ownership

`generation.json` owns every tunable number in the groups [village.md](../village.md#generation-tuning) names. Tests read bounds from that file, except frame-derived arithmetic tests that intentionally own their number. Gate A generated the land and padded the rest of the layout with fixture content so the browser still received a complete `Layout`. Gate B generates all of it, and the padding is gone from the generation package. `fixture.py` remains the engine-test map and the input for the engine, physics, and perception tests, which do not build through `build_village`.

A prop carries its catalog rectangle turned to its facing, so an east or west facing trades the rectangle's width and height. Without that a garden could only lie flush along a north or south wall, which would decide every home's doorway for it. The shape stays axis-aligned, and `layout.footprint` is the one place that turn is worked out.

| Area | Ownership |
| --- | --- |
| Stream and output | `random.Random(f"{seed}:village")`; `generate(seed)` returns `Layout` and internal report, while `build_village(seed)` returns only the layout. A reset with no seed builds seed 0 |
| Modules | `config`, `fields`, `water`, `grounds`, `sites`, `network`, `paths`, `accessories`, `validate`; `carve` paints brushes and `walk` carries the one walker that `water`, `network`, and `paths` all steer |
| Inputs | `random`, `math`, `grid.py`, and `geometry.py`; `env.py` remains the only numpy importer |
| Internal report | Trunk and channel masks, the shared fork area and the fork itself, prop witness cells, redraw count, and reset timing as one number, since generation and validation are both what a reset spends. Only the guarantee suite and batch summary consume it. The suite re-derives every guarantee from the layout and reads the report only for the water masks, which no layout publishes |
| Stable output | Homes are `home_0` through `home_4` in placement order. Props use catalog type order, placement order within type, and contiguous ids, including the single `bell_0` |

### Tuning and budgets

`config.py` owns loading and validating `generation.json` and holds the shared `Retry`, which keeps every stage module free of the others. The shipped frame is 120 by 120 cells. Frame-relative fields use explicit `_percent` names and resolve to integer cells at load time, leaving generator modules on simple cell values. They cover map positions, macro terrain scale, walker travel, and meander wavelengths. Metre-scale widths, clearances, building footprints, and fixed counts remain absolute. Each stage checks its own output as it commits rather than deferring to a separate pass, so `validate.py` owns only the whole-village assembly and ledger. Connectivity is established by the guarantee suite from the published layout rather than demanded of the generator. A `budget` there is a candidate budget: how many placements a mandatory stage may draw and test before it gives up and the layout is drawn again. A walker's travel budget is not one of those, and optional placement carries no budget at all, because it skips rather than redraws.

### Determinism

The labelled stream remains separate from the scripted visitor's `random.Random(seed)`. Draw order is fixed per code version. Same-build output is exact; committed recordings replay rather than re-simulate.

## Construction and redraws

### Construction order

The committed order is terrain fields, water, ground classes, district anchors with building sites and painting, the road with its crossings and spawn, footpaths, then accessories. Each construction stage reads the committed output of the ones before it.

### Redraws

Mandatory placement uses its `generation.json` candidate budget. Exhaustion discards the partial village and redraws the whole layout on the same stream. Lantern and pine candidates are optional and skip invalid placements. Assembly and reset validation run within the loop, and there is no connectivity ladder that strips the optional dressing: what fits is kept in the shipped village. Only mandatory failure redraws the layout, while local retries redraw only their own choices. `redraw.cap` raises `RuntimeError` naming the seed if exceeded.

### Reset timing

Reset timing includes generation and validation, reported as the one number a reset spends. The batch summary records it for every seed, including reset-default seed 0 and conformance seed 17. It is reported only, with no timing limit or pass/fail assertion. `pytest` records it as a property and prints it, so a `-s` run of the timing test is the batch summary and no other machinery is needed.

### Noise fields

Two pure-Python fractal value-noise fields, elevation and moisture, are sampled once per cell before construction. A lattice covering the frame plus one ring of nodes uses stream draws, configured octaves, smoothstep-faded bilinear interpolation, and unit normalization. Elevation also takes the configured southward slope bias, which is why the road reads moisture rather than elevation for its dry ground: the bias runs one way across the road band, so elevation would only pin the road to a band edge. Spacing, octave amplitudes, and bias remain `fields` tuning. Fields are generation-only artifacts.

## Gate A: land and water

This gate implements only the [waterways](../village.md#waterways) guarantees, and it pads fixture buildings, props, scenery, and the spawn.

| Construction | Implementation |
| --- | --- |
| Water | A cell walker starts in `water.entry_band_percent`, paints a round brush at configured step length, and blends momentum, elevation gradient, pull toward where it is going, a per-course meander, edge repulsion, and repulsion from courses already carved. Courses are carved one at a time from west to east, so each channel only avoids what is already there. An explicit fork and confluence mask in `water.fork_band_percent` creates the channels: the mask is the pool at the fork plus each channel's opening `water.fork_steps_percent` reaches, which fan apart by `water.fan_degrees`. Outside it, width-aware clearance rejects or reroutes self and sibling contact, and steering senses `water.walker.look_ahead` further than the check blocks so a course turns away before it is stopped. A course runs straight for `water.edge_straight_percent` where it meets a frame edge, so its entry and mouth runs come out at the width it was carved with. Per-seed widths and blends stay within configured ranges; brush widths are odd, which is what a cell-centred round brush carves exactly. Once carving is done, land the water ringed is flooded and joins the course holding most of its edge, because such a cell is river rather than somewhere to stand, and the courses as they finally stand are checked for contact. The carver cannot see that on its own: the shared area grows while the channels are carved, and flooding moves cells between courses. |
| Grounds | Moisture-near-water reeds, including all mouths, and flat low dry lower-bank fields use `grounds` thresholds and configured majority smoothing. |

Gate A tests cover the configured water geometry, three south-edge runs, fork-only contact and clearance, the fork depth, smoothed in-frame grounds and reeds at every mouth, a padded visitor that can stand and walk, deterministic equal builds and differing batch seeds, and observation `village` equality with the layout. Bounds come from `generation.json`.

The owner signs off land and water.

### Gate A sign-off

Approved 2026-08-12. The owner browsed `npm run play -- three_branches watch --seed N` across the pinned batch with the collision overlay and signed off the land and water.

## Gate B: settlement, routes, and dressing

This gate implements [buildings and interiors](../village.md#buildings-and-interiors) and the remaining route, prop, and scenery work in [generation order and guarantees](../village.md#generation-order-and-guarantees), whose connectivity the suite asserts from the published layout.

### Sites and buildings

- Score committed terrain. The well plaza sits in a clear fork crook; the shed and bell anchor the west third, the market with five catalog stalls and the board the middle, and the inn the east, so the west-to-middle-to-east arrangement holds before the road is walked.
- An anchor is a point inside the road band, and no site or margin enters that band, leaving the road a clear run.
- Place inn and shed beside their anchors, then five homes. A home draws whole candidate sites across the land south of the fork (the trunk cannot be bridged) and keeps the one scoring best on configured bank proximity, flatness, dryness, and distance from already-placed homes. Scores judge each whole site rather than a point, so a home is judged on the ground it really stands on.
- Candidates reserve their rectangle and `sites.margin`, choose a doorway a footpath could carry back to the band, and never face away from the road, since a site stands wholly north or south of it.

### Road, crossings, and spawn

- Cross each channel once, at the band row where a straight east cut is shortest and both banks carry `network.road.apron` of dry ground, preferring the row nearest the previous crossing so the road does not zigzag between channels. District anchors and those crossings form one west-to-east target list.
- A walker carries the road across the frame on a continuous heading that blends momentum, pull toward its next target, a climb toward drier ground, repulsion from water, a push away from the band edges, a per-road meander, and wobble, the same way a water course is carved.
- It runs straight for `network.road.edge_straight_percent` at each frame edge and locks straight through every crossing, so the entry, the exit, and every bridge deck come out at the carved width.
- It never paints water outside a crossing and never runs back over its own trail, so one deck per channel and one connected road follow from the walk rather than from a check.
- The spawn is the configured west inset road cell with configured clearance.

### Footpaths

- The weighted search from the road and from any worn path decides what a route joins and where it may cross, nothing about its shape.
- Joining a worn path rather than always running back to the road is what makes footpaths branch instead of running as private spurs; targets are taken farthest first so the long route lays the way the short ones join.
- An ant walks each route from the doorstep down the plan through the shared walker, blending momentum, a pull toward where it is going, a per-path meander, and wobble, the same way the road is carried. It stops the moment it meets a way that already carries people, and crosses water only on the straight run the search proved.
- A walk with nowhere left to turn, or one that has spent `network.path.walker.step_budget_per_frame_cell`, hands the rest of its leg back to the plan, so a doorway the search could reach stays joined either way.
- A corner step is painted through one of its sides, so a path is never a dotted diagonal, and it is refused where both sides are blocked. Water crossings stay within the specified bounds, and a channel takes at most one.

### Accessories

- A road-arc helper supplies positions and facings, skipping the stretches where the road is up on a bridge. Anchored spots serve stalls, board, shrines, hearth, bench, pump, and bell.
- Benches split across plaza, market, and inn front. Gardens centre and flush their long edge to the home wall opposite the doorway, use lower-index placement for an ambiguous centre, and never slide. Hearth and bench are on interior floor against that opposite wall.
- One or two 2 by 2 crates sit by each stall; candidate origins account for the complete crate footprint. Shrines take the sharpest turns of the road centreline and may slide along it to find room.
- Lanterns alternate seeded road sides, try the other side once, and skip blocked stations. Pines place last through optional anchors and companions, each drawing a size from `accessories.pine.size` and shrinking to the base size when the drawn solid would not fit. Catalog placement tokens and `accessories` tuning drive all counts, footprints, districts, spacing, scatter, companions, and budgets.

### Witnesses and validation

- Each interactive prop banks a body-clear, line-clear witness within reach of its collision shape. Later solids protect witnesses, doorways, and spawn clearance, and no solid overlaps a solid already standing. Every scenery and prop cell is reserved exactly once; a pine whose drawn solid would escape that reservation is planted at its base size instead. `accessories.pine.size` gives the inclusive scale bounds each pine draws between.
- The guarantee suite floods the published layout from the spawn with the engine's `body_clear` node and segment step tests, requiring all doorway runs, start poses, and witness cells to join the region.

Gate B tests cover stable features and five homes, site margins and painting, road span and crossing rules, bridge deck shape and aprons, spawn clearance, distinct prop cells, doorway and path relationships, footpath crossings, independently re-derived witnesses, and connectivity across the full batch established from the published layout. How far apart the homes settle is an owner call in the browser, so no test measures it.

The owner signs off the dressed village, opening step close.

### Gate B sign-off

Pending. The owner browses `npm run play -- three_branches watch --seed N` across the pinned batch and records the date here.

## Gate close and seed blessing

During a gate, tuning consists of local code and configuration work plus browser review. On a gate close, regenerate `scripts/gen_three_branches_fixture.py`. Its property assertions avoid pinned text and ticks. Regenerate even after a mid-tuning commit. At the first close, revise step 3 to state that its fixture is generated.

The pinned full-fidelity batch is `0, 1, 2, 3, 5, 7, 11, 17`; 0 is the reset default and 17 the conformance seed. The owner browses it in local watch sessions and blesses one course default seed. Mechanical close work may use a provisional batch seed and re-runs once blessing occurs. The blessed seed is `test_budget`'s seed and the fixture script's `SEED`, and is recorded here. Later season configuration pins that same blessed seed for each season.

At step close, re-measure `test_budget` at the blessed seed for 1201 JSONL lines, replay identity, and cadence. Revalidate the scripted visitor across the batch for a full unstalled day and per-game reset budget. Rerun the fixture script at the blessed seed, name it in step 3, run the full browser suite, and report every batch seed's generation-and-validation reset time.

## Tests

`environments/three_branches/tests/test_generation.py` is the full-batch guarantee suite. It tests structure, not aesthetics: no bend-radius, corridor, monotonicity, curvature, bend inventory, or variety assertions. Shrine assertions cover placement and witnesses. Configuration bounds are read at test time. A module-scoped fixture builds each batch seed once, so a suite run is one build per seed.

`test_layout_and_physics.py` and `test_engine.py` build through `build_fixture` rather than `build_village`, because their assertions describe the fixture map. `test_environment_and_chat.py` derives its chat positions from the layout it reset rather than naming road cells.

- Verify fixed feature counts, home and canonical prop identities, all waterways guarantees, road and bridge guarantees, spawn clearance, and configuration-derived mask behavior.
- Verify reserved sites, margins, painting, floor props and open doorways, paths, non-overlapping final ledger, independently found prop witnesses, and connectivity from the published layout.
- Verify same-seed equality, batch-seed divergence, redraw-cap non-exhaustion, `village` observation equality, and frame-derived conversion, margin, and width arithmetic. Lantern and pine skips do not redraw land, road, or buildings.
- Report reset time for every batch seed. Do not assert a timing threshold.

Per gate close, regenerate the fixture. At final close, re-measure `test_budget` at the blessed seed.

## Build order

1. Gate A: stream, redraw loop, fields, the water walker, grounds, padding assembly with its spawn, tests and conformance, review, sign-off, and close procedure.
2. Gate B: sites and district anchors, painting, crossing selection, the road walker with its crossings and spawn, footpaths, accessories, witnesses, validation, full-batch suite, review, sign-off, and close procedure.
3. Bless and close: provisional fallback if necessary, fixture regeneration at blessed seed, budget measurement, step 3 revision, full browser suite, and handoff sweep.

## Done when

Any seed builds a valid village under the village guarantees, with connectivity asserted by the guarantee suite over the pinned batch; both dated owner sign-offs are recorded here; guarantee and conformance suites are green across the full batch; the blessed-seed day replays identically; regenerated fixtures keep renderer and e2e suites green; and the owner has blessed the course default seed.
