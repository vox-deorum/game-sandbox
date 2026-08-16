# Step 5.1: Art style

Status: in progress. The owner approved Hearthside Ink on 2026-08-09, its flat tiled presentation on 2026-08-11, and the top-down-shooter character projection on 2026-08-12, and redirected the terrain boundaries to hand-tinted map seams with inked contours on 2026-08-14. Implementation lands through the owner-reviewed steps in this file.

Part of [the plan](../README.md). This first signed part of build-order step 5 replaces step 3's placeholder tileset, preserves its renderer contract and collision overlay, and leaves the HUD and input to [step 5.2](5-2-hud-interaction-and-camera.md). Its atlas art flows through the [step 5.0](5-0-atlas.md) pipeline. The approved reference is [Hearthside Ink](../art/hearthside-ink-approval.png).

## The design: Hearthside Ink

Hearthside Ink is a peaceful domestic sibling to Estuary Ink: natural ink wash, flatter woodblock value grouping, parchment ground, quiet water and reeds, warm timber, and deliberate small marks. The game uses an exact 90 degree top-down-shooter plan view. Each tile is one village cell, with no perspective, isometric face, or separate interiors.

Tiles are high-resolution flat shapes, not pixel art. The approval fixes palette, material, value grouping, and readability, but not a canonical layout, building placement, or scenery placement. Every seed remains a valid [village.md](../village.md) layout.

![Hearthside Ink approval mockup](../art/hearthside-ink-approval.png)

The supplemental [Hearthside Ink material board](../art/hearthside-ink-material-board.png) fixes the shared material language for production art. It is a landscape reference only, not a source for runtime extraction. It shows one overhead character, one domestic prop, pine and crate materials, packed earth beside a pale path, ground, floor, wall, contact shadow, glow, and restrained ink marks.

The board establishes a balanced midpoint between the current characters and props: flatter and quieter than the props, with more material definition than tint-only terrain. Each object uses three to five broad value groups. At 128 displayed pixels per cell, silhouettes use two-pixel ink and internal marks use one-pixel ink. Artwork uses the fixed Hearthside palette, 12 and 24 percent dark steps toward `backdrop`, and a 10 percent light step toward `bone`. Use low-frequency painted grain, controlled form shading, opaque interiors, one-pixel antialiased edges, and no baked cast shadows or perspective.

### Palette

The renderer exports one fixed `HEARTHSIDE_STYLE` palette for artwork, shaders, thumbnails, and tests.

| Key | Value | Name | Use |
| --- | --- | --- | --- |
| backdrop | #101816 | night ink | canvas surround, deepest unlit marks |
| parchment | #cfc5a9 | parchment | paper base and dry paths |
| bone | #efe7d3 | bone | pale marks, sprite edge lights, sparse highlights |
| ink | #6f6757 | dilute ink | drawn outlines, wash marks, unlit details |
| reed | #a9ae8a | reed | open ground and reed-flat grouping |
| silt | #bfa072 | silt | field soil, banks, and dry earth |
| water | #5a7680 | slack water | channels and water marks |
| pine | #4f6a4b | pine | trees, garden growth, and dark vegetation |
| indigo | #27436b | charcoal indigo | cool architectural shadow and stable NPC accents |
| cinnabar | #b0402e | cinnabar | restrained visitor distinction and active domestic accents |
| gilt | #d9a441 | gilt | hearth, lantern, and tiny warm points only |
| violet | #6b5d72 | ash violet | dusk shadow and weathered secondary marks |
| timber | #8a6246 | cedar timber | building bands, furniture, fences, and warm woodblock grouping |

Use broad value groups before small ink details. Cinnabar identifies `player_0`, the visitor, without creating a side-coloured board. Select each NPC's muted reed, pine, indigo, violet, parchment, and timber palette deterministically from its player id, never arrival order or replay history.

### Terrain and buildings

Author Terrain art at 128 px per cell and draw it at the renderer's 16-unit cell. Other atlas groups retain their listed frame sizes. Map x and y directly to the renderer's world axes.

Paint the engine-authored `overlay_static` grid as continuous material surfaces. The gameplay and collision grid stays authoritative. Natural visual boundaries may move by at most 0.6 cell perpendicular to their smoothed reference, which itself stays within 0.55 cell of the source edges, and retain at least 0.45 cell between opposing boundaries (a one-cell staircase band renders as a diagonal band near its natural 0.7-cell width). A drawn boundary may cross cell centres, so something standing near a boundary can visually stand on the neighboring material; collision and recorded ground stay exact.

