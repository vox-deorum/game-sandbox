# Step 4: The village generator

Status: planned.

Part of [the plan](../README.md). This is build-order step 4: the seeded construction of Three Branches under [village.md](../village.md)'s guarantees, replacing the step 2 fixture village behind the unchanged `build_village(seed)` seam. The village is grown in two reviewed halves, the land and its routes first, then the settlement and its dressing. Each half is tuned through rounds of owner review in the real browser viewer until the owner signs it off, and the stage closes with the guarantee suite green across a pinned seed batch and the owner blessing one batch seed as the course default.

## Two kinds of correctness

village.md is a complete generative specification with hard guarantees and no game rules, and the generator paints cells and places rects over the grid types step 2 fixed, so the engine, environment, overlay, and renderer contracts stay untouched throughout.

The guarantees are mechanical and the test suite owns them. Whether the place looks grown rather than drafted is a judgment no test can make, so the look is owned by review: the owner watches seeds through `npm run play -- three_branches watch --seed N` with the collision overlay on, asks for changes, and the tuning knobs turn until the look is right. Each sign-off is recorded in this file with a date. No new review tooling is built.

Because review needs the browser, `build_village(seed)` flips to the generator at the first gate, with the not-yet-generated objects padded from the fixture so a full `Layout` always builds (the constructor demands the complete building and prop rosters). A padded combination may violate guarantees, a fixture home standing in generated water is a padding artifact, and review judges only what the generator has produced so far.

## The generation stream and the redraw loop

Every choice draws from one labelled stream, `random.Random(f"{seed}:village")`, the pattern the crane engine set with its `battlefield` and `match-play` streams; the label keeps generation independent of the scripted visitor's plain `random.Random(seed)`. The authoritative pipeline is road-first after terrain: terrain fields, water, ground classes, road with crossings and spawn, sites with building templates, floor-ground overrides and structural props, footpaths, then accessories. Each later step sees the committed result of the preceding steps.

Mandatory placement draws against fixed candidate budgets from `generation.json`. An exhausted mandatory budget discards the partial village and redraws whole on the same stream, the way `generate_battlefield` redraws. Lantern and pine candidates are optional and skip invalid placements. Assembly and reset validation run inside the loop. A connectivity failure retries the same mandatory layout without pines, then without lanterns. Only failure of the mandatory layout redraws the village. Draw order within a stage is fixed per code version, and a local retry redraws only its own choices, preserving same-seed determinism. The cap is configured at 64 redraws, then a `RuntimeError` names the seed as a loud bug signal. The conformance suite resets this environment at seed 17 and on the unseeded path (seed 0) every run, so those seeds must build from the first flip, and the batch records the redraw rates.

The `generation/` package holds one module per stage: `fields`, `water`, `grounds`, `network`, `sites`, `accessories`, and `validate`, over two shared helpers, `carve` for brush painting and `paths` for weighted cell search. `generation.json` holds their immutable maintainer tuning, validated once when the package imports; its top-level groups follow the modules, and accessories use nested groups such as `accessories.pine`, `accessories.lantern`, and `accessories.stall`, keyed by catalog placement tokens. A new type is data-only only when it reuses an existing placement token, art treatment, and transition mechanism. Generation draws with `random` and `math` over `grid.py` and `geometry.py`; `env.py` remains the package's only numpy importer. Homes are numbered `home_0` through `home_4` in placement order, and props emit in canonical order (the catalog's type order, placement order within type) with contiguous ids. Determinism keeps stage 2's scope: same-build builds are exact, and committed recordings are replayed, never re-simulated.

`generate(seed)` returns the village and a generation report together, and `build_village(seed)` is the report-free seam the engine calls. The report carries the course masks for the trunk and each named channel, the witness cell backing each interactive prop, and the redraw count. It is generator-internal: the guarantee suite and the batch summary read it, and the engine, the observation, and the recording never see it.

## The terrain fields

