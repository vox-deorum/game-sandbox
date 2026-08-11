# Step 4: The village generator

Status: planned.

Part of [the plan](../README.md). This step replaces the step 2 fixture behind unchanged `build_village(seed)` with a seeded Three Branches village under [village.md](../village.md). It has two owner-reviewed gates: land and routes, then settlement and dressing. The stage ends with the guarantee suite across a pinned seed batch and one owner-blessed course default seed.

## Correctness, review, and configuration

The generator paints cells and places rectangles over step 2 grid types. Engine, environment, recording, and renderer contracts do not change. [village.md](../village.md#generation-order-and-guarantees) and tests define the mechanical guarantees. The owner assesses whether a village looks grown rather than drafted through `npm run play -- three_branches watch --seed N` with the collision overlay enabled. Record each sign-off and its date in this file. No review tooling is added.

`generation.json` owns every tunable number in the groups [village.md](../village.md#generation-tuning) names. Tests read bounds from that file, except frame-derived arithmetic tests that intentionally own their number. At Gate A, `build_village(seed)` switches to generation and pads ungenerated objects with fixture content. The browser receives a complete `Layout`. Review covers only generated content; padded combinations may violate guarantees. Gate B removes padding from the generation package; `fixture.py` remains the engine-test map.

| Area | Ownership |
| --- | --- |
| Stream and output | `random.Random(f"{seed}:village")`; `generate(seed)` returns `Layout` and internal report, while `build_village(seed)` returns only the layout |
| Modules | `fields`, `water`, `grounds`, `network`, `sites`, `accessories`, `validate`; `carve` paints brushes and `paths` performs weighted search |
| Inputs | `random`, `math`, `grid.py`, and `geometry.py`; `env.py` remains the only numpy importer |
| Internal report | Trunk and channel masks, prop witness cells, redraw count, and reset timing. Only the guarantee suite and batch summary consume it |
| Stable output | Homes are `home_0` through `home_4` in placement order. Props use catalog type order, placement order within type, and contiguous ids |

The labelled stream remains separate from the scripted visitor's `random.Random(seed)`. Draw order is fixed per code version. Same-build output is exact; committed recordings replay rather than re-simulate.

## Construction and redraws

The committed order is terrain fields, water, ground classes, road with crossings and spawn, building sites and painting, footpaths, then accessories. Each stage reads the committed output of earlier stages. Mandatory placement uses its `generation.json` candidate budget. Exhaustion discards the partial village and redraws the whole layout on the same stream. Lantern and pine candidates are optional and skip invalid placements. Assembly and reset validation run within the loop. Connectivity first retries the mandatory layout without pines, then without lanterns. Only mandatory failure redraws the layout, while local retries redraw only their own choices. `redraw.cap` raises `RuntimeError` naming the seed if exceeded.

Reset timing includes generation and validation. The batch summary records it for every seed, including reset-default seed 0 and conformance seed 17. It is reported only, with no timing limit or pass/fail assertion.

Two pure-Python fractal value-noise fields, elevation and moisture, are sampled once per cell before construction. A lattice covering the frame plus one ring of nodes uses stream draws, configured octaves, smoothstep-faded bilinear interpolation, and unit normalization. Elevation also takes the configured southward slope bias. Spacing, octave amplitudes, and bias remain `fields` tuning. Fields are generation-only artifacts.

## Gate A: land and routes

This gate implements [waterways](../village.md#waterways) and the road, crossings, and spawn guarantees in [the road and paths](../village.md#the-road-and-paths). It pads fixture buildings, props, and scenery, with no footpaths.

| Construction | Implementation |
| --- | --- |
| Water | A cell walker starts in `water.entry_band`, paints a round brush at configured step length, blends momentum, elevation gradient, and fork pull, and applies edge repulsion. An explicit fork and confluence mask in `water.fork_band` creates the channels. Outside it, width-aware clearance rejects or reroutes self and sibling contact. Per-seed widths and blends stay within configured ranges. |
| Grounds | Moisture-near-water reeds, including all mouths, and flat low dry lower-bank fields use `grounds` thresholds and configured majority smoothing. |
| Road and spawn | Weighted search from west entry south of the fork to east exit uses `network.road` ground, turn, and crossing-angle costs. Width-aware centreline masks and water intersections create continuous roads, bridge decks, and `network.road.apron` banks. The spawn is the configured west inset road cell with configured clearance. |

Gate A tests cover the configured water geometry, three south-edge runs, fork-only contact and clearance, road span and crossing rules, bridge and widened-mask continuity, configured search costs, smoothed in-frame grounds, deterministic equal builds and differing batch seeds, and observation `village` equality with the layout. Bounds come from `generation.json`.

The owner signs off land, water, and road.

## Gate B: settlement and dressing

This gate implements [buildings and interiors](../village.md#buildings-and-interiors) and the remaining route, prop, scenery, and connectivity guarantees in [generation order and guarantees](../village.md#generation-order-and-guarantees).

| Construction | Implementation |
| --- | --- |
| Sites and buildings | Score committed terrain and road. Place the well plaza in a clear fork crook; put shed and bell west, market and five catalog stalls with board in the middle, and inn east. Seed `sites.cluster_count` home clusters by configured bank proximity, flatness, dryness, and separation, then place inn and shed before five homes. Candidates reserve their rectangle and `sites.margin`, choose a doorway with viable road route, preview site painting, and leave home floors empty. |
| Footpaths | Use the same weighted search from road cells to plaza, selected doorways, and shrines. `network.path.width` and merge discount favor shared routes. Water crossings stay within the specified bounds. Doorways open onto walkable path cells and face their nearest path. |
| Accessories | A road-arc helper supplies positions and facings. Anchored spots serve stalls, board, shrines, hearth, bench, pump, and bell. Benches split across plaza, market, and inn front. Gardens centre and flush their long edge to the home wall opposite the doorway, use lower-index placement for an ambiguous centre, and never slide. Hearth and bench are on interior floor against that opposite wall. One or two crates sit by each stall; shrines use generator-selected road bends. Lanterns alternate seeded road sides, try the other side once, and skip blocked stations. Pines place last through optional anchors and companions. Catalog placement tokens and `accessories` tuning drive all counts, footprints, districts, spacing, scatter, companions, and budgets. |
| Witnesses and validation | Each interactive prop banks a body-clear, line-clear witness within reach of its collision shape. Later solids protect witnesses, doorways, and spawn clearance. The final prop ledger has every prop and scenery cell without overlap. Flood from spawn uses the engine's `body_clear` node and segment step tests, requiring all doorway runs, start poses, and witnesses to join the region. Failure redraws. |

Gate B tests cover stable features and five homes, clusters, site margins and painting, distinct prop cells, doorway and path relationships, footpath crossings, independently re-derived witnesses, and strict connectivity across the full batch.

The owner signs off the dressed village, opening stage close.

## Gate close and seed blessing

During a gate, tuning consists of local code and configuration work plus browser review. On a gate close, regenerate `scripts/gen_three_branches_fixture.py`. Its property assertions avoid pinned text and ticks. Regenerate even after a mid-tuning commit. At the first close, revise step 3 to state that its fixture is generated.

The pinned full-fidelity batch is `0, 1, 2, 3, 5, 7, 11, 17`; 0 is the reset default and 17 the conformance seed. The owner browses it in local watch sessions and blesses one course default seed. Mechanical close work may use a provisional batch seed and re-runs once blessing occurs. The blessed seed is `test_budget`'s seed and the fixture script's `SEED`, and is recorded here. Later season configuration pins that same blessed seed for each season.

At stage close, re-measure `test_budget` at the blessed seed for 1201 JSONL lines, replay identity, and cadence. Revalidate the scripted visitor across the batch for a full unstalled day and per-game reset budget. Rerun the fixture script at the blessed seed, name it in step 3, run the full browser suite, and report every batch seed's generation-and-validation reset time.

## Tests

`environments/three_branches/tests/test_generation.py` is the full-batch guarantee suite. It tests structure, not aesthetics: no bend-radius, corridor, monotonicity, curvature, bend inventory, or variety assertions. Shrine assertions cover placement and witnesses. Configuration bounds are read at test time.

- Verify fixed feature counts, home and canonical prop identities, all waterways and road and bridge guarantees, spawn clearance, and configuration-derived search and mask behavior.
- Verify reserved sites, margins, painting, floor props and open doorways, paths, non-overlapping final ledger, independently found prop witnesses, and spawn connectivity.
- Verify same-seed equality, batch-seed divergence, redraw-cap non-exhaustion, `village` observation equality, and frame-derived conversion, margin, and width arithmetic. Lantern and pine skips do not redraw land, road, or buildings.
- Report reset time for every batch seed. Do not assert a timing threshold.

Per gate close, regenerate the fixture. At final close, re-measure `test_budget` at the blessed seed.

## Build order

1. Gate A: stream, redraw loop, fields, walker, padding assembly, water, grounds, road, crossings, spawn, tests and conformance, review, sign-off, and close procedure.
2. Gate B: sites, painting, footpaths, accessories, witnesses, validation, full-batch suite, review, sign-off, and close procedure.
3. Bless and close: provisional fallback if necessary, fixture regeneration at blessed seed, budget measurement, stage 3 revision, full browser suite, and handoff sweep.

## Done when

Any seed builds a valid, connected village under the village guarantees; both dated owner sign-offs are recorded here; guarantee and conformance suites are green across the full batch; the blessed-seed day replays identically; regenerated fixtures keep renderer and e2e suites green; and the owner has blessed the course default seed.