Each material keeps several deterministic texture variants, composed into one repeating four-cell pattern. Natural surfaces use a half-cell offset grain pass so no blank cell grid shows. The road and path pilot use continuous authored texture and omit that second pass. Before contouring, a renderer-only substrate pass propagates the nearest natural ground, field, or reed material through road and path cells, with stable ties. A pure shared-contour pass traces every resulting material adjacency once and gives both neighboring materials the same curve in reverse. Land, water, road, and path use one curve-profile vocabulary, every field of it a distance in cells: sample spacing, corner radius, and noise octaves of wavelength and amplitude. Natural surfaces draw as anti-aliased vector polygons filled with their patterns, with no sparse halo layers and no stencil clip masks. Ground covers the complete map beneath them.

Road and path become inset textured routes above that substrate. The road pilot uses four seamless direction-neutral packed-earth frames: warm silt mixed 20 percent toward timber, broad compressed-earth washes, sparse broken flecks, three to five value bands, and no ruts, wood grain, stones, grass, borders, gradients, or focal object. The road follows deterministic column-run medians at 2.10 cells wide, may narrow no further than 1.60 cells, and is fully opaque. Ten same-pattern layers form a true linear edge fade from 0.1 cell inside to 0.1 cell outside the nominal route. Each pale parchment path is a 0.70-cell fully opaque stroke and shares the road frames for this pilot. All route material and fade layers cut away beneath bridge decks. Axis decks use butt-capped water-portal spans, so the route ends at the bank and neither cutout nor planks extend along the land approach. Bridge planks sit over water with a backdrop-tinted 0.18 shadow offset 0.06 cell south. Natural boundaries take the seam treatments: a darkened pooling band inside each field, reed, and water component, a broken grain-textured ink line with a faint bleed along every natural adjacency, and thin ink hatch lines offset onto the water, all cut away under roads, paths, and decks and tapered beside bridge portals. Architectural floor, doorway, and wall boundaries stay grid-aligned for the later Roofs unit.

Floor, wall, and doorway are ground classes. Paint each building from the grid: floor within, wall around its perimeter, and a two-cell opening on one side. A building record remains semantic only: id, type, and origin cell. It owns no collision, use selection, or prop-state observation. Hearths and repair benches are separate props on floor ground. Repeat wall tiles in the upper terrain layer as shallow dark eave and wall bands above occupants.

Each semantic building has a simple roof container aligned to its rect. A roof is opaque when empty and clears when anyone occupies its semantic rect. Occupancy fixes target alpha; the between-tick clock eases to it. Seeking, repeating a frame, mounting, or resizing snaps to it, so no forward-only roof history exists. Homes contain only floor treatment, the inn contains its hearth, and the repair shed contains its repair bench.

### Scene and motion

Keep step 3's shared tile-map pipeline. Build static terrain, upper walls, semantic roofs, scenery, and permanent prop bases once at mount from the recording header's layout. Never rebuild them on a tick update or seek.

Reconcile characters, prop-state treatments, roof alpha, phase grade, emissives, and crane dressing by stable id. The shared Pixi ticker smooths position, heading, walk frames, sustained effects, and crane motion between recorded ticks.

Resolve state treatments once per recorded tick. Between ticks, transform the cast and sustained effects without rebuilding art, and move collision bodies with their art. `presentation.json` owns the natural one-second transition. Paced hosts scale it to replay or watch cadence. An unpaced human session measures the gap between states, caps it at the natural duration, and passes no cadence. Keep the frame loop briefly alive after settling, reuse masks, and load textures only through the renderer-local manifest.

Draw world layers in this order:

1. Night-ink surround, then continuous terrain surfaces and their seam treatments, followed by inset routes, exact floors, doorways, walls, and bridge planks.
2. Scenery shadows and static prop bases.
3. Dynamic prop stills.
4. Character shadows and characters.
5. Upper walls, semantic roofs, and effects that belong above characters.
6. World-only day-phase grade.
7. Post-grade emissives, including lantern and hearth warmth.
8. Collision overlay, always above art and never graded.

HUD and interaction are step 5.2 work and are never colour-graded.

### Characters, props, and dressing

