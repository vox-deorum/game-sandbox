# Step 5.1: Art style

Status: planned. The owner approved the Hearthside Ink direction and bounded prop-calibration policy on 2026-08-09. The implemented catalog dimensions still require the fixture review defined below.

Part of [the plan](../README.md). This is the first of build-order step 5's two signed parts: it replaces step 3's placeholder tileset with the final village identity while preserving the same renderer contract and collision overlay. The hands-on review surface is the pinned fixture replayed in Hearthside Ink, with the collision overlay available as a toggle. The owner's approved reference is [Hearthside Ink](../art/hearthside-ink-approval.png).

## Why this is its own seam

The village's visual identity is an owner decision. This stage makes that decision buildable without taking over the HUD, interaction controls, or camera behavior, which remain in [step 5.2](5-2-hud-interaction-and-camera.md). It keeps the generated village and its collision truth visible through the same rendering path that steps 3 and 4 established.

## The design: Hearthside Ink

Hearthside Ink is a peaceful domestic sibling to Estuary Ink. It combines Estuary's natural ink wash with flatter woodblock value grouping: parchment ground, quiet water and reeds, warm timber, and small deliberate marks that make a lived-in village readable. It uses an exact 90-degree orthographic 2D RPG plan view. There is no perspective, isometric face, opaque roof, or separate interior scene.

The approval image fixes the palette, material, projection, scale relationships, and readability standard. It does not fix a canonical generated layout, exact building placement, or incidental scenery placement. Every seed remains a valid interpretation of [village.md](../village.md)'s generator rules.

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
| indigo | #27436b | charcoal indigo | cool structural shadow and stable NPC accents |
| cinnabar | #b0402e | cinnabar | restrained visitor distinction and active domestic accents |
| gilt | #d9a441 | gilt | hearth, lantern, and tiny warm points only |
| violet | #6b5d72 | ash violet | dusk shadow and weathered secondary marks |
| timber | #8a6246 | cedar timber | building bands, furniture, fences, and warm woodblock grouping |

The world uses broad value groups before small ink detail. Cinnabar identifies the visitor without turning the village into a side-colored game board. NPC palettes are selected deterministically from their character id and use muted combinations of reed, pine, charcoal indigo, ash violet, parchment, and cedar timber. The selection never depends on arrival order or replay history.

### Village, buildings, and interiors

Author world and assets at 16 logical px per meter. The world is always drawn in plan view, with x and y mapped directly to the renderer's world axes. Character bodies, prop footprints, and the collision overlay therefore share one unprojected coordinate system.

Ground begins with the engine-authored 100 by 100 grid from `overlay_static`. A seeded tile choice gives each `road`, `open`, `field`, `reeds`, and `water` cell three or four deterministic wash variants. Reusable paper, wash, furrow, reed, ripple, and dry-brush masks create material variation without changing the engine's classes. The renderer draws the generated channels, road, footpaths, bridges, buildings, doorway gaps, prop rectangles, and scenery from decoded layout geometry. It never substitutes a baked village map.

Buildings are permanently open. Each building has a local Pixi container whose origin, rotation, width, depth, and doorway are taken from the generated record, so arbitrary generator rotations remain exact. Its non-solid floor paint lies below occupants. The generated solid wall segments, including the exact 1.2 m doorway gap, render as shallow dark eave and wall bands above occupants. The bands explain the collision shape without concealing people inside. Homes contain only their flat non-solid floor treatment. The inn contains only its hearth. The repair shed contains only its repair bench. Floors, fixtures, bands, doorway clearance, and collision overlay all agree with the generated rectangle and its local rotation.

### Static and dynamic Pixi scene

The renderer keeps step 3's shared `pixi-tiledmap` pipeline. It creates a static scene once for each static-layout key, derived from the decoded layout for that key and its 100 by 100 ground grid. That build owns the Tilemap, terrain washes, generated channel, road, path, bridge and building geometry, scenery, permanent prop bases, and static mask instances. A layout change replaces the static scene. A tick update does not rebuild it.

Dynamic nodes reconcile by stable id: characters, prop state treatments, phase grade, emissives, and crane ambience. A seek, repeated frame, mount, or resize computes the same retained scene directly from the layout key, decoded tick, state, and id. It carries no forward-only visual state. Masks are reused, and texture loading comes through the renderer-local manifest.

The world layer order is fixed:

1. Night-ink surround, ground Tilemap, and paper and terrain washes.
2. Generated water, roads, paths, bridge decks, scenery shadows, and building floors.
3. Static prop bases and dynamic prop stills.
4. Character shadows and characters.
5. Building wall and eave bands, doorway-side details, and any prop effect that belongs above a character.
6. The world-only day-phase color grade.
7. Sparse post-grade emissives, including lit lantern and hearth warmth.
8. The collision overlay, always above the art and never graded.