Two seeded scalar fields, elevation and moisture, are drawn before anything else, so every later stage scores against the same land. Each field is fractal value noise in pure python: a lattice of uniform draws from the stream at 25-cell spacing covering the frame plus one ring of nodes, summed over three octaves at 25, 12.5, and 6.25 cell spacing with amplitudes 1, 0.5, and 0.25, sampled with smoothstep-faded bilinear interpolation and normalised to the unit interval. The elevation field carries a southward slope bias, so water has somewhere to go. Both are sampled once per cell into flat arrays, a few tens of thousands of cheap samples, and stay generation-only artifacts: the emitted `Layout` carries ground codes and objects, so nothing downstream of the generation package changes.

## Gate A: the land and its routes

**Water.** A walker paints cells. From the north entry cell inside the middle third, each step advances a few cells in a direction blended from its own momentum, the downhill gradient of the elevation field, and a pull toward the fork cell, and paints a round brush of the course's drawn width. The three channels begin in one small, explicit fork and confluence mask, then walk separately to south-edge mouth cells at least 20 cells apart. Outside that mask, a course rejects or reroutes a step that contacts itself or a sibling after applying clearance for both painted widths. This keeps the branches visually distinct and makes each road crossing belong to one channel. Inward repulsion within 6 cells of the frame, fading near edge targets, bows courses away from the edge. The blend weights, the drawn headings, and the field roughness are drawn per seed inside tuned ranges, so lazy and bend-rich seeds both occur, and those ranges are the knobs the review rounds turn.

**Ground classes.** Reed cells gather where moisture runs high within a few cells of water and always at every mouth; field cells take the flat, low, dry stretches of the lower banks. Both pass through one majority smoothing so the blobs read as terrain rather than as noise speckle.

**The road and its crossings.** The road is a weighted terrain search over the cells from a west-edge cell south of the fork to an east-edge cell. Dry flat land is cheap, field and reed are dearer, and water is dear but finite. A small turn cost avoids jittery corners, and a crossing-angle cost favours an approach roughly square to the local channel direction. The route widens from its centreline with width-aware masks. Its water intersections use width-aware bridge masks and one-cell bank aprons, producing continuous decks rather than jagged bridge blobs. The spawn is the road cell one metre in from the west edge with a clearance disk around it kept free.

**Padding:** the fixture buildings, props, and scenery, with footpaths absent.

**Tests landing:** the entry third, the fork band, every course width, mouth separation and the edge margin, water reaching the south edge in exactly three runs, contact limited to the explicit fork and confluence mask, and width-aware clearance after it; the road spanning west to east with exactly one crossing per channel and none on the trunk, every road cell over water carrying bridge ground, continuous widened-road and bridge masks, the configured turn and crossing-angle costs, reed and field cells smoothed and inside the frame, generator-level same-seed determinism and cross-seed divergence, the static overlay payload under 12 KiB, and the observation `village` Dict equal to the built layout.

**Gate:** the owner signs off the land, the water, and the road.

## Gate B: the settlement and its dressing

**Sites and buildings.** Sites are scored on the committed terrain and road. The well plaza sits in a crook of the fork, slid along its crook until the wedge between the adjacent channels opens wide enough and the clearing sits clear of the water. The committed road carries the rest: the repair shed and the beacon bell on its west stretch, the market centre in its middle with five stall spots on both sides and the board's spot among them, and the inn on its east stretch. Home clusters, two or three, seed from the best-scoring bank regions, scored on bank proximity, flatness, dryness, and separation from one another. Buildings land inn and shed first, then the five homes around their cluster centres. A candidate reserves its site during generation and is accepted only when its rect and a margin of clear cells around it hold no water, road, another reserved site, another object, or the boundary. Its semantic placement selects the 2-cell doorway on a side with a viable route to the road. Candidate validation previews the shared layout expansion, including the floor override, perimeter wall props, and passable doorway props. At assembly, `Layout` performs that expansion once. The building record groups the result but does not itself occupy collision cells. Interior interactive props may use the remaining floor cells, while home floors stay empty, so the stage 2 start-pose formula seats housemates unchanged. The final object-cell ledger rejects every overlap.