Build characters from shared north-facing grayscale-alpha masks in a conventional top-down-shooter projection. The camera looks straight down onto the head, shoulders, torso, arms, and partly occluded lower body. A peaceful forward-arm pose makes north readable without a weapon. Rotate the complete assembled sprite around its centre to the exact recorded heading. A rest frame and short walk cycle advance from player id, tick, and movement state without changing that projection. Render a readable fitted-view shadow and direction mark. Select tint combinations and optional shared clothing details with a stable player-id hash. Give `player_0` a small cinnabar hood tie and retain the villagers' warm materials. The owner approved [the top-down shooter direction](../art/top-down-shooter-direction.png).

![Approved top-down shooter direction](../art/top-down-shooter-direction.png)

Every catalog state has one distinct complete north-facing still across its catalog footprint, turned to its facing. Each 384 by 256 runtime canvas centers that footprint with at least two transparent pixels at its edge. The atlas leaves its unnamed trailing cells transparent. The pump is a fixed north-facing monument: its circular footing stays centered on the placement cell while the mechanism may extend north beyond its smaller collision circle. The bell has a state-independent circular stone foundation below characters and a fixed-north upper assembly above them. Drive the result only from prop id, type, state, facing, and tick.

| Prop | Still treatment |
| --- | --- |
| Market stall | `open` shows a raised awning, displayed goods, and a pale counter; `closed` has a lowered shutter and cleared counter. |
| Lantern post | `lit` has a gilt core and small post-grade pool; `unlit` has a dark empty lantern. |
| Bench | `occupied` has a distinct laid cushion or folded wrap; `empty` leaves the bare slats readable. |
| Roadside shrine | `tended` has a fresh paper offering and incense bowl; `untended` has only the weathered shrine under its roof. |
| Notice board | Its single `none` state is a fixed readable board with pale posted notices. |
| Garden plot | `tended` has ordered dark furrows and young green rows; `overgrown` has irregular pine-green growth that does not hide the fence. |
| Inn hearth | `lit` has a gilt-and-cinnabar coal core; `unlit` has cool ash and stacked dark wood. |
| Repair bench | `busy` has a laid-out tool and bright workpiece; `idle` has a cleared top and stored tools. |
| Well pump | Its round well curb is centered on the collision circle and its fixed-north mechanical assembly extends beyond it. `flowing` has a visible pale water stream and wet basin mark; `idle` has a dry basin and upright handle. |
| Beacon bell | Its state-independent filled circular stone foundation is centered on the collision circle below characters. Its fixed-north timber bell upper assembly extends beyond it above characters. The registered `ringing` upper has a tilted bell and exposed clapper, while `silent` hangs plumb. Manual owner review remains pending. |

Animate only lantern flicker, hearth fire, shrine incense, pump water, and bell swing. Each animation is a seek-safe function of fractional playback tick, prop id, current state, and a stable hash phase. A new prop type needs no renderer change only when it reuses a placement token, art treatment, and transition mechanism.

White cranes are renderer dressing, not layout or game data. Derive count, start, route, and frame from static-layout key and tick. They have no cell, footprint, collision, or perception effect. Draw them north-facing and rotate them to the route tangent.

### Day phase

With `daynight`, the overlay's dawn, morning, midday, evening, or night phase selects one world-only colour grade. It changes wash and contrast, not geometry, state meaning, or palette identity. Render sparse emissives after it. With daynight off, `day` is neutral. The collision overlay and later HUD remain ungraded.

### Assets and thumbnail

The local manifest is the only asset catalog. Keep only the high-resolution originals used by the approved art in `environments/three_branches/renderer/source-art/`. Keep optimised compiled files in `environments/three_branches/renderer/assets/`. Loose per-frame files under `assets/<group>/` are the editable truth; [step 5.0](5-0-atlas.md) compiles them into the atlas pages, and both are committed. Use grayscale-alpha masks for tintable textures and full-colour raster art only where tinting cannot express the treatment.

`environments/three_branches/renderer/presentation.json`, validated by `presentation.ts`, owns the palette, ground variants, land, water, road, and path curve profiles, seam treatments (pooling, ink, water hatching), reed marks, inset route and deck geometry, roof fade, phase grades, character treatments, prop effects, and crane dressing. `generation.json` remains generation-only, so visual calibration cannot alter seeded layouts.