HUD and interaction layers are not part of this stage. Step 5.2 owns them, and they are never color-graded by the world phase treatment.

### Characters and presentation levels

`presentationFor(bodyCssWidth)` is a pure helper based on the body's displayed CSS width. It does not own camera zoom, fitting, or panning.

- Compact is below 12 CSS px: a high-contrast body mark, shadow, and rotated direction mark.
- Simple is 12 CSS px through below 24 CSS px: an eight-direction sprite with a clear apron, hair, or sleeve silhouette.
- Detailed is 24 CSS px and above: an eight-direction, four-frame sprite with legible domestic clothing and a restrained personal palette.

The sprite's facing is quantized only for its body art. A separate rotated direction mark shows the exact recorded heading at every level, including headings between the eight sprite directions. Walking frames use a deterministic tick, character id, and movement-state selection, so replay seek is exact. Under reduced motion, the selected standing frame remains still.

The visitor uses cinnabar in a restrained sash, coat panel, or head covering alongside the same warm materials as villagers. NPCs remain people rather than team tokens: their stable id palette and silhouette are enough to follow them over a day.

### Props, state stills, and sustained motion

Every state in `props.json` has a distinct readable still. The art is driven by the existing prop id, type, state, rotation, and tick, never by inferred use history.

| Prop | Still treatment |
| --- | --- |
| Market stall | `open` shows a raised awning, displayed goods, and a pale counter; `closed` has a lowered shutter and cleared counter. |
| Lantern post | `lit` has a gilt core and small post-grade pool; `unlit` has a dark empty lantern. |
| Bench | `occupied` has a distinct laid cushion or folded wrap; `empty` leaves the bare slats readable. |
| Roadside shrine | `tended` has a fresh paper offering and incense bowl; `untended` has only the weathered shrine. |
| Notice board | Its single `none` state is a fixed readable board with pale posted notices. |
| Garden plot | `tended` has ordered dark furrows and young green rows; `overgrown` has irregular pine-green growth that does not hide the fence. |
| Inn hearth | `lit` has a gilt-and-cinnabar coal core; `unlit` has cool ash and stacked dark wood. |
| Repair bench | `busy` has a laid-out tool and bright workpiece; `idle` has a cleared top and stored tools. |
| Well pump | `flowing` has a visible pale water stream and wet basin mark; `idle` has a dry basin and upright handle. |
| Beacon bell | `ringing` has a tilted bell, exposed clapper, and ringing lines; `silent` hangs plumb without those marks. |

The only sustained prop animations are a lit lantern's restrained flicker, a lit hearth's fire, a tended shrine's incense drift, a flowing pump's water, and a ringing bell's swing. Each is a function of tick, prop id, and current state, with a phase derived from a stable hash. It is safe to seek directly to any replay tick. `prefers-reduced-motion` freezes each at its representative active still while retaining the state treatment, phase grade, and all gameplay information.

White cranes are sparse renderer dressing, not layout or game data. Their count, start, route, and frame derive from the static-layout key and tick. They have no footprint and no collision or perception effect. Reduced motion shows each selected crane at one static, layout-key-derived pose.

### Day phase

When `daynight` is enabled, the phase name derived by the overlay selects one world-only color grade for dawn, morning, midday, evening, or night. It changes the broad wash and contrast without changing geometry, state meaning, or the palette's identity. Sparse emissives render after this grade, so lanterns and the hearth retain their warm readability at night. When daynight is off, the `day` grade is neutral. The collision overlay and the HUD implemented later remain ungraded.

### Assets and thumbnail

The renderer declares a local manifest as the only runtime loading contract. High-resolution originals, including superseded source variants, live in `environments/three_branches/renderer/source-art/`. Optimized runtime files live in `environments/three_branches/renderer/assets/`. Grayscale-alpha masks are used wherever a texture needs palette tinting. Full-color raster art is reserved for paper grain or a treatment that cannot be represented as a tintable mask.

The manifest names the source file, runtime file, dimensions, tintability, and consumer. Feasible categories are:

| Category | Runtime dimensions | Contents |
| --- | --- | --- |
| Paper and terrain masks | 512 by 512 paper grain; 128 by 128 wash variants; 128 by 64 ripple, furrow, and reed marks | Reusable ground material, with three or four variants per ground class. |
| Linear geometry masks | 256 by 64 and 128 by 64 | Bank edges, road dry-brush marks, path edges, bridge planks, wall and eave bands. |
| Buildings and props | 128 by 128, 192 by 128, or 256 by 128 as needed | Local floor fills, reusable fixture masks, stalls, shrines, fences, and state marks. |
| Characters | 128 by 128 per eight-direction simple frame; 192 by 192 per detailed frame | Compact mark, simple sprite, detailed four-frame sprite, shadow, and direction mark. |
| Effects and dressing | 64 by 64 through 192 by 128 | Glow, flame, smoke, water stream, bell lines, and white crane masks. |
| Thumbnail | 320 by 180 | Final Hearthside Ink village image, not a screenshot requirement or a map claim. |

