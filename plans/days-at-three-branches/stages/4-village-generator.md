# Step 4: The village generator

Status: in progress. Milestone 0 and layers 1 and 2 are landed and signed off. The modular generator and accessory layer are under implementation.

Part of [the plan](../README.md). This is build-order step 4: the seeded construction of Three Branches under [village.md](../village.md)'s guarantees, replacing the step 2 fixture village behind the unchanged `build_village(seed)` seam. The village is grown in four layers, terrain, then sites, then the road network, then accessories. Each layer is tuned through rounds of owner review in the real browser viewer until the owner signs it off, and the stage closes with the guarantee suite green across a pinned seed batch and the owner blessing one batch seed as the course default.

## Two kinds of correctness

village.md is a complete generative specification with hard guarantees and no game rules, and the generator is pure geometry over the layout types step 2 fixed, so the engine, environment, overlay, and renderer contracts stay untouched throughout.

The guarantees are mechanical and the test suite owns them. Whether the place looks grown rather than drafted is a judgment no test can make, so the look is owned by review: the owner watches seeds through `npm run play -- three_branches watch --seed N` with the collision overlay on, asks for changes, and the layer's tuning knobs turn until the look is right. Each layer's sign-off is recorded in this file with a date. No new review tooling is built.

Because review needs the browser, `build_village(seed)` flips to the generator at the first layer, with the not-yet-generated layers padded from the fixture so a full `Layout` always builds (the constructor demands the complete building and prop rosters). A padded combination may violate guarantees, a fixture home standing in generated water is a padding artifact, and review judges only the layers that exist. The test audit that makes the early flip safe is milestone 0.

## The generation stream and the redraw loop

Every choice draws from one labeled stream, `random.Random(f"{seed}:village")`, the pattern the crane engine set with its `battlefield` and `match-play` streams; the label keeps generation independent of the scripted visitor's plain `random.Random(seed)`. The pipeline consumes the stream in village.md's order: terrain and grounds, district anchors and buildings, the road network with its bridges and footpaths, scenery and props.

Mandatory placement draws against fixed candidate budgets from `generation.json`. Exhausted mandatory local budgets discard the partial village and redraw whole on the same stream, the way `generate_battlefield` redraws. Lantern and pine candidates are optional and skip invalid placements. Assembly and reset validation run inside the loop. A connectivity failure retries the same mandatory layout without pines, then without lanterns. Only failure of the mandatory layout redraws the village. Draw order within a layer is fixed per code version, and a local retry redraws only its own choices, preserving same-seed determinism. The cap is configured at 64 redraws, then a `RuntimeError` names the seed as a loud bug signal. The conformance suite resets this environment at seed 17 and on the unseeded path (seed 0) every run, so those seeds must build from the first flip, and the batch records the redraw rates.

The `generation/` package holds one module for each stage: terrain, sites, network, accessories, shared walker logic, and validation. `generation.json` holds their immutable maintainer tuning, validated once when the package imports. Its top-level groups follow the package stages, and accessories use nested groups such as `accessories.pine`, `accessories.lantern`, and `accessories.stall`. Generation draws with `random` and `math` over `geometry.py`; `env.py` remains the package's only numpy importer. Homes are numbered `home_0` through `home_4` in placement order, channels sit trunk first then by mouth x (the west, center, and east channels), and props emit in canonical order (village.md's table order by type, placement order within type), with contiguous ids. Determinism keeps stage 2's scope: same-platform builds are exact, and committed recordings are replayed, never re-simulated.

## The terrain fields and the walker

Two seeded scalar fields, elevation and moisture, are drawn before anything else, so every later layer scores against the same land. Each field is fractal value noise in pure python: a lattice of uniform draws from the stream at 25 m spacing covering the frame plus one ring of nodes, summed over three octaves at 25, 12.5, and 6.25 m spacing with amplitudes 1, 0.5, and 0.25, sampled with smoothstep-faded bilinear interpolation and normalized to the unit interval. The elevation field carries a southward slope bias, so water has somewhere to go. A field is a plain function of a point built from tuples and `math`; a sample costs microseconds and the whole lattice a few hundred draws. The fields are generation-only artifacts: the emitted `Layout` stays polylines with widths, polygons, and rectangles, so nothing downstream of the generation package changes.