`renderer/assets.ts` owns the catalog and runtime loader. Its six atlas entries record each source and compiled file, dimensions, tintability, consumer, and sprite-sheet frame grid. The runtime loader resolves only pages with shipped consumers: terrain, props, scenery, the four character layers, and effects. Edit art by changing loose frames and running the step 5.0 pack command, never by hand-editing an atlas page.

| Group | Compiled dimensions | Contents |
| --- | --- | --- |
| Terrain | 128 px cells on one 1024 by 1024 atlas page | A few fill variants for each ground class, retained compatibility masks, the wall tiles' upper-layer repaint, and bridge plank tiles |
| Buildings | 64 px cells | Semantic roof tiles for the home, the inn, and the repair shed |
| Props | 96 by 64 cells up to 3 by 2 cells | One complete full-colour still per catalog state, with transparent unnamed trailing atlas cells |
| Scenery | 64 px cells | Three red pine variants and the market crate |
| Characters | 192 by 192 frames | Shared rotatable directly overhead masks for body, clothing, and details, with rest and walk frames, plus shadow and direction marks |
| Effects and dressing | 64 by 64 through 192 by 128 | Glow, flame, smoke, pump water, bell lines, and two white crane poses |

The separate 320 by 180 thumbnail is a final Hearthside Ink image, not a screenshot requirement or map claim. It shows night ink around a parchment fragment: a slack-water branch, low crossing, one home and garden, warm lantern light, and a cinnabar visitor.

### Collision truth

[ruleset.md](../ruleset.md) fixes impassable ground, catalog collision shapes, counts, states, transitions, and prop reach. The collision overlay remains exact and authoritative. Natural surface contours may move by at most 0.6 cell perpendicular to the source edge while preserving the 0.45-cell corridor; they may cross cell centres. Walls, doorways, catalog shapes, the collision grid, generation, and recordings remain exact. Water and walls read solid, doorway ground open, and round catalog shapes read round, so walkers visibly slide around the pump, hearth, bell, lantern, and pine. The pump and bell use a 0.4-cell centered collision diameter inside their one-cell placement footprints. Their upper mechanisms, shadows, glow, smoke, and other non-solid effects may extend outside that shape. Art needing another extent changes the ground table or catalog and its generator, fixture, overlay, and tests together.

## Correctness, review, and configuration

The owner judges the rendered result through `npm run play -- three_branches watch --seed N` with the collision overlay. Terrain review captures the fixture and seeds 0, 17, and 37 at fitted, mid, and close fixed scales, plus one close collision-on view for each layout, for 16 PNGs total. Any temporary capture harness is removed after review. Each visual step below ends with that review, and its sign-off and date are recorded in place. No review tooling is added.

## Foundation

Status: complete.

The common layer under every visual step. It has no owner gate: the step 3 solid-colour drawing still renders until art lands, so every existing probe and journey keeps its meaning.

- `presentation.json` holds `palette` (the 13 keys), `transition` (natural and settle-grace durations), `terrain` (fills, contour calibration, seam treatments, reed marks, planks, upper wall), `roofs` (clear alpha and fade duration), `phaseGrades` (dawn, morning, midday, evening, night, no day entry), `characters` (clothing tints, details, walk, visitor), `propEffects` (lantern, hearth, shrine, pump, bell), `emissives`, and `cranes`.
- `presentation.ts` validates it in the `overlay.ts` style, cross-checks every frame name against the manifest, every tint against the palette, and the graded phases against `rules.json`, and exports `HEARTHSIDE_STYLE`. The step 3 canvas and camera numbers stay in TypeScript, and the provisional palette becomes a diagnostic palette kept for chrome, the collision overlay, and the pre-asset fallback.
- `tint.ts` maps manifest frame grids to rectangles and bakes tinted grayscale masks for the tiled ground in a browser-only canvas, cached per atlas, frame, and tint. Sprites elsewhere tint directly.
- `index.ts` reshuffles the scene graph to `worldRoot { gradedWorld { map, scenery, props, characters, upper }, emissives, collision }` with chrome outside the camera transform, matching the draw order above. One ColorMatrixFilter on `gradedWorld` is the world-only grade, so post-grade and ungraded are structural.
- `loadArt()` runs after setup: it resolves the current runtime pages, validates and slices their frames, bakes the tinted tileset, installs terrain and character art, sets the `threeBranchesAssets` probe to ready, and re-renders. The solid-colour drawing remains the pre-load and failure fallback.

