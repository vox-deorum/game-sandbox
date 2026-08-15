# Step 5.1: Art style

Status: in progress. The owner approved Hearthside Ink on 2026-08-09, its flat tiled presentation on 2026-08-11, and the top-down-shooter character projection on 2026-08-12, and redirected the terrain boundaries to hand-tinted map seams with inked contours on 2026-08-14. Implementation lands through the owner-reviewed steps in this file.

Part of [the plan](../README.md). This first signed part of build-order step 5 replaces step 3's placeholder tileset, preserves its renderer contract and collision overlay, and leaves the HUD and input to [step 5.2](5-2-hud-interaction-and-camera.md). Its atlas art flows through the [step 5.0](5-0-atlas.md) pipeline. The approved reference is [Hearthside Ink](../art/hearthside-ink-approval.png).

## The design: Hearthside Ink

Hearthside Ink is a peaceful domestic sibling to Estuary Ink: natural ink wash, flatter woodblock value grouping, parchment ground, quiet water and reeds, warm timber, and deliberate small marks. The game uses an exact 90 degree top-down-shooter plan view. Each tile is one village cell, with no perspective, isometric face, or separate interiors.

Tiles are high-resolution flat shapes, not pixel art. The approval fixes palette, material, value grouping, and readability, but not a canonical layout, building placement, or scenery placement. Every seed remains a valid [village.md](../village.md) layout.

![Hearthside Ink approval mockup](../art/hearthside-ink-approval.png)

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

Use broad value groups before small ink details. Cinnabar identifies the visitor without creating a side-coloured board. Select each NPC's muted reed, pine, indigo, violet, parchment, and timber palette deterministically from character id, never arrival order or replay history.

### Terrain and buildings

Author Terrain art at 128 px per cell and draw it at the renderer's 16-unit cell. Other atlas groups retain their listed frame sizes. Map x and y directly to the renderer's world axes.

Paint the engine-authored `overlay_static` grid as continuous material surfaces. The gameplay and collision grid stays authoritative. Natural visual boundaries may move by at most 0.6 cell perpendicular to their source edge and retain at least 0.70 cell between opposing boundaries. A drawn boundary may cross cell centres, so something standing near a boundary can visually stand on the neighboring material; collision and recorded ground stay exact.

Each material keeps several deterministic texture variants, composed into one repeating four-cell pattern with a half-cell offset grain pass so no blank cell grid shows. Before contouring, a renderer-only substrate pass propagates the nearest natural ground, field, or reed material through road and path cells, with stable ties. A pure shared-contour pass traces every resulting material adjacency once and gives both neighboring materials the same curve in reverse. Land, water, road, and path use one curve-profile vocabulary: sample spacing, smoothing passes, and noise octaves of wavelength and amplitude. Natural surfaces draw as anti-aliased vector polygons filled with their patterns, with no sparse halo layers and no stencil clip masks. Ground covers the complete map beneath them.

Road and path become inset textured routes above that substrate. The guaranteed west-to-east road follows deterministic column-run medians at 2.10 cells wide, may narrow no further than 1.60 cells, and blends the timber treatment at 0.82 opacity. Each pale path is a 0.70-cell stroke at full opacity. Water and bridge cells share one water surface. Bridge components retain exact portals, classify as road or path with road winning a mixed contact, and clip their plank texture through component-wide deck masks at the matching route width. Natural boundaries take the seam treatments: a darkened pooling band inside each field, reed, and water component, a broken grain-textured ink line with a faint bleed along every natural adjacency, and thin ink hatch lines offset onto the water, all cut away under roads, paths, and decks and tapered beside bridge portals. Architectural floor, doorway, and wall boundaries stay grid-aligned for the later Roofs unit.

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

Build characters from shared north-facing grayscale-alpha masks in a conventional top-down-shooter projection. The camera looks straight down onto the head, shoulders, torso, arms, and partly occluded lower body. A peaceful forward-arm pose makes north readable without a weapon. Rotate the complete assembled sprite around its centre to the exact recorded heading. A rest frame and short walk cycle advance from character id, tick, and movement state without changing that projection. Render a readable fitted-view shadow and direction mark. Select tint combinations and optional shared clothing details with a stable character-id hash. Give the visitor a small cinnabar hood tie and retain the villagers' warm materials. The owner approved [the top-down shooter direction](../art/top-down-shooter-direction.png).

![Approved top-down shooter direction](../art/top-down-shooter-direction.png)

