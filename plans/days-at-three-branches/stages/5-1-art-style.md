# Step 5.1: Art style

Status: planned. The owner approved the Hearthside Ink direction on 2026-08-09, and its tiled presentation on 2026-08-11: flat tiles with no pixel grid, autotiled terrain, roofs that cut away, and one rotating character sheet.

Part of [the plan](../README.md). This is the first of build-order step 5's two signed parts: it replaces step 3's placeholder tileset with the final village identity while preserving the same renderer contract and collision overlay. The hands-on review surface is the pinned fixture replayed in Hearthside Ink, with the collision overlay available as a toggle. The owner's approved reference is [Hearthside Ink](../art/hearthside-ink-approval.png).

## Why this is its own seam

The village's visual identity is an owner decision. This stage makes that decision buildable without taking over the HUD or the interaction controls, which remain in [step 5.2](5-2-hud-interaction-and-camera.md). It keeps the generated village and its collision truth visible through the same rendering path that steps 3 and 4 established.

## The design: Hearthside Ink

Hearthside Ink is a peaceful domestic sibling to Estuary Ink. It combines Estuary's natural ink wash with flatter woodblock value grouping: parchment ground, quiet water and reeds, warm timber, and small deliberate marks that make a lived-in village readable. It is drawn as a conventional 2D top-down RPG in exact 90 degree plan view, with every tile a village cell. There is no perspective, isometric face, or separate interior scene.

Tiles are flat shapes drawn at high resolution rather than pixel art, so the village stays clean at every zoom the camera allows. The approval image fixes the palette, material, value grouping, and readability standard. It does not fix a canonical generated layout, exact building placement, or incidental scenery placement. Every seed remains a valid interpretation of [village.md](../village.md)'s generator rules.

![Hearthside Ink approval mockup](../art/hearthside-ink-approval.png)

### Palette

The renderer exports one `HEARTHSIDE_STYLE` palette. Names and values are fixed so artwork, shaders, thumbnail, and tests share one vocabulary.

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

The world uses broad value groups before small ink detail. Cinnabar identifies the visitor without turning the village into a side-coloured game board. NPC palettes are selected deterministically from their character id and use muted combinations of reed, pine, charcoal indigo, ash violet, parchment, and cedar timber. The selection never depends on arrival order or replay history.

### The tiled village

Art is authored at 64 px per cell and drawn at the renderer's 16-unit cell, so a tile carries four times the detail the fitted view needs and stays clean when the camera zooms in. The world is always drawn in plan view, with x and y mapped directly to the renderer's world axes, so character bodies, prop footprints, and the collision overlay share one unprojected coordinate system.

The ground is the engine-authored grid from `overlay_static`, painted through the shared tile map base in two layers:

1. **Fill.** Every cell takes a tile for its ground class. Each class ships a few interior variants, chosen deterministically from the cell so a wide field or a broad channel never reads as a repeating stamp.
2. **Edges.** A pure pass over the ground grid derives an edge code per cell where a class meets a different one, and the edge layer paints bank lines, road and path shoulders, reed fringes, and field furrow ends over the fill. Both layers ride the shared base's neighbour-mask `variant` hook, which is the only seam between the tileset and the renderer.

Bridge cells take plank tiles over the water fill, so a crossing reads as a deck. Nothing is ever drawn smaller than a cell: a mark that fits inside one cell repeats in every cell of its class and turns the ground into a lattice.

### Buildings and cutaway roofs

Floor, wall, and doorway are ground classes like any other, and the terrain tile layers paint a building's site straight from the grid: floor fill inside, wall fill around the perimeter, and the 2-cell doorway opening through one side, all using the same neighbour-mask autotile hook that fills and edges every other class. A building record stays purely semantic: an id, a type, and an origin cell. It carries no collision object of its own and never enters use selection or prop-state observations. Interior props such as the hearth and the repair bench remain separate objects with their own stills and state treatments, placed on the floor ground but not part of the building record. Wall tiles repeat in the upper terrain layer, drawn above occupants as shallow dark eave and wall bands, so the collision truth reads without hiding the people inside.

Each semantic building owns a roof container aligned to its rect. The roof is opaque while the building is empty and clears away while anyone stands inside the building's semantic rect. The target alpha is a pure function of the recorded tick's occupancy of that rect, the between-tick clock eases toward that target, and a seek, a repeated frame, a mount, or a resize snaps straight to it, so cutaway state carries no forward-only history and a replay seek is exact. Homes hold only their floor treatment, the inn holds its hearth, and the repair shed holds its repair bench, exactly as their catalog records say.

### Static and dynamic Pixi scene