`overlay.ts`, `collision.ts`, `collision-layer.ts`, `chrome.ts`, and `camera.ts` do not change. Tests cover configuration validation, the 13 fixed hexes, day-grade neutrality, and the paced and unpaced duration rules.

The foundation's successful art load swaps in the configured tinted terrain fills. The Terrain step owns fill variation, contour composition, shoreline, bridge overlays, and upper-wall artwork. The world-grade filter remains neutral until the Phase, cranes, and cadence step composes and applies the configured grades.

## Terrain

`terrain-contours.ts` and `terrain-routes.ts` orchestrate the `terrain-contour-*.ts` and `terrain-route-*.ts` pipeline families. Alongside `terrain-curves.ts`, `terrain-art.ts`, and `map-layer.ts`, they land the retained terrain: pattern-filled vector surfaces, seam treatments, inset routes, component decks, and upper wall bands. `terrain-helpers.ts` holds terrain-specific shared helpers. `types.ts` owns the public terrain data contracts, while pipeline modules keep the working types needed across stage boundaries. Generic hash primitives and the generic distance helper live in `frontend/src/renderers/base/math.ts`.

- Surfaces: the full ground base covers every cell. A nearest-natural propagation fills road and path cells with renderer-only ground, field, or reed substrate before natural contours are built. A second pass then normalizes that visual grid so no two natural materials meet at a corner alone: each diagonal-only touch rewrites one of the two cells that block it, each cell at most once, leaving cells that carry a structure or a bridge alone. Cardinal adjacency alone then decides every region, so contours never meet an ambiguous crossing. Each material composes its fill variants into one repeating four-cell pattern canvas with a half-cell offset grain pass, then draws as anti-aliased component polygons filled with that pattern. Water and bridge share one visual surface; exact structure tiles sit above the natural layers.
- Contours: one pure half-edge graph includes the fixed map exterior and preserves every adjacency as one shared curve. Components retain their outer ring and directly owned holes; islands remain separate components without containment metadata. Before shaping, each chain derives a smoothed reference polyline. The raw boundary traces cell edges, so a boundary that really runs at an angle arrives quantized into stair runs of whatever length that angle implies, and the reference recovers the line those runs approximate at every run length. Whether a corner between two runs is quantization or shape is settled by the way the boundary continues rather than by any distance. A run whose two neighbours travel the same way has crossed between them, and two neighbouring crossings mean the boundary has stepped over twice the same way, which is the grid drawing an angle: the corners inside those four runs are steps and are never offered as reference vertices. One crossing alone settles nothing, since a one-cell notch opens the same way and only turns back on its far side, so every other corner is offered exactly, along with the midpoint of each run, which is where the line that run quantizes passes. Simplification then keeps the fewest of those candidates whose chords stay within 0.55 cell of the ones they span, bending on a midpoint wherever one is available, so what it flattens is the wobble left where run lengths change rather than the staircase itself. A closed chain also holds its drift under its own mean inradius, the enclosed area over the perimeter, since a small island is narrower than the drift bound in every direction and would otherwise slide inward and shrink away, and it keeps four spread anchors so the loop stays a loop. Every reference sheds the same staircase, so the two banks of a thin band travel together and keep the width between them. Locked geometry keeps its exact raw shape, and a closed reference keeps a vertex at raw offset zero so downstream seam interpolation stays valid. Shaping runs per chain on the reference: a three-point corner kernel smooths the resampled polyline, then summed noise octaves displace free points along the local normal. An octave amplitude is the distance a boundary usually moves, not a peak it reaches on a handful of samples, so the noise field carries its own deviation and the configured number is the one drawn. That distance is what keeps a bank from reading as the ruled chords its reference is built from. Nothing smooths the noise, since it is laid on after the corner kernel has run, so a band draws every bend it carries and its wavelength has to stay several times the corner radius: a short band turns an elbow on every half period, and a boundary that elbows every couple of cells reads as terraced rather than drawn. The corner radius is a distance too, since the kernel spreads a sample's influence the way diffusion spreads heat and rounds to `spacing * sqrt(passes / 2)`: the passes are derived from the radius asked for, so the corner shape no longer changes whenever the sample spacing moves. The radius has to clear the reference corners it is smoothing, which are mostly the short zigzag left where a stair run was too irregular to collapse, and 0.8 cell leaves a twentieth of the boundary turning past 45 degrees against a tenth at half a cell. Land uses 0.25-cell samples, a 0.8-cell corner radius, and octaves of 0.20 cell at nine cells and 0.14 at 4.5. Water uses 0.20-cell samples, the same 0.8-cell radius, and octaves of 0.22 at eleven cells and 0.15 at five. Closed chains cap their effective passes by sample count so small ponds keep their shape. Map edges, structures, bridge entrances, and 0.15 cell of tangent on each side of them stay locked. That tangent is what holds three chains leaving one junction node in consistent directions, and it is also what freezes the first corner past the node, so it is kept only as long as it needs to be. A displacement budget bounds both stages rather than a correction applied after them: each reference vertex may leave the reference by at most the 0.6-cell deviation cap and at most half its slack beyond the 0.45-cell corridor to competing boundaries, locks hold zero, and eroding the budget along the arc at half a cell per cell keeps it from stepping between neighbouring samples, since a bound that jumps is what kinks an otherwise smooth curve. Where the room left is smaller than the amplitude asked for, the wander gives way to it smoothly rather than being clipped at it, since a boundary clipped at its bound runs along that bound and turns a corner every time the noise changes sign. A sample past its bound is drawn back toward the point of the reference it strayed from, which bounds the distance that has to be bounded and leaves the tangential slide alone. Segments of the chain a sample sits on, and segments of a chain meeting it at a junction measured through that shared node, compete only when their arc distance is clearly larger than their straight-line distance, so a chain smooths freely along itself and a junction approach curves like the boundary it continues, while inlets, hairpins, and narrow wedges keep their corridor. Where the reference turns a corner tighter than the displacement spent there, neighbouring samples move inward along converging normals and swap order, so their chords cross; clearance cannot see that, since the geometry it would have to measure against is the same curve a few samples along. Those crossing pieces are repaired directly, pulling halfway toward the reference until the curves are planar.
- Seams: a pooling band strokes the inside of each field, reed, and water component in its own tint darkened 16 percent, 0.45 cell wide at 0.28 opacity. The ink line covers natural adjacencies in deterministic broken runs, alternating 4 to 9 cell runs with 0.6 to 1.7 cell gaps so no stretch of bank longer than one gap goes undrawn and a chain shorter than one run draws whole: a faint wide bleed underlay plus grain-textured body pieces whose width and tone wobble around 0.15 cell at 0.70 opacity. Water hatching draws thin offset ink lines on the water side at 0.10 cell. Each hatch line moves whole segments of the bank and joins consecutive offset segments where their lines cross, so a corner keeps its full offset instead of being pulled back into the bank, and a corner whose miter would run past twice the offset bevels instead. Where the bank turns tighter than the offset, that meeting swings past the opposite branch and the line would fold into a bowtie, which strokes as a small dark triangle out on the water. Two properties of a true offset undo the fold: every point stays the full offset away from the source, allowing 0.05 cell for the sag of the sampled chords, and every step walks the source forward rather than back down it. Points failing either are dropped and the survivors join across the gap. All three seam treatments cut away under road, path, and deck coverage through one inverse mask and taper over 0.35 cell beside bridge portals.
- Reeds: the reed fill shades its tint 45 percent toward pine and deepens its grain to a 20 percent value shift, and deterministic short stalk marks scatter by cell above the pooling band, cut away under routes like the seams. A mark is kept only where it lands on the drawn reed surface, so the stalks stop where the smooth bank stops instead of redrawing the cell staircase over it, and cells the surface reaches without being reed cells carry marks too. The reed frames still want a bolder authored mark pass; the scatter marks carry the reed texture until that art lands.
- Routes: the road uses deterministic column-run medians, including road-owned bridge components, shaped with 0.25-cell samples, ten passes, and one 0.05-cell octave at six cells. It is 2.10 cells wide and never narrows below 1.60. Ten same-pattern layers form a true linear edge fade from 0.1 cell inside to 0.1 cell outside the nominal route while their composite alpha rises linearly to the configured full opacity. The path profile uses 0.20-cell samples, fourteen passes, and one 0.04-cell octave at seven cells. Paths render as 0.70-cell pattern strokes at full opacity. Route material and every fade layer cut away beneath bridge decks.
- Bridges: the plank configuration names horizontal, vertical, and compact frames. A pure cardinal connected-component planner assigns orientation and route ownership, with road winning mixed road and path contacts. Axis decks use butt-capped water-portal spans, so the route ends at the bank and neither cutout nor planks extend along the land approach. Each component clips repeated plank tiles through one exact 2.10-cell road or 0.70-cell path deck mask. Planks sit over water with a backdrop-tinted 0.18 shadow offset 0.06 cell south, so transparent plank gaps reveal shadowed water rather than route material.
- Camera: the maximum zoom is sixteen times the fitted view. On the 120-cell map this brings a 16-unit world cell close to the Terrain frame's native 128-pixel display size for clear material inspection.
- Keep the existing Terrain atlas dimensions, frame names, and compatibility frames. Repaint the wash, road, furrow, reed, ripple, and bridge families from the approved material study. Tiled fill frames remain opaque with matching borders, and their same-hue value detail stays within each fill's configured value shift, seven percent by default. Bridge masks keep their transparent water gaps. Static substrate, contours, routes, seams, and decks build once during art installation and do no tick-time work.