Every catalog state has a distinct readable treatment across the prop's reserved cells, turned to its facing. Reuse one tintable base and state overlays when the silhouette stays fixed. Use a bespoke still only when a state changes the prop's silhouette. Drive the result only from prop id, type, state, facing, and tick.

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
| Well pump | `flowing` has a visible pale water stream and wet basin mark; `idle` has a dry basin and upright handle. |
| Beacon bell | `ringing` has a tilted bell, exposed clapper, and ringing lines; `silent` hangs plumb without those marks. |

Animate only lantern flicker, hearth fire, shrine incense, pump water, and bell swing. Each animation is a seek-safe function of fractional playback tick, prop id, current state, and a stable hash phase. A new prop type needs no renderer change only when it reuses a placement token, art treatment, and transition mechanism.

White cranes are renderer dressing, not layout or game data. Derive count, start, route, and frame from static-layout key and tick. They have no cell, footprint, collision, or perception effect. Draw them north-facing and rotate them to the route tangent.

### Day phase

With `daynight`, the overlay's dawn, morning, midday, evening, or night phase selects one world-only colour grade. It changes wash and contrast, not geometry, state meaning, or palette identity. Render sparse emissives after it. With daynight off, `day` is neutral. The collision overlay and later HUD remain ungraded.

### Assets and thumbnail

The local manifest is the only asset catalog. Keep only the high-resolution originals used by the approved art in `environments/three_branches/renderer/source-art/`. Keep optimised compiled files in `environments/three_branches/renderer/assets/`. Loose per-frame files under `assets/<group>/` are the editable truth; [step 5.0](5-0-atlas.md) compiles them into the atlas pages, and both are committed. Use grayscale-alpha masks for tintable textures and full-colour raster art only where tinting cannot express the treatment.

`environments/three_branches/renderer/presentation.json`, validated by `presentation.ts`, owns the palette, ground variants, land, water, road, and path curve profiles, seam treatments (pooling, ink, water hatching), reed marks, inset route and deck geometry, roof fade, phase grades, prop effects, and crane dressing. `generation.json` remains generation-only, so visual calibration cannot alter seeded layouts.

`renderer/assets.ts` owns the catalog and runtime loader. Its six atlas entries record each source and compiled file, dimensions, tintability, consumer, and sprite-sheet frame grid. The runtime loader resolves only terrain until the deferred consumers land. Edit art by changing loose frames and running the step 5.0 pack command, never by hand-editing an atlas page.

| Group | Compiled dimensions | Contents |
| --- | --- | --- |
| Terrain | 128 px cells on one 1024 by 1024 atlas page | A few fill variants for each ground class, retained compatibility masks, the wall tiles' upper-layer repaint, and bridge plank tiles |
| Buildings | 64 px cells | Semantic roof tiles for the home, the inn, and the repair shed |
| Props | cell-sized treatments up to 3 by 2 cells | One tintable base per prop type, state overlays where the silhouette stays fixed, and bespoke stills only for silhouette-changing states |
| Scenery | 64 px cells | Three red pine variants and the market crate |
| Characters | 192 by 192 frames | Shared rotatable directly overhead masks for body, clothing, and details, with rest and walk frames, plus shadow and direction marks |
| Effects and dressing | 64 by 64 through 192 by 128 | Glow, flame, smoke, pump water, bell lines, and two white crane poses |

The separate 320 by 180 thumbnail is a final Hearthside Ink image, not a screenshot requirement or map claim. It shows night ink around a parchment fragment: a slack-water branch, low crossing, one home and garden, warm lantern light, and a cinnabar visitor.

### Collision truth

[ruleset.md](../ruleset.md) fixes impassable ground, catalog collision shapes, counts, states, transitions, and prop reach. The collision overlay remains exact and authoritative. Natural surface contours may move by at most 0.6 cell perpendicular to the source edge while preserving the 0.70-cell corridor; they may cross cell centres. Walls, doorways, catalog shapes, the collision grid, generation, and recordings remain exact. Water and walls read solid, doorway ground open, and round catalog shapes read round, so walkers visibly slide around the pump, hearth, bell, lantern, and pine. Non-solid shadows, glow, smoke, and other effects may extend outside a shape. Art needing another extent changes the ground table or catalog and its generator, fixture, overlay, and tests together.

## Correctness, review, and configuration

The owner judges the rendered result through `npm run play -- three_branches watch --seed N` with the collision overlay. Terrain review captures the fixture and seeds 0, 17, and 37 at fitted, mid, and close fixed scales, plus one close collision-on view for each layout, for 16 PNGs total. Any temporary capture harness is removed after review. Each visual step below ends with that review, and its sign-off and date are recorded in place. No review tooling is added.

## Foundation

Status: complete.