One walker traces every watercourse and path. It steps a few meters at a time, its direction a blend of its own momentum, the sideways push of the elevation field's downhill gradient, and a pull toward its target, so the land bends a course while the pull carries it home, and two seeds meander differently because their land differs. Every course leaves its source on a drawn heading, so entries vary as much as the bends. The blend weights, the drawn headings, and the field roughness are drawn per seed inside tuned ranges, so lazy and bend-rich seeds both occur, and those ranges are the knobs the review rounds turn. Each course width is drawn before walking, so the walker aborts when it presses into sibling clearance beyond a 15 m fork arc. Inward repulsion within 6 m of the frame, fading near edge targets, bows courses away from the edge. A finished trace is resampled to at most 35 points, the hard cap the overlay codec enforces by packing a polyline's point count as one base36 character, with every coordinate inside the 100 m frame, which the observation spaces and the codec both require. A trace that self-intersects, collides with a sibling, or leaves the frame retries its own local choices; only an exhausted local budget discards the partial village.

| Feature      | Width                                                       |
| ------------ | ----------------------------------------------------------- |
| Trunk        | 5 to 7 m                                                    |
| Channels     | 2.5 to 4 m each                                             |
| Road         | 4 to 5 m                                                    |
| Footpaths    | 1.5 to 2.5 m                                                |
| Bridge decks | 2 to 3 m, spanning bank to bank plus 1 m of apron each side |

## The four layers

### Layer 1: terrain