Tests cover strict curve-profile configuration, contour topology and determinism, full partition ownership, diagonal-touch normalization and junction routing, islands and holes, reference drift and corridor bounds, substrate propagation, route ownership and widths, seam run coverage, reed marks, component deck masks, and the drawn-layer lifecycle. A property sweep over curated grids, generated layouts, and the recorded village itself proves the drawn curve graph planar and inside its reference tube, with an interpolation sag allowance, and proves junction approaches free to leave the raw staircase. The recorded village belongs in that suite because a property that holds on every synthetic grid and fails on the map that ships has not been tested. A second property holds the size of the wander, not only its ceiling: given room to spare, a boundary moves the distance its octaves were configured for. Without it the amplitudes were free to be inert, and were. A second sweep proves every hatch line of a bending river free of folded loops, alongside a bank bending tighter than the offset that pins the distance the offset holds. Those are calibration bounds, so the tests hold them and the renderer does not: art that bulges a tenth of a cell past its tube is still art, while aborting art installation over it would drop the whole map back to flat diagnostic colour. The renderer still fails loudly on partition ownership, where a face that never closes means the drawn fills themselves are wrong. Run the Three Branches e2e group here, since the scene-graph reshuffle and the first textured layer land together.

The owner reviews the terrain: parchment ground, water and banks, reeds, fields, paths, building floors, walls, doorways, and bridges.