**Footpaths.** The same weighted terrain search runs from road cells to the well plaza, each selected building doorway, and every shrine spot, at 2 to 3 cells wide, with existing road and path cells discounted so routes merge rather than run parallel. A cluster across water from the road gets a crossing, within village.md's bound of at most one footpath crossing per channel and none on the trunk. Each selected doorway opens onto a walkable path cell and therefore faces its nearest path.

**Accessories.** One road-arc helper supplies cumulative lengths, nearest projections, positions, and facings along the road's cells to the road-facing accessories. Anchored spots serve the stalls, board, shrines, hearth, repair bench, pump, and bell; benches split across the plaza, the market, and the inn front with every site served; each garden plot has its long edge centred on and flush with the home wall opposite the doorway, extending outward with no wall choice or slide and the lower-index position taken when the centring is ambiguous; the hearth and repair bench stand on floor cells against the wall opposite their doorway. One or two crates land beside each stall spot, and shrine spots sit on road bends the generator picks itself.

Lantern stations run between the road end margins. They use closer spacing in the market window, alternate preferred road sides from a seeded initial side, try the other side once, and skip a blocked station. Their variable count follows road length and clearance rather than a quota. Pines are placed last: road stations and selected scatter cells each offer one anchor, then an accepted anchor may offer nearby companions. Invalid anchors and companions skip without retrying the layout. The catalog's counts, footprints, districts, and placement tokens drive every one of these, and `generation.json` controls candidate spacing, scatter probability, companions, and other tuning.

**Witnesses and validation.** Every interactive prop is accepted only with a banked witness: a cell within the 1.5 m reach of the nearest point of the prop's collision shape whose centre holds the 0.4 m body clear of every solid, with an unblocked line to that point. Every later solid is checked against the banked witnesses, structural doorway props, and the spawn disk, so nothing placed afterward can break them. The final object-cell ledger contains structural and interactive props and scenery, and has no overlapping cells.

After assembly the generator flood fills from the spawn cell, taking a cell as a node when the body stands clear at its centre and a step between neighbours when the segment between their centres crosses no solid, and asserts every doorway run, start pose, and prop witness lands in the spawn's region; a failure redraws. Those are the engine's own clearance tests and the same two questions step 7's `walkable` and `can_step` answer, so the village is guaranteed connected in exactly the terms a student's own route planner will ask it in.

**Padding:** none. The fixture import leaves the generation package; `fixture.py` itself stays as the engine tests' known map.

**Tests landing:** the stable features placed once each, five homes in two or three clusters, reserved-site clearances, floor-ground overrides, structural wall and doorway props matching their semantic buildings, no overlapping final object cells, every doorway facing the path nearest its building and opening onto walkable cells, footpath crossing bounds, a witness for every interactive prop re-derived independently of the generator's own search, and strict connectivity over the walkable cells, all across the batch at full fidelity.

**Gate:** the owner signs off the dressed village, which opens the stage close.

## What a gate's close regenerates

Tuning rounds inside a gate are local: code changes plus browser looks, nothing committed, no pins touched. A gate's close is a commit point, and because the seam's output changed, the close re-runs `scripts/gen_three_branches_fixture.py` with its `SEED` and greeting tick re-picked by a scripted scan so the script's content assertions hold, refreshes the recording and decoded sidecar, re-picks the e2e chat constants and `test_builtins`' seed and opening-line pin, and runs the `three-branches` e2e group. If a review pause forces a mid-tuning commit, the close regeneration runs anyway. Step 3's fixture section is revised at the first close to say the recording plays a generated village, per the plan rules.

## The blessed seed and the stage close

The suite pins a batch of eight seeds, 0 (the reset default) and 17 (the conformance rollout seed) among them, every seed at full fidelity; the pinned batch is 0, 1, 2, 3, 5, 7, 11, and 17. The owner browses the batch in local watch sessions and blesses one seed as the course default; if the blessing waits, the mechanical items proceed on a provisional batch seed and re-run once blessed. The blessed seed becomes `test_budget`'s seed and the fixture script's `SEED`, and is recorded in this file; season pinning stays later work.

At the close:

- `test_budget`'s unchanged caps (1,201 frames, the cast_10 recording below 2 MiB, the header line below 16 KiB, replay identity, the cadence bound) re-measure at the blessed seed.
- The scripted visitor re-validates across the batch: its waypoint graph builds from the generated road and path cells, the visitor wanders a full day unstuck, and its reset cost stays inside the per-game budget.
- The fixture script re-runs at the blessed seed, the e2e chat seed and expected-line constants re-pick, step 3's stage file names the blessed seed, and the bare full browser suite runs before handoff.
- Reset times, generation and validation included, are recorded here for every batch seed.

## Tests

`environments/three_branches/tests/test_generation.py`, the structural suite across the pinned batch. The suite tests structure, not aesthetics: it holds no bend radius, heading corridor, monotonicity, curvature, bend inventory, or variety assertions, because shape is the review rounds' jurisdiction. Shrine spots assert placement and witnesses only.

The consolidated list, accreting per gate as the build order lands it:

- The stable features placed once each, five homes, and interactive props in canonical order with contiguous ids. The `Layout` constructor enforces the catalog's fixed counts and accepts a variable lantern count.
- The north entry inside the middle third, the fork inside its band, every course width, mouth separation, the edge margin, and water reaching the south edge in exactly three runs. Course masks prove that contact is limited to the explicit fork and confluence area, with width-aware clearance after it.
- The road's west entry and east exit, exactly one crossing per channel and never the trunk, every road or path cell over water carrying bridge ground with its aprons, at most one footpath crossing per channel, and the spawn on a road cell one metre in, clear of every footprint. Search tests cover the configured turn and crossing-angle costs, and mask tests cover continuous widened road and bridge decks.
- Reserved building sites not overlapping one another, water, the road, or the boundary, each keeping its clear margin; each accepted rect painted with open floor ground; perimeter wall props and the 2-cell passable doorway props matching its semantic building record; interior props inside their floors leaving the doorway run open; and every doorway facing the path nearest its building and opening onto walkable cells. The final object-cell ledger must contain no overlap, so placement failure is what the suite watches for.
- Strict connectivity: every body-clear cell reachable from the spawn under the step test, and every doorway run, start pose, and witness inside that region.
- A witness for every interactive prop use, re-derived independently of the generator's own search, measured to the prop's collision shape rather than to its reserved cells.
- Same-seed determinism, two builds comparing equal, and divergence, two batch seeds differing.
- The canonical static overlay payload below 12 KiB for every batch seed (the run-length ground grid is the dominant term; the full header line cap stays in `test_budget`). Lantern and pine skips do not redraw the land, the road, or the buildings.
- The observation's `village` Dict equal to the generated layout field for field, via `make_env` reset at a batch seed.
- Focused unit tests cover arithmetic derived from the configured frame, including coordinate conversion, edge margins, and width masks. The generator guarantees apply to the shipped configured frame, not to every possible frame size.

From the first flip, the conformance suite demands of every build: the redraw cap never trips at seeds 0 and 17, all geometry stays inside the frame, and same-seed builds compare equal.

Changed suites: the per-close regenerations (the fixture recording and sidecar, the e2e chat constants, the `three-branches` e2e group), and `test_budget` re-measured at the blessed seed at the stage close.

## Build order

Three milestones, each ending green:

1. Gate A: the stream, the redraw loop, the fields, the cell walker, the padding assembly, water, reeds, terraces, the road, its crossings, and the spawn; the seam flips; the gate's tests and the conformance suite green; review rounds to the sign-off; the close regeneration.
2. Gate B: sites, building templates, floor-ground overrides, structural props, footpaths, accessories, witnesses, and the reset validation; the full suite across the batch; the dressed village sign-off; the close regeneration.
3. Bless and close: the blessing (provisional seed fallback), the fixture and e2e regeneration at the blessed seed, the `test_budget` re-measure, step 3's revision, the bare full browser suite, and the done-when sweep.

## Done when

Any seed builds a valid, connected, fully guaranteed village that renders in the browser under the collision overlay, both gate sign-offs are recorded in this file, the guarantee suite and the conformance suite are green with the batch at full fidelity, full days at the blessed seed record inside the stage 2 budget and replay identically, the regenerated frontend fixtures hold the renderer and e2e suites green, and the owner has blessed the course default seed.