The thumbnail uses night ink around a parchment village fragment: a slack-water branch, a low bridge, one open home with its garden, warm lantern light, and a small cinnabar visitor. It communicates the approved style without declaring a canonical seed or layout.

### One-time prop geometry calibration

Before final art assets are produced, implement the bounded calibration policy by proposing one complete dimensions table for the existing prop catalog and reviewing it with the owner in the pinned fixture. Art may revise a prop type's width and depth only when its physical form requires it. The reviewed table updates `props.json`, [village.md](../village.md), [ruleset.md](../ruleset.md), relevant environment or platform specifications, physics, generation, fixture positions, overlay expectations, and tests in the same implementation. Physical art, physics shapes, and collision-overlay footprints must match. Shadows, glow, smoke, and other non-solid effects may extend beyond the footprint. Prop ids, counts, states, transitions, districts, and the universal 1.5 m reach remain fixed. Exterior props stay at or below 4 m in width and depth. Interior props fit their building and leave the doorway clear. The owner approves the complete table before final production assets are accepted.

The garden plot calibration is fixed now: it is a 4.0 m by 3.0 m solid fenced plot with no gate. Its 4 m edge is centered on, parallel to, and flush with the home wall opposite the doorway, extending outward from the building. This keeps the doorway and its approach clear. Villagers tend the plot from outside. Prop selection and tie ranking change for every prop from center distance to distance from the nearest point on its rotated footprint, with the unblocked line checked to that nearest point and a canonical-index tie break. All non-prop ranges remain position-to-position. This rule replaces the position-to-position prop wording in [ruleset.md](../ruleset.md), [environment.md](../environment.md), and [step 2](2-engine-and-environment.md). Step 5.2's use preview and step 7's `props.in_reach` and `props.usable` helpers use the same engine-owned footprint-distance and nearest-point rule, and their tests pin them to engine selection. This implementation updates fixture plot positions and step 4's generator guarantees and standing witnesses. The environment is pre-release, so no historical overlay compatibility layer is needed. Static recording fixtures and pins regenerate together.

### Review boundary

Review the fixture and generated seeds at compact, simple, and detailed presentation levels by rendering fixed review scales on the existing surface. This review does not depend on camera controls. Step 5.2 later verifies the same thresholds through its interactive zoom. This stage does not choose camera limits, pan behavior, HUD typography, speech-bubble layout, use preview, or input controls. It retains the step 3 collision toggle on watch, replay, and play surfaces.

## Tests

- Renderer scene tests prove that one static Tilemap and generated static geometry build per static-layout key, dynamic nodes reconcile by id, and no tick rebuilds static ground or layout geometry.
- Projection and presentation tests cover the exact 90-degree plan projection, arbitrary building rotation, open interiors, floors below occupants, wall and eave bands above them, the 1.2 m doorway gap, and values on both sides of the 12 and 24 CSS px thresholds. They also prove the exact-heading direction mark remains readable.
- Prop-catalog tests validate the exterior 4 m size cap and a distinct still for every shipped state. State tests cover stall, bench, board, plot, repair bench, lantern, hearth, shrine, pump, and bell treatments.
- Deterministic seek tests compare direct renders and replayed renders for every sustained animation, phase grade, character walk frame, and crane dressing. Reduced-motion tests freeze representative active stills and static cranes without hiding state.
- Phase tests prove one world-only grade, post-grade emissives, neutral day when daynight is off, and ungraded collision overlay and HUD boundary.
- Asset tests validate the renderer-local manifest, dimensions, source-art originals, optimized runtime files, tintable masks where declared, and the final thumbnail.
- Prop calibration tests cover the catalog's exterior size cap, the garden's 4.0 m by 3.0 m rotated footprint centered against the wall opposite each doorway, clear doorway approaches, nearest-edge reach boundary, nearest-point line check, canonical-index ties, fixture and generator standing witnesses, overlap rules, physics/body-clear agreement, and renderer/collision footprint agreement. They also prove interior props fit and keep doorways clear.
- Run the Three Branches browser e2e group while iterating. Before handoff, run the bare full browser e2e suite.

## Done when

The fixture and generated villages replay in the approved Hearthside Ink style with exact plan-view open interiors, deterministic state treatments, phase grade, reduced-motion stills, and a toggleable collision overlay that agrees with collision truth. The owner has approved the implemented prop-dimensions table, and that calibrated geometry, including the fenced garden, is implemented across data, rules, physics, generation, fixtures, recordings, and tests. The manifest assets and thumbnail load in the production build, the Three Branches and bare full browser e2e suites pass, and the owner's 2026-08-09 direction and policy approval remain recorded in this file.