### Terrain sign-off

Pending. Manual owner sign-off after terrain watch-session review remains required.

### Material board and road pilot sign-off

Pending. The owner reviews the material board and road pilot together before automated tests or independent review. Inspect seeds 0, 17, and 37 at fitted, middle, and maximum zoom in daylight, plus one night view. Accept only if the road stays one stable warm material over ground, field, reeds, and bridge approaches, with no substrate bleed, fuzzy double grain, cell grid, visible four-by-four repeat, directional texture, or curve seams. Confirm that the path remains lighter and narrower, routes remain below characters and props, collision corridors remain plausible, and the board reads as the intended midpoint. Confirm that no road, path, or fade texture is visible under bridge planks, plank gaps reveal shadowed water, the light south-offset shadow reads as a small height cue, and axis cutouts and planks end at the water portals without extending along the land approach. No automated checks run before this visual gate.

## Characters

`characters-art.ts` selects player-id-hashed tints and details from the allowed pool, advances the walk cycle (leftForward, pass, rightForward, pass) from player id, fractional tick, and movement, and fixes rotation at 90 degrees minus heading, in radians. `characters.walk.frameRatio` gives each pose's duration as a positive fraction of one recorded presentation tick. `characters.ts` assembles each character as a shadow plus a rotor of body, clothing, arms, and detail masks with a direction mark. `player_0` wears `visitorTie` in cinnabar. Below the far-view readability threshold shared with [step 5.2](5-2-hud-interaction-and-camera.md)'s nameplates, a character draws as a Hearthside-styled overhead mark, a tinted circle with a direction tick, in place of the unreadable sprite. Step 5.2 owns the ungraded recorded-expression treatment and its final optional arm-pose study.

Tests cover style, walk, and rotation determinism. The owner reviews the cast at rest, walking, and turning, and the far-view marks.

### Character sign-off

Pending. The owner reviews the cast in watch sessions and records the date here.

## Props, scenery, and effects