The renderer keeps step 3's shared tile map pipeline. It builds the static scene once at mount from the layout the recording header carries: the terrain tile layers, including the upper wall layer, semantic building roofs, scenery, and permanent interactive-prop bases. A session watches one village, so no tick update and no seek rebuilds it.

Dynamic nodes reconcile by stable id: characters, prop state treatments, roof alpha, phase grade, emissives, and crane dressing. Normal playback uses the shared Pixi ticker to smooth character movement and heading, walking frames, sustained prop effects, and crane motion between recorded ticks.

One recorded tick resolves every state treatment once. The frames in between carry the cast and the sustained effects and touch no artwork, so an in-between frame costs transforms rather than a rebuilt scene, and the collision bodies move with the art they describe. The renderer-local presentation configuration owns the natural one-second transition duration, and a paced host's render options scale it to replay or watch cadence. A live human session is unpaced and passes no cadence at all, so the renderer measures the gap between arriving states and animates over that instead, capped at the natural duration; without it a quarter-second village would crawl through a one-second transition and draw the cast three ticks behind where it is. The frame loop holds briefly after a transition settles rather than stopping, because restarting it at every tick boundary costs a frame and reads as a stutter. Masks are reused, and texture loading comes through the renderer-local manifest.

The world layer order is fixed:

1. Night-ink surround and the base terrain tile layers, fill then edges, for every ground class including building floor and doorway ground and bridge planks.
2. Scenery shadows and static interactive-prop bases.
3. Dynamic interactive-prop stills.
4. Character shadows and characters.
5. The upper terrain layer, which repeats wall tiles above occupants so the eave and wall bands still read, plus semantic building roofs and any prop effect that belongs above a character.
6. The world-only day-phase colour grade.
7. Sparse post-grade emissives, including lit lantern and hearth warmth.
8. The collision overlay, always above the art and never graded.

HUD and interaction layers are not part of this stage. Step 5.2 owns them, and they are never colour-graded by the world phase treatment.

### Characters

A character is one sprite sheet authored facing north and rotated to the exact recorded heading, so facing on screen is the heading the engine holds and the vision cone reads honestly. The sheet carries a rest frame and a short walk cycle; the cycle advances one frame per tick from the character id, the tick, and the movement state, so the stride keeps pace with the ground a walker covers and a replay seek is exact. A shadow sits under the body and a small direction mark rides the sprite, both readable when the village is fitted and the bodies are small.

A stable character-id hash selects one of the villager sheets. The visitor uses a small cinnabar hood tie alongside the same warm materials as villagers. NPCs remain people rather than team tokens.

### Props, state stills, and sustained motion

Every state in the catalog has a distinct readable still, drawn across the prop's reserved cells and turned to its facing. The art is driven by the existing prop id, type, state, facing, and tick, never by inferred use history.

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

The only sustained prop animations are a lit lantern's restrained flicker, a lit hearth's fire, a tended shrine's incense drift, a flowing pump's water, and a ringing bell's swing. Each is a function of fractional playback tick, prop id, and current state, with a phase derived from a stable hash. It is smooth between recorded ticks and safe to seek directly to any replay tick.

Because the catalog drives the stills, a new prop type needs no renderer change only when it reuses an existing placement token, art treatment, and transition mechanism. Other types extend the relevant generator, art, or state contracts.

White cranes are sparse renderer dressing, not layout or game data. Their count, start, route, and frame derive from the static-layout key and tick. They have no cell, no footprint, and no collision or perception effect. Each crane is drawn facing north like every other rotatable sprite here, and turns onto the tangent of the lane it flies.

### Day phase

When `daynight` is enabled, the phase name derived by the overlay selects one world-only colour grade for dawn, morning, midday, evening, or night. It changes the broad wash and contrast without changing geometry, state meaning, or the palette's identity. Sparse emissives render after this grade, so lanterns and the hearth retain their warm readability at night. When daynight is off, the `day` grade is neutral. The collision overlay and the HUD implemented later remain ungraded.

### Assets and thumbnail

The renderer declares a local manifest as the only runtime loading contract. High-resolution originals, including superseded source variants, live in `environments/three_branches/renderer/source-art/`. Optimised runtime files live in `environments/three_branches/renderer/assets/`. Grayscale-alpha masks are used wherever a texture needs palette tinting. Full-colour raster art is reserved for a treatment that cannot be represented as a tintable mask.

Renderer presentation tuning lives in `environments/three_branches/renderer/presentation.json`, validated by `presentation.ts`. It owns the Hearthside palette, the ground fill variants and edge mapping, the roof fade, phase grades, prop effects, and crane dressing. `generation.json` remains limited to village-generation tuning, so visual calibration never changes seeded layout generation.

The manifest names the source file, runtime file, dimensions, tintability, consumer, and frame grid where an asset is a sprite sheet. It lives in [`renderer/assets.ts`](../../../environments/three_branches/renderer/assets.ts) and its entry count is recorded here when it lands:

| Group | Runtime dimensions | Contents |
| --- | --- | --- |
| Terrain | 64 px cells on one atlas page | For each ground class, including wall and doorway, a few interior fill variants and its edge and corner set, the wall tiles' upper-layer repaint, and the bridge plank tiles |
| Buildings | 64 px cells | Semantic roof tiles for the home, the inn, and the repair shed |
| Props | cell-sized stills up to 3 by 2 cells | One still for every catalog state, including the notice board's single state |
| Scenery | 64 px cells | Three red pine variants and the market crate |
| Characters | 192 by 192 frames | One rotatable sheet per villager variant and one for the visitor, each with a rest frame and its walk cycle, plus shadow and direction marks |
| Effects and dressing | 64 by 64 through 192 by 128 | Glow, flame, smoke, pump water, bell lines, and two white crane poses |

The separate 320 by 180 thumbnail is a final Hearthside Ink village image, not a screenshot requirement or a map claim. It uses night ink around a parchment village fragment: a slack-water branch, a low crossing, one home with its garden, warm lantern light, and a small cinnabar visitor. It communicates the approved style without declaring a canonical seed or layout.

### Visual agreement with collision truth

[ruleset.md](../ruleset.md) owns the ground table that fixes which classes are impassable, and the canonical catalog tables for interactive-prop and scenery collision shapes, counts, states, and transitions, and separately fixes prop reach. Physical art and collision-overlay drawings must agree with those records exactly. Impassable ground reads solid, which is water and wall alike, with the wall band keeping its eave line, while doorway ground stays visibly open. Round catalog shapes must read round, so a walker visibly slides around the pump, hearth, bell, lantern, and pine. Shadows, glow, smoke, and other non-solid effects may extend beyond a collision shape. Any art that needs a different extent changes the ground table or the canonical catalog and its dependent generator, fixture, overlay, and test contracts in the same implementation.

### Review boundary

Review the fixture and generated seeds at fitted, mid, and close review scales by rendering fixed scales on the existing surface. This review does not depend on camera controls. Step 5.2 later verifies the same readability through interactive zoom. This stage does not choose camera limits, pan behaviour, HUD typography, speech-bubble layout, use preview, or input controls. It retains the step 3 collision toggle on watch, replay, and play surfaces.

## Tests

- Renderer scene tests prove that the static terrain layers and building containers build once per static-layout key, that dynamic nodes reconcile by id, and that no tick rebuilds static tiles.
- Tile tests cover the fill variant choice being deterministic per cell, the derived edge codes for every class boundary including frame edges and corners, and bridge planks landing on exactly the bridge cells.
- Building tests cover floor, wall, and doorway ground painting matching each semantic building rect, walls repeating in the upper terrain layer above occupants, and roof alpha resolving from semantic-building occupancy alone, with a seek snapping to the target and a replayed render equal to a direct one.
- Prop tests validate a distinct still for every shipped state, correct placement under each facing, and the catalog cap on exterior footprints. State tests cover stall, bench, board, plot, repair bench, lantern, hearth, shrine, pump, and bell treatments.
- Shape tests prove every circular interactive prop and pine is drawn round within its catalog extent, and every box interactive prop fills its catalog extent.
- Character tests cover the rotation to the exact heading, deterministic walk-frame selection from id, tick, and movement state, and villager sheet selection from the character-id hash.
- Deterministic seek tests compare direct renders and replayed renders for every sustained animation, phase grade, walk frame, roof state, and crane. Interpolation tests cover exact endpoints, smooth midpoints, cadence scaling, the measured-gap fallback for an unpaced host, shortest-path heading turns, and offscreen crane wrapping. A per-frame motion pass is proved to reach the same retained pose as a full recorded tick.
- Phase tests prove one world-only grade, post-grade emissives, neutral day when daynight is off, and ungraded collision overlay and HUD boundary.
- Asset tests validate the renderer-local manifest, dimensions, source-art originals, optimised runtime files, tintable masks where declared, and the final thumbnail.
- Collision agreement tests prove that wall ground cells are exactly the solid shapes the overlay draws, doorway ground stays passable, and every interactive prop and scenery sprite sits on the catalog shape the overlay draws for it.
- Run the Three Branches browser e2e group while iterating. Before handoff, run the bare full browser e2e suite.

## Done when

The fixture and generated villages replay in the approved Hearthside Ink style with autotiled terrain, cutaway roofs, deterministic state treatments, phase grade, and a toggleable collision overlay that agrees with collision truth. The manifest assets and thumbnail load in the production build, the Three Branches and bare full browser e2e suites pass, and the owner's direction and presentation approvals remain recorded in this file.