The common layer under every visual step. It has no owner gate: the step 3 solid-colour drawing still renders until art lands, so every existing probe and journey keeps its meaning.

- `presentation.json` holds `palette` (the 13 keys), `transition` (natural and settle-grace durations), `terrain` (fills, contour calibration, seam treatments, reed marks, planks, upper wall), `roofs` (clear alpha and fade duration), `phaseGrades` (dawn, morning, midday, evening, night, no day entry), `characters` (clothing tints, details, walk, visitor), `propEffects` (lantern, hearth, shrine, pump, bell), `emissives`, and `cranes`.
- `presentation.ts` validates it in the `overlay.ts` style, cross-checks every frame name against the manifest, every tint against the palette, and the graded phases against `rules.json`, and exports `HEARTHSIDE_STYLE`. The step 3 canvas and camera numbers stay in TypeScript, and the provisional palette becomes a diagnostic palette kept for chrome, the collision overlay, and the pre-asset fallback.
- `tint.ts` maps manifest frame grids to rectangles and bakes tinted grayscale masks for the tiled ground in a browser-only canvas, cached per atlas, frame, and tint. Sprites elsewhere tint directly.
- `index.ts` reshuffles the scene graph to `worldRoot { gradedWorld { map, scenery, props, characters, upper }, emissives, collision }` with chrome outside the camera transform, matching the draw order above. One ColorMatrixFilter on `gradedWorld` is the world-only grade, so post-grade and ungraded are structural.
- `loadArt()` runs after setup: it resolves the terrain URL, loads that atlas, slices frames, bakes the tinted tileset, swaps the textured layers in, sets the `threeBranchesAssets` probe to ready, and re-renders. The solid-colour drawing remains the pre-load and failure fallback.

`overlay.ts`, `collision.ts`, `collision-layer.ts`, `chrome.ts`, and `camera.ts` do not change. Tests cover configuration validation, the 13 fixed hexes, day-grade neutrality, and the paced and unpaced duration rules.

The foundation's successful art load swaps in the configured tinted terrain fills. The Terrain step owns fill variation, contour composition, shoreline, bridge overlays, and upper-wall artwork. The world-grade filter remains neutral until the Phase, cranes, and cadence step composes and applies the configured grades.

## Terrain

`terrain-contours.ts` and `terrain-routes.ts` orchestrate the `terrain-contour-*.ts` and `terrain-route-*.ts` pipeline families. Alongside `terrain-curves.ts`, `terrain-art.ts`, and `map-layer.ts`, they land the retained terrain: pattern-filled vector surfaces, seam treatments, inset routes, component decks, and upper wall bands. `terrain-helpers.ts` holds terrain-specific shared helpers. `types.ts` owns the public terrain data contracts, while pipeline modules keep the working types needed across stage boundaries. Generic hash primitives and the generic distance helper live in `frontend/src/renderers/base/math.ts`.

