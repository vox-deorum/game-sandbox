# Step 4: The village generator

Status: planned.

Part of [the plan](../README.md). This is build-order step 4: the seeded construction of Three Branches under [village.md](../village.md)'s guarantees, replacing the step 2 fixture village behind the unchanged `build_village(seed)` seam. The hands-on surface is any seed's village explored in the browser through a local watch session with the collision overlay on, with the guarantee suite green across a pinned seed batch. The stage closes with the owner blessing one batch seed as the course default.

## Why this is its own seam

village.md is a complete generative specification with hard guarantees and no game rules. The generator is pure geometry over the layout types step 2 fixed, and building it after the renderer means every generation change is inspected visually in the real viewer. The swap is contained by construction: `generation.py` today discards the seed and returns the fixture, so the stage grows that one module and its tests while the engine, environment, overlay, and renderer contracts stay untouched.

## What to build

### The generation stream

`build_village(seed)` draws every choice from one labeled stream, `random.Random(f"{seed}:village")`, the pattern the crane engine set with its `battlefield` and `match-play` streams; the label keeps generation independent of the scripted visitor's plain `random.Random(seed)`. The pipeline consumes the stream in village.md's fixed order: boundary and river, road and bridges, district anchors, buildings and homes, footpaths, ground classes, scenery, props. Generation draws with `random` and `math` over `geometry.py`; `env.py` remains the package's only numpy importer, and determinism keeps stage 2's scope: same-platform builds are exact, and committed recordings are replayed, never re-simulated.

Every placement draws against a fixed candidate budget (a few hundred for a building, a few dozen for a prop). An exhausted budget, an infeasible waterway or road draw, or a failed assembly discards the partial village and redraws whole, continuing on the same stream, the way `generate_battlefield` redraws. `Layout` assembly and the reset validation run inside that loop, so the constructor's own rejections (a deck on the confluence cap, a broken canonical order) trigger a redraw too. The cap is 32 redraws, then a `RuntimeError` naming the seed: a loud bug signal. The shared conformance suite resets at seeds outside any pinned batch, so every seed has to build; the feasibility bounds below keep redraws rare and the batch proves the rates.