`props-art.ts` resolves every catalog type and state to one complete north-facing state still. Each 384 by 256 canvas centers its collision footprint, holds at least two transparent pixels at the edge, and draws at the owner-calibrated fixed scale inside a facing container. `SHIPPED_PROP_TYPES` enables all ten complete prop still types. The pump ignores placement facing, keeps its centered shadow below characters, and draws its complete still and effects in the upper character layer. The bell adds its state-independent foundation to the prop layer below characters, while its fixed-north upper still and effect stay in the upper character layer. `effects.ts` holds the five sustained animations and emissive specs as pure functions of fractional tick, prop id, state, and stable hash phase. Effect configuration objects own their frames and `frameRate`. `props-layer.ts` keeps scenery unchanged, validates the shipped still and needed accent frames before installation, and installs art atomically.

After visual acceptance, tests cover every catalog state mapping, enabled-type preflight, excluded-type fallback, fixed scaling, centered placement, facing rotation, and deterministic animation. The owner then reviews every state in [the treatment table](#characters-props-and-dressing), the pines and crates, and the emissives.

### Prop sign-off

The owner approved all ten complete prop still types on 2026-08-15. The accepted still art remains approved. The next manual owner review covers the native-density correction, slower expanded animations, the owner-calibrated character and prop sizes, subtle prop contact shadows, and the revised fixed-north pump and bell. Confirm that each monument's collision circle follows its centered round footing, its upper mechanism occludes characters, and the bell reads as a solid civic plinth rather than a well. State shadows and the two monument mechanisms may extend beyond collision, while gameplay and collision remain exact. Review the accepted slice by toggling `stall_0` and `lantern_0`, tending `plot_0`, waiting 600 ticks for its return, inspecting fitted, middle, and close zoom with collision overlays, and confirming north and south stall rotation. The review accepts no fragments, clear state changes, correctly layered accents, exact collision registration, and the pending calibration.

## Roofs

`buildings.ts` replaces the outline rectangles with roof tile plans of corners, edges, ridge, and hash-picked fills, built once per building. Occupancy of the semantic rect at the recorded target tick fixes target alpha, `onFrame` eases toward it, and seek, mount, frame repeat, and resize snap. Roofs land after characters so the fade is reviewed over visible occupants. Roof occupancy reads recorded positions, so a character interpolating across a rect boundary can briefly clip an opaque roof; that is a known limit of recorded occupancy.

Tests cover occupancy targets, easing, and snap semantics. The owner reviews the home, inn, and shed roofs fading on entry.

### Roof sign-off

Pending. The owner reviews the roofs in watch sessions and records the date here.

## Phase, cranes, and cadence

- Day phase: per-phase wash, contrast, brightness, and saturation compose one colour matrix; `day` and missing entries yield no filter.
- `cranes.ts` derives count, routes, and per-tick states from the static-layout key, drawn north-facing and rotated to the route tangent.
- Cadence: a paced host keeps the natural duration times its `transitionScale`. With no scale, the renderer measures the wall-clock gap between deliveries and animates over the gap capped at the natural duration. The frame loop stays alive for a short grace after settling.
- The 320 by 180 thumbnail lands here.

Tests cover crane determinism and the cadence rules. The owner reviews each phase grade over the finished village, the cranes, and the fixture and generated seeds at fitted, mid, and close scales. The bare full browser suite runs before handoff.

### Final sign-off

Pending. The owner reviews the finished style across phases and seeds and records the date here.

## Tests

The suite tests structure, not aesthetics: no test measures whether the village reads well, since that is the owner's call at each sign-off. Keep the mechanical coverage to:

- Configuration: `presentation.json` validation for contour, seam, route, and deck calibration, the 13 fixed hexes, day-grade neutrality, and the paced and unpaced duration rules.
- Determinism: equal inputs give equal fills, contours, routes, tints, walk frames, prop treatments, and crane routes, and sustained animations are pure at equal inputs.
- Scene lifecycle: statics build once per static-layout key, dynamic nodes reconcile by id, no tick rebuilds statics, and seek, frame repeat, and resize snap.
- Collision truth: overlay solids match wall ground, doorways stay passable, and prop and scenery sprites sit on their catalog shapes.
- Run the Three Branches browser e2e group while iterating and the bare full browser e2e suite before handoff.

## Done when

The fixture and generated villages replay in approved Hearthside Ink with contoured, seam-treated terrain, cutaway roofs, deterministic state treatments, phase grading, and a toggleable collision overlay that matches collision truth. Every step sign-off above is dated, manifest assets and the thumbnail load in production, and the Three Branches and full browser e2e suites pass.