- Surfaces: the full ground base covers every cell. A nearest-natural propagation fills road and path cells with renderer-only ground, field, or reed substrate before natural contours are built. Each material composes its fill variants into one repeating four-cell pattern canvas with a half-cell offset grain pass, then draws as anti-aliased component polygons filled with that pattern. Water and bridge share one visual surface; exact structure tiles sit above the natural layers.
- Contours: one pure half-edge graph includes the fixed map exterior, preserves every adjacency as one shared curve, and resolves ambiguous two-material saddles deterministically. Components retain their outer ring and directly owned holes; islands remain separate components without containment metadata. Shaping runs per chain: a three-point corner kernel smooths the resampled polyline over the configured passes, then summed noise octaves displace free points along the local normal. Land uses 0.25-cell samples, 72 passes, and octaves of 0.28 cell at eight cells, 0.12 at three, and 0.05 at 1.2. Water uses 0.20-cell samples, 160 passes, and octaves of 0.34 at eleven, 0.14 at four, and 0.06 at 1.5. Closed chains cap their effective passes by sample count so small ponds keep their shape, and near locks the heavy smoothing blends back to a light 12-pass form so junction approaches stay natural. Map edges, structures, junction tangents, and bridge entrances stay locked. Displacement is measured perpendicular to the chain's own raw boundary within a 2.5-cell arc window, so a curve may slide along its boundary freely while a clearance envelope caps how far it leaves it: at most the 0.6-cell deviation cap, at most half the slack beyond the 0.70-cell corridor to competing raw boundaries, and at most the arc distance to the nearest lock, with the envelope evaluated at both the sample and its projection. Same-chain segments compete only when their arc distance is clearly larger than their straight-line distance, so staircases smooth into diagonals while inlets and hairpins keep their corridor. Rare tip geometry that still smooths across itself is repaired directly: crossing pieces pull halfway toward raw until the curves are planar. A final validator proves the tube, with an interpolation sag allowance, and the intersection-free topology.
- Seams: a pooling band strokes the inside of each field, reed, and water component in its own tint darkened 16 percent, 0.45 cell wide at 0.28 opacity. The ink line covers natural adjacencies in deterministic broken runs at 0.85 density: a faint wide bleed underlay plus grain-textured body pieces whose width and tone wobble around 0.15 cell at 0.70 opacity. Water hatching draws thin offset ink lines on the water side at 0.10 cell. All three cut away under road, path, and deck coverage through one inverse mask and taper over 0.35 cell beside bridge portals.
- Reeds: the reed fill shades its tint 45 percent toward pine and deepens its grain to a 20 percent value shift, and deterministic short stalk marks scatter inside every reed cell above the pooling band, cut away under routes like the seams. The reed frames still want a bolder authored mark pass; the scatter marks carry the reed texture until that art lands.
- Routes: the road uses deterministic column-run medians, including road-owned bridge components, shaped with 0.25-cell samples, ten passes, and one 0.05-cell octave at six cells. It is 2.10 cells wide, never narrows below 1.60, and flattens to 0.82 opacity through an alpha filter so overlapping strokes never double-composite. The path profile uses 0.20-cell samples, fourteen passes, and one 0.04-cell octave at seven cells. Paths render as 0.70-cell pattern strokes at full opacity.
- Bridges: the plank configuration names horizontal, vertical, and compact frames. A pure cardinal connected-component planner assigns orientation and route ownership, with road winning mixed road and path contacts. Each component clips repeated plank tiles through one exact 2.10-cell road or 0.70-cell path deck mask while transparent plank gaps reveal water.
- Camera: the maximum zoom is sixteen times the fitted view. On the 120-cell map this brings a 16-unit world cell close to the Terrain frame's native 128-pixel display size for clear material inspection.
- Keep the existing Terrain atlas dimensions, frame names, and compatibility frames. Repaint the wash, road, furrow, reed, ripple, and bridge families from the approved material study. Tiled fill frames remain opaque with matching borders, and their same-hue value detail stays within each fill's configured value shift, seven percent by default. Bridge masks keep their transparent water gaps. Static substrate, contours, routes, seams, and decks build once during art installation and do no tick-time work.

Tests cover strict curve-profile configuration, contour topology and determinism, full partition ownership, saddle and junction routing, islands and holes, envelope deviation and corridor bounds, substrate propagation, route ownership and widths, seam stroke runs, reed marks, component deck masks, and the drawn-layer lifecycle. Run the Three Branches e2e group here, since the scene-graph reshuffle and the first textured layer land together.

The owner reviews the terrain: parchment ground, water and banks, reeds, fields, paths, building floors, walls, doorways, and bridges.

### Terrain sign-off

Pending. Manual owner sign-off after terrain watch-session review remains required.

## Characters

`characters-art.ts` selects id-hashed tints and details from the allowed pool, advances the walk cycle (leftForward, pass, rightForward, pass) from id, fractional tick, and movement, and fixes rotation at 90 degrees minus heading, in radians. `characters.ts` assembles each character as a shadow plus a rotor of body, clothing, arms, and detail masks with a direction mark. The visitor wears `visitorTie` in cinnabar. Below the far-view readability threshold shared with [step 5.2](5-2-hud-interaction-and-camera.md)'s nameplates, a character draws as a Hearthside-styled overhead mark, a tinted circle with a direction tick, in place of the unreadable sprite.

Tests cover style, walk, and rotation determinism. The owner reviews the cast at rest, walking, and turning, and the far-view marks.

### Character sign-off

Pending. The owner reviews the cast in watch sessions and records the date here.

## Props, scenery, and effects

`props-art.ts` resolves every catalog type and state to a base plus overlays where the silhouette holds, or a bespoke still where it changes. The node's container rotation applies facing, and treatments re-resolve only when the recorded state changes. `effects.ts` holds the five sustained animations and the emissive specs, each a pure function of fractional tick, prop id, state, and a stable hash phase. `props-layer.ts` splits scenery and static prop bases from dynamic stills and drives the animated accents.

Tests cover that every catalog state resolves and that animation is pure at equal inputs. The owner reviews every state in [the treatment table](#characters-props-and-dressing), the pines and crates, and the emissives.

### Prop sign-off

Pending. The owner reviews props, scenery, and effects in watch sessions and records the date here.

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