`generation.py` stays one module, the crane `battlefield.py` precedent: one private function per pipeline stage, each taking the stream plus the pieces already placed and returning plain layout parts, so milestone tests target stages directly. Homes are numbered `home_0` through `home_4` in placement order, channels sit trunk first then by mouth x (the west, center, and east channels), and props emit in canonical order (village.md's table order by type, placement order within type), the orders the `Layout` constructor and the observation expect.

### Curves and the point cap

One shared primitive draws every meander: a chain of circular arcs with radius at least 10 m, heading clamped inside the feature's corridor, sampled adaptively into polyline points, about 3 m chords in bends and up to 6 m on straights. The overlay packs a polyline's point count as one base36 character, so 35 points per polyline is a hard cap the sampler enforces and the suite pins. Chords this size leave up to a 0.25 m sagitta on a 10 m arc, which is the tolerance the discrete curvature tests allow.

| Feature | Width | Heading corridor | More bounds |
| --- | --- | --- | --- |
| Trunk | 5 to 7 m | within 45 degrees of due south | enters the north edge inside its middle third; ends at the fork |
| Channels | 4 to 6 m each | within 45 degrees of due south | first point is the trunk's last point verbatim; y-monotonic; never intersect one another; adjacent mouths at least 20 m apart on the south edge |
| Road | 4 to 5 m | within 45 degrees of due east | enters the west edge, exits the east edge, x-monotonic, wholly south of the fork; crosses each channel exactly once, never the trunk |
| Footpaths | 1.5 to 2.5 m | none, the bend radius alone | branch from the road; never cross water |
| Bridge decks | 2 to 3 m | along the road at its crossing | span the channel width over the crossing sine plus 1 m of apron each side; crossing within 20 degrees of perpendicular; clear of the confluence cap |

Every bend radius is at least 10 m.

### Structural variety

Two seeds should compose differently, not jitter one recipe, so the wide draws are deliberate and named: the meander amplitude of the trunk, the channels, and the road (bend-rich seeds beside lazy ones), the trunk entry across its third and the fork across its band, the home split between two and three clusters and the banks and sides they take, the plaza in either crook of the fork, the market's spread and side balance, the lantern rhythm, the pine cluster count and spread, and the field and reed extents. The suite pins a variety check once the batch is chosen: both cluster counts, both plaza crooks, and visibly different bend characters all appear across the eight seeds.

### Waterways

The fork point is drawn first, between two fifths and three fifths of the way down the village (y between 40 and 60; village.md's revision to this band lands with this stage file), at an x that fits three mouths at least 20 m apart inside the south edge. The trunk is then drawn from its north-edge entry down to the fork, and the three channels fan from the fork's exact point to the south edge. Sharing the endpoint verbatim matters: the layout derives its solid confluence cap from coincident channel endpoints, and the suite asserts exactly one cap, at the fork. A failed fan redraws.

### The road, bridges, and the spawn

The road is built waypoints first: a west-edge entry y south of the fork, one crossing point per channel taken west to east with the crossing heading within 20 degrees of perpendicular to the channel (always inside the road's corridor, since channels run south and the road runs east), and an east-edge exit. Arc chains are fitted between successive waypoints; a waypoint pair too close to swing between crossing headings at a 10 m radius redraws the road. The road stage also secures the bend inventory the shrines need: two bends, each accumulating at least 35 degrees of heading change within a 25 m arc window, at least 15 m of arc apart and 8 m from every deck. Each crossing gets its deck per the bounds table. The spawn is the road centerline point at x = 1.0, and a clearance disk around it stays free of every footprint.

Footpaths never cross water: home clusters land on banks their footpath can reach dry, so this stage generates no footpath bridges, and the suite still enforces village.md's bound (at most one footpath bridge per channel, none on the trunk) so a later generator change stays legal.

### District anchors, buildings, and homes

The road's arc length splits into west, middle, and east stretches, and the anchor stage fixes every spot the later stages consume: the repair shed and the beacon bell on the west stretch, the market center on the middle stretch with five stall spots on both sides of the road and the board's spot among them, the inn on the east stretch, the two shrine spots on the road's two qualifying bends (anchored here even though village.md's district list does not name them), each home cluster's center and its footpath junction on the road, and the well plaza in either crook of the fork, drawn from the stream, slid south along its crook until the wedge between the adjacent channels opens at least 8 m and the clearing sits clear of the confluence cap.

Buildings land inn and shed first, then the five homes around their cluster centers in two or three loose clusters on the channel banks. A candidate placement draws position and rotation near its anchor and is accepted only when its rectangle clears other buildings, water plus a bank margin, the road shape, and the boundary, and when its doorway faces its path (the road for the inn and shed, the cluster's junction for homes) with a body-clear threshold outside; once footpaths exist, the suite checks each doorway faces the path nearest its building. Home interiors stay empty, so the stage 2 start-pose formula seats housemates unchanged.

### Footpaths and grounds

Footpaths run from each anchored junction to the well plaza, each home cluster, and each shrine spot under the shared curve primitive. Field terraces are quad strips sampled along the lower channel banks between the home clusters and the south edge, offset well inside the 10 m bend radius. Reed flats are polygons on the outer curve of channel bends and one at each mouth, each holding two disjoint body-clear standing points, the bar the fixture set. Terrace and reed outlines take a deterministic edge wobble from the stream, its amplitude bounded near 1 m and kept inside the offset margins, so passable ground reads as grown rather than drafted while every polygon stays simple and the even-odd classifier stays honest; water banks and the road keep their clean arc geometry, since collision and decks depend on it. The wobble fragments the ground grid's run-length rows, which the header payload bound already guards. Ground polygons may overlap freely: the stage 2 classifier resolves priority (decks, water, road and footpaths, fields, reeds, open), so grounds need no disjointness of their own.

Cosmetic terrain variety, several tile looks per ground code, is renderer work: the shared tiled base's deterministic variant hook carries it and step 5.1 supplies the textures, so the generator emits no cosmetic terrain data.

### Scenery, props, and witnesses

Pines land in clusters of two to five on open land, the cluster count and spread drawn wide, each pine keeping at least a body diameter clear of every solid outside its own cluster and 2 m clear of every path edge, doorway threshold, anchored spot, and the spawn disk. One or two crates land beside each stall spot and four roof posts at each shrine spot's corners. The props stage then instantiates the catalog: anchored spots serve the stalls, board, shrines, hearth, repair bench, pump, and bell, and the rest are searched, lanterns just off the road edge weighted denser near the market, benches split across the plaza, the market, and the inn front with every site served, and a garden plot flush against a non-doorway wall of each home. `props.json`'s `count`, `footprint`, and `district` fields drive the routines. Exterior footprints stay pairwise disjoint and clear of building rectangles; interior props stay inside their walls and leave the doorway open.

Every prop is accepted only with a banked witness: a standing point within the 1.5 m position-to-position reach where the 0.4 m body is clear and the line to the prop is unblocked. Every later solid is checked against the banked witnesses, doorway thresholds, and the spawn disk, so nothing placed afterward can break them.

### Validation at reset

After assembly the generator builds the engine's own static pymunk space once and flood fills from the spawn on a 0.5 m grid, asserting every doorway threshold, start pose, and prop witness lands in the spawn's region; a failure redraws. The space's point queries measure under a microsecond, so the sweep costs a few hundredths of a second, connectivity becomes a checked fact at every reset, and reset, generation and validation included, stays under the 250 millisecond cadence, asserted across the batch. The full-resolution truth, the strict sweep where every body-clear sample joins one region, runs in the suite at 0.25 m across the batch.

### The swap and the audit

`generation.py`'s stub body becomes the pipeline. `Day` already calls `build_village(seed)`, so `reset(seed)` changes behavior with no interface change, and the layout types, observation schema, overlay codec, and renderer stay untouched. The fixture village stays available to the tests that want a known map, through `Day(config, layout=FIXTURE_VILLAGE)`. The audit lands before the swap, while the seam still returns the fixture:

- Engine-level tests that depend on fixture coordinates pass the fixture layout explicitly.
- `test_layout_fixture` retires its pin that the seam ignores the seed and keeps the fixture invariants; its flood fill lifts into a shared helper both suites use, rebuilt on the pymunk space.
- Seeded pins through the real environment are re-derived against generated villages when the swap lands: `test_overlay`'s seed 7 coordinate and ground pins, `test_budget`'s seed constant (the blessed seed), `test_chat`'s hardcoded positions, now derived from the generated layout with the wall-blocked pair picked from its buildings, and `test_builtins`' pins, the seed 1 route-graph node, the seed 22 opening canned line, and the NaN-regression seed and tick pairs, re-reproduced so the regression stays covered.
- The scripted visitor is re-validated across the batch: its route graph builds from the denser generated centerlines, the visitor wanders a full day unstuck, and its `reset` cost stays inside the per-game budget.

### Frontend fixtures and the blessed seed

With generation live, the harness day behind `scripts/gen_three_branches_fixture.py` plays a generated village, so the pinned frontend artifacts regenerate, and the change set revises step 3's stage file to say so, per the plan rules:

- The owner browses the batch seeds in local watch sessions with the collision overlay on and blesses one as the course default. The blessed seed becomes `test_budget`'s seed and the fixture script's `SEED`, and is recorded in this file; season pinning stays later work. If the blessing waits, the mechanical items proceed on a provisional batch seed and re-run once blessed.
- The fixture script re-runs at the blessed seed: a new `three-branches-recording.jsonl` and decoded sidecar, with the renderer agreement and scene suites re-run against them.
- The step 3 e2e chat seed and its expected-line constants are re-picked so the first canned line still lands within the opening ticks.

## Tests

`environments/three_branches/tests/test_generation.py`, the guarantee property suite across a pinned batch of eight seeds, 0 (the reset default) and 17 (the conformance rollout seed) among them, every seed at full fidelity:

- The stable features placed once each, five homes, 31 props in canonical order, and trunk-first channel order, which needs its own assertion (the `Layout` constructor already enforces the roster, the prop sequence, and the channel count).
- The bounds table re-verified discretely: the entry third, the fork band, every width, corridor headings, bend radius at least 10 m within the chord tolerance, mouth separation, the road's east exit and x-monotonic progress south of the fork, and every polyline at 35 points or fewer.
- Exactly one road bridge per channel within 20 degrees of perpendicular, spans per the deck formula, at most one footpath bridge per channel, none on the trunk, and decks clear of the single confluence cap at the fork.
- Two shrine-grade road bends, holding the shrine spots.
- The overlap matrix: buildings against buildings, water, road, boundary, and exterior objects; exterior footprints pairwise disjoint; interior props inside walls leaving doorways open; every doorway facing the path nearest its building and opening onto body-clear ground, never water, a footprint, or the boundary.
- Strict connectivity at 0.25 m over the pymunk space: every body-clear sample in one region holding the spawn, every doorway threshold, start pose, and witness, with a sampled cross-check that the space and `body_clear` agree.
- A witness for every prop use, re-derived independently of the generator's own search.
- The spawn on the road centerline at x = 1.0, clear of every footprint.
- Each reed flat holding two disjoint body-clear standing points.
- Every field and reed polygon simple, no self-intersection, under the edge wobble.
- The batch variety pin, set when the seeds are chosen: both cluster counts, both plaza crooks, and distinct bend characters all appear across the batch.
- Same-seed determinism, two builds comparing equal, and divergence, two batch seeds differing.
- The canonical static overlay payload below 12 KiB for every batch seed (the run-length ground grid is the dominant term; the full header line cap stays in `test_budget`).
- The observation's `village` Dict equal to the generated layout field for field through float32, via `make_env` reset at a batch seed.
- Reset time, generation and validation included, under the 250 millisecond cadence for every batch seed, with the measured numbers recorded here once landed.

Changed suites: the audit list above, plus `test_budget`'s unchanged caps (1,201 frames, the cast_10 recording below 2 MiB, the header line below 16 KiB, replay identity, the cadence bound) re-measured at the blessed seed as soon as the swap lands, since the fixture recording sits about 114 KB under its cap today. Frontend: the regenerated recording and sidecar keep the renderer agreement and scene suites green; the `three-branches` e2e group re-runs on the new pinned seeds while iterating, and the bare full browser suite runs before handoff.

## Build order

Eight milestones, each ending green:

1. Scaffold and curves: the labeled stream, the redraw loop and candidate budgets, the arc-chain primitive with adaptive sampling under the 35-point cap, bound tests over a spread of draws.
2. Waterways: the fork draw, the trunk, the channels, the shared-endpoint cap, with band, width, separation, curvature, and intersection tests.
3. Road, bridges, spawn: waypoints then arcs, square-on decks, the east exit, the bend inventory, the spawn disk.
4. Anchors and buildings: the stretches, the plaza wedge, shrine spots, stall and board spots, cluster junctions, inn and shed, home clusters with doorways.
5. Footpaths and grounds: junction-to-target routing, terraces and reed flats with the edge wobble.
6. Scenery, props, witnesses, validation: clearance-ruled scenery, the placement routines, banked witnesses, the reset flood fill, canonical assembly, the full guarantee suite and the variety pin green across the batch through direct generator calls, and the engine-level side of the audit (the seam still returns the fixture).
7. The swap: `build_village` flips, the environment-level pins re-derived, the builtins re-validated, `test_budget` and the conformance suite green, reset timing recorded.
8. Bless and regenerate: the owner's seed blessing (provisional seed fallback), the fixture script and sidecar regeneration, the e2e chat seed re-pick, step 3's stage file revision, the `three-branches` e2e group, the bare full browser suite, and the done-when sweep.

## Done when

Any seed builds a valid, connected, fully guaranteed village that renders in the browser under the collision overlay, the guarantee suite and the conformance suite are green with the batch at full fidelity, full days at the blessed seed record inside the stage 2 budget and replay identically, the regenerated frontend fixtures hold the renderer and e2e suites green, village.md carries the revised fork band, and the owner has blessed the course default seed.

---

## Verification

Documentation-only change, so verification is textual:

- The stage file renders correctly as markdown and its relative links (`../README.md`, `../village.md`) resolve.
- No em-dashes and no layered "instead of X, Y" framing anywhere in either edited file (repo writing rules).
- village.md still reads consistently after the one-line band change (its guarantees section and the stage file now agree on the band).
- The stage file keeps every promise of the stub it replaces: guarantee suite over a pinned batch, per-prop witness, byte-for-byte same-seed determinism, meander and count bounds, flood-fill connectivity, `village` Dict equality, and the recording budget re-measure.
- Nothing under `docs/specs/` references the old fork wording (the band lives only in plans/days-at-three-branches).