The fields are drawn, then the water topology, which is where the guarantees live: a north-edge entry inside the middle third, a fork target in the y 40 to 60 band at an x that fits three mouths at least 20 m apart and at least 10 m off the side edges (the edge margin also protects the road's west entry and the padded fixture spawn), and the mouth targets on the south edge. The walker traces the trunk from the entry to the fork, and the three channels from the fork's exact point to their mouths; coincident channel endpoints are what the layout turns into the solid confluence cap, and the suite asserts exactly one cap, at the fork. Reed flats land where moisture runs high along banks and at every mouth, and field terraces land on the flat low stretches of the lower banks; both take their outlines from the fields, bounded so every polygon stays simple and the even-odd ground classifier stays honest.

Padding: the fixture road, footpaths, buildings, props, scenery, and spawn, with `bridges=()`. The layout splits every water bank around every deck, so a fixture deck overlapping new water would punch a phantom gap in a generated bank; an empty bridge tuple builds fine, and the fixture road fording the new channels in the viewer is an accepted padding artifact. The overlay codec accepts an empty bridge list on both ends; one road bridge per channel returns as layer 3's tested bound.

Tests landing: the entry third, the fork band, the widths, mouth separation and the edge margin, channels never intersecting themselves or one another, terrace and reed polygons simple, the 35-point cap, generator-level same-seed determinism and cross-seed divergence, the static overlay payload under 12 KiB, and the observation `village` Dict equal to the built layout through float32.

Gate: the owner signs off the water and ground look. Signed off 2026-08-10.

### Layer 2: sites

Anchors are scored on the terrain. The well plaza sits in a crook of the fork, slid along its crook until the wedge between the adjacent channels opens at least 8 m and the clearing sits clear of the confluence cap. A notional west-to-east corridor south of the fork carries the rest: the repair shed and the beacon bell on its west stretch, the market center in its middle with five stall spots on both sides and the board's spot among them, and the inn on its east stretch. Home clusters, two or three, seed from the best-scoring bank regions, scored on bank proximity, flatness, dryness, and separation from one another.

Buildings land inn and shed first, then the five homes around their cluster centers. A candidate placement draws position and rotation near its anchor from a fixed budget and is accepted only when its rectangle clears other buildings, water plus a bank margin, and the boundary. Doorways aim provisionally at the cluster junction or the corridor; the final rule lands with the road network. Home interiors stay empty, so the stage 2 start-pose formula seats housemates unchanged.

Padding: the fixture road, footpaths, props, scenery, and spawn; bridges stay empty.

Tests landing: the roster order, five homes in two or three clusters, the building clearances, every doorway on its perimeter opening onto dry ground.

Gate: the owner signs off the settlement pattern. Signed off 2026-08-10.

### Layer 3: the road network

The road is threaded waypoints first: a west-edge entry south of the fork, one crossing point per channel taken west to east, and an east-edge exit, with each leg traced by the walker pulling toward the next waypoint, so the road follows the land the way the water does. Each crossing gets one deck per the width table, clear of the confluence cap. Footpaths run from road junctions to the well plaza, every home cluster, and the shrine spots, under the same walker; a cluster across water from the road gets a footpath bridge, within village.md's bound of at most one per channel and none on the trunk. The spawn is the road centerline point at x = 1.0, and a clearance disk around it stays free of every footprint. Doorways re-aim at the nearest path, the final rule the suite checks from here on.

Padding: the fixture props and scenery only.

Tests landing: the west entry and east exit, exactly one crossing per channel and never the trunk, one road deck per channel really spanning its water, at most one footpath bridge per channel and none on the trunk, footpaths never touching water off a deck, decks clear of the single confluence cap, and the spawn on the centerline clear of every footprint.

Gate: the owner signs off the network.

### Layer 4: accessories

One road-arc helper supplies cumulative lengths, nearest projections, positions, tangents, and normals to the road-facing accessories. Anchored spots serve the stalls, board, shrines, hearth, repair bench, pump, and bell; benches split across the plaza, the market, and the inn front with every site served; each 4 by 3 m garden plot has its 4 m edge centered on, parallel to, and flush with the home wall opposite the doorway, extending outward with no wall choice or slide; the hearth and repair bench stand inside their buildings against the wall opposite the doorway. One or two crates land beside each stall spot and four roof posts at each shrine spot's corners; shrine spots sit on road bends the generator picks itself.

Lantern stations run between the road end margins. They use closer spacing in the market window, alternate preferred road sides from a seeded initial side, try the other side once, and skip a blocked station. Their variable count follows road length and clearance rather than a quota. Pines are placed last: road stations and selected scatter cells each offer one anchor, then an accepted anchor may offer nearby companions. Invalid anchors and companions skip without retrying the layout. The catalog's fixed counts, footprints, and districts guide the constrained props; the generator configuration controls candidate spacing, scatter probability, companions, and other layout tuning.

Every prop is accepted only with a banked witness: a standing point within the 1.5 m reach of the prop's nearest rotated-footprint point where the 0.4 m body is clear and the line to that point is unblocked. Every later solid is checked against the banked witnesses, doorway thresholds, and the spawn disk, so nothing placed afterward can break them. After assembly the generator builds the engine's own static pymunk space once and flood fills from the spawn on a 0.5 m grid, asserting every doorway threshold, start pose, and prop witness lands in the spawn's region; a failure redraws.

Padding: none. The fixture import leaves the generation package; `fixture.py` itself stays as the engine tests' known map.

Tests landing: the stable features placed once each, the overlap matrix, a witness for every prop re-derived independently of the generator's own search, and strict connectivity at 0.25 m over the pymunk space, all across the batch at full fidelity.

Gate: the owner signs off the dressed village, which opens the stage close.

## Milestone 0: the audit

The audit lands before any seam change, everything green with the seam still returning the fixture:

- `test_physics`, `test_engine_props`, `test_engine_perception`, and `test_overlay`'s engine-level constructions pass `layout=FIXTURE_VILLAGE` explicitly (`Day` already takes it), so their fixture coordinates stay valid forever.
- `test_layout_fixture` retires its pin that the seam ignores the seed and keeps every fixture invariant as documentation of the engine tests' known map; its flood fill lifts into a shared helper both suites use.
- `test_chat` derives its placements from `env.day.layout` at runtime: a deterministic search finds an in-range open trio, and the wall-blocked pair builds from one of the layout's own homes. A failed search is a generator quality signal, not a test bug.
- `test_builtins` derives the seed 1 route-graph junction from the observed village; the NaN-regression sweep keeps its seed and tick pairs as pure finiteness checks; the seed 22 opening-line pin moves to the per-close regeneration list.
- `test_environment`'s bell-use standing point comes from a `body_clear` search near the bell.
- `test_budget`'s caps are inequalities and stay untouched until the close re-measure.

## What a layer's close regenerates

Tuning rounds inside a layer are local: code changes plus browser looks, nothing committed, no pins touched. A layer's close is a commit point, and because the seam's output changed, the close re-runs `scripts/gen_three_branches_fixture.py` with its `SEED` and `GREETING_TICK` re-picked by a scripted scan so the script's content assertions hold, refreshes the recording and decoded sidecar, re-picks the e2e chat constants and `test_builtins`' seed and opening-line pin, and runs the `three-branches` e2e group. If a review pause forces a mid-tuning commit, the close regeneration runs anyway. Step 3's fixture section is revised at the first close to say the recording plays a generated village, per the plan rules.

## The blessed seed and the stage close

The suite pins a batch of eight seeds, 0 (the reset default) and 17 (the conformance rollout seed) among them, every seed at full fidelity; the pinned batch is 0, 1, 2, 3, 5, 7, 11, and 17. The owner browses the batch in local watch sessions and blesses one seed as the course default; if the blessing waits, the mechanical items proceed on a provisional batch seed and re-run once blessed. The blessed seed becomes `test_budget`'s seed and the fixture script's `SEED`, and is recorded in this file; season pinning stays later work.

At the close:

- `test_budget`'s unchanged caps (1,201 frames, the cast_10 recording below 2 MiB, the header line below 16 KiB, replay identity, the cadence bound) re-measure at the blessed seed.
- The scripted visitor re-validates across the batch: its route graph builds from the generated centerlines, the visitor wanders a full day unstuck, and its reset cost stays inside the per-game budget.
- The fixture script re-runs at the blessed seed, the e2e chat seed and expected-line constants re-pick, step 3's stage file names the blessed seed, and the bare full browser suite runs before handoff.
- Reset times, generation and validation included, are recorded here for every batch seed.

## Tests

`environments/three_branches/tests/test_generation.py`, the structural suite across the pinned batch. The suite tests structure, not aesthetics: it holds no bend radius, heading corridor, monotonicity, curvature, bend inventory, or variety assertions, because shape is the review rounds' jurisdiction. Shrine spots assert placement and witnesses only.

The consolidated list, accreting per layer as the build order lands it:

- The stable features placed once each, five homes, and props in canonical order with contiguous ids. The `Layout` constructor enforces fixed catalog counts, accepts a variable lantern count, and preserves the channel order. The entry and mouth assertions pin the trunk-first channel order.
- The entry third, the fork band, every width, mouth separation, and the 10 m edge margin.
- Water polylines simple, channels never intersecting one another, and exactly one confluence cap, at the fork.
- The road's west entry and east exit, exactly one crossing per channel and never the trunk, one deck per crossing really spanning its water, at most one footpath bridge per channel and none on the trunk, decks clear of the cap, and footpaths never touching water off a deck.
- The overlap matrix: buildings against buildings, water, road, boundary, and exterior objects; exterior footprints pairwise disjoint; interior props inside their walls leaving doorways open; every doorway facing the path nearest its building and opening onto body-clear ground, never water, a footprint, or the boundary.
- Strict connectivity at 0.25 m over the pymunk space: every body-clear sample in one region holding the spawn, every doorway threshold, start pose, and witness.
- A witness for every prop use, re-derived independently of the generator's own search.
- The spawn on the road centerline at x = 1.0, clear of every footprint.
- Every field and reed polygon simple, no self-intersection.
- Same-seed determinism, two builds comparing equal, and divergence, two batch seeds differing.
- Every polyline at 35 points or fewer, and the canonical static overlay payload below 12 KiB for every batch seed (the run-length ground grid is the dominant term; the full header line cap stays in `test_budget`). Lantern and pine skips do not redraw terrain, sites, or network geometry.
- The observation's `village` Dict equal to the generated layout field for field through float32, via `make_env` reset at a batch seed.

From the first flip, the conformance suite demands of every build: the redraw cap never trips at seeds 0 and 17, all geometry stays inside the frame, every polyline fits the codec, and same-seed builds compare equal.

Changed suites: the milestone 0 audit list, the per-close regenerations (the fixture recording and sidecar, the e2e chat constants, the `three-branches` e2e group), and `test_budget` re-measured at the blessed seed at the stage close.

## Build order

Six milestones, each ending green:

0. The audit: milestone 0's list, the seam untouched, the full suite green.
1. Terrain: the stream, the redraw loop, the fields, the walker, the padding assembly, waterways, reeds, and terraces; the seam flips; the layer's tests and the conformance suite green; review rounds to the terrain sign-off; the close regeneration.
2. Sites: scoring, anchors, and buildings; the layer's tests; the settlement sign-off; the close regeneration.
3. The road network: the road, decks, footpaths, the spawn, and the final doorway rule; the layer's tests; the network sign-off; the close regeneration.
4. Accessories: scenery, props, witnesses, and the reset validation; the full suite across the batch; the dressed village sign-off.
5. Bless and close: the blessing (provisional seed fallback), the fixture and e2e regeneration at the blessed seed, the `test_budget` re-measure, step 3's revision, the bare full browser suite, and the done-when sweep.

## Done when

Any seed builds a valid, connected, fully guaranteed village that renders in the browser under the collision overlay, all four layer sign-offs are recorded in this file, the guarantee suite and the conformance suite are green with the batch at full fidelity, full days at the blessed seed record inside the stage 2 budget and replay identically, the regenerated frontend fixtures hold the renderer and e2e suites green, and the owner has blessed the course default seed.

---

## Verification

Documentation-only change, so verification is textual:

- The stage file renders correctly as markdown and its relative links (`../README.md`, `../village.md`) resolve.
- No em-dashes and no revision-history framing anywhere in the edited files (repo writing rules).
- village.md reads consistently after its edits and agrees with this file on the generation order and the fork band.
- The stage keeps the seam's standing promises: the guarantee suite over a pinned batch, a per-prop witness, same-seed determinism, flood-fill connectivity, `village` Dict equality, and the recording budget re-measure.
- Nothing under `docs/specs/` references the removed curvature bounds.
