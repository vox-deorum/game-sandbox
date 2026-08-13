# Step 5.1: Art style

Status: in progress. The owner approved Hearthside Ink on 2026-08-09 and its tiled presentation on 2026-08-11. On 2026-08-12, implementation moved the presentation closer to top-down-shooter conventions: directly overhead characters rotate continuously, simple roofs fade on entry, and shared tintable masks replace individually painted variants wherever silhouette does not carry state.

Part of [the plan](../README.md). This first signed part of build-order step 5 replaces step 3's placeholder tileset, preserves its renderer contract and collision overlay, and leaves the HUD and input to [step 5.2](5-2-hud-interaction-and-camera.md). Review the pinned fixture in Hearthside Ink with the collision overlay toggle. The approved reference is [Hearthside Ink](../art/hearthside-ink-approval.png).

## The design: Hearthside Ink

Hearthside Ink is a peaceful domestic sibling to Estuary Ink: natural ink wash, flatter woodblock value grouping, parchment ground, quiet water and reeds, warm timber, and deliberate small marks. The game uses an exact 90 degree top-down-shooter plan view. Each tile is one village cell, with no perspective, isometric face, or separate interiors.

Tiles are high-resolution flat shapes, not pixel art. The approval fixes palette, material, value grouping, and readability, but not a canonical layout, building placement, or scenery placement. Every seed remains a valid [village.md](../village.md) layout.

![Hearthside Ink approval mockup](../art/hearthside-ink-approval.png)

### Decision record

This record preserves owner decisions made during implementation, including choices that are later superseded. The rest of this stage describes the current approved result.

| Date | State | Decision |
| --- | --- | --- |
| 2026-08-09 | Current | Use Hearthside Ink for the palette, material treatment, value grouping, and overall readability. |
| 2026-08-11 | Current | Use flat, non-pixel tiles, autotiled terrain, and cutaway roofs. |
| 2026-08-12 | Current | Keep simple roofs and fade them when a character enters the building. |
| 2026-08-12 | Current | Reuse tintable masks for characters and terrain edges. Give a prop a bespoke state still only when the state changes its silhouette. |
| 2026-08-12 | Approved | **Character projection:** Author one north-facing base sprite in the stacked true-overhead projection of a conventional top-down shooter, then rotate the complete assembled sprite around its centre for exact heading. The camera looks straight down onto the head, shoulders, torso, arms, and partly occluded lower body. Use peaceful forward arms or another body cue in place of a weapon. The owner approved [the top-down shooter direction](../art/top-down-shooter-direction.png). |

![Approved top-down shooter direction](../art/top-down-shooter-direction.png)

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

Author art at 64 px per cell and draw it at the renderer's 16-unit cell. Map x and y directly to the renderer's world axes.

Paint the engine-authored `overlay_static` grid through step 3's shared tile base in two layers:

1. **Fill:** Each ground class has several interior variants, selected deterministically by cell.
2. **Edges:** A pure ground-grid pass derives a code wherever classes meet and paints banks, path shoulders, reed fringes, and furrow ends over fills.

Both layers use the shared base's neighbour-mask `variant` hook, the tileset's only renderer seam. Reuse tintable grayscale-alpha edge masks across compatible ground boundaries instead of painting each palette pairing. Bridge cells paint planks over water. Do not draw marks smaller than a cell.

Floor, wall, and doorway are ground classes. Paint each building from the grid: floor within, wall around its perimeter, and a two-cell opening on one side. A building record remains semantic only: id, type, and origin cell. It owns no collision, use selection, or prop-state observation. Hearths and repair benches are separate props on floor ground. Repeat wall tiles in the upper terrain layer as shallow dark eave and wall bands above occupants.

Each semantic building has a simple roof container aligned to its rect. A roof is opaque when empty and clears when anyone occupies its semantic rect. Occupancy fixes target alpha; the between-tick clock eases to it. Seeking, repeating a frame, mounting, or resizing snaps to it, so no forward-only roof history exists. Homes contain only floor treatment, the inn contains its hearth, and the repair shed contains its repair bench.

### Scene and motion

Keep step 3's shared tile-map pipeline. Build static terrain, upper walls, semantic roofs, scenery, and permanent prop bases once at mount from the recording header's layout. Never rebuild them on a tick update or seek.

Reconcile characters, prop-state treatments, roof alpha, phase grade, emissives, and crane dressing by stable id. The shared Pixi ticker smooths position, heading, walk frames, sustained effects, and crane motion between recorded ticks.

Resolve state treatments once per recorded tick. Between ticks, transform the cast and sustained effects without rebuilding art, and move collision bodies with their art. `presentation.json` owns the natural one-second transition. Paced hosts scale it to replay or watch cadence. An unpaced human session measures the gap between states, caps it at the natural duration, and passes no cadence. Keep the frame loop briefly alive after settling, reuse masks, and load textures only through the renderer-local manifest.

Draw world layers in this order:

1. Night-ink surround, then terrain fills and edges for all ground, including floors, doorways, and bridge planks.
2. Scenery shadows and static prop bases.
3. Dynamic prop stills.
4. Character shadows and characters.
5. Upper walls, semantic roofs, and effects that belong above characters.
6. World-only day-phase grade.
7. Post-grade emissives, including lantern and hearth warmth.
8. Collision overlay, always above art and never graded.

HUD and interaction are step 5.2 work and are never colour-graded.

### Characters, props, and dressing

Build characters from shared north-facing grayscale-alpha masks in a conventional top-down-shooter projection. The camera looks straight down onto the head, shoulders, torso, arms, and partly occluded lower body. A peaceful forward-arm pose makes north readable without a weapon. Rotate the complete assembled sprite around its centre to the exact recorded heading. A rest frame and short walk cycle advance from character id, tick, and movement state without changing that projection. Render a readable fitted-view shadow and direction mark. Select tint combinations and optional shared clothing details with a stable character-id hash. Give the visitor a small cinnabar hood tie and retain the villagers' warm materials.

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

The local manifest is the only runtime loading contract. Keep only the high-resolution originals used by the approved runtime assets in `environments/three_branches/renderer/source-art/`. Keep optimised runtime files in `environments/three_branches/renderer/assets/`. Use grayscale-alpha masks for tintable textures and full-colour raster art only where tinting cannot express the treatment.

`environments/three_branches/renderer/presentation.json`, validated by `presentation.ts`, owns the palette, ground variants and edges, roof fade, phase grades, prop effects, and crane dressing. `generation.json` remains generation-only, so visual calibration cannot alter seeded layouts.

`renderer/assets.ts` is the only runtime asset-loading contract. Its six atlas entries record each source and runtime file, dimensions, tintability, consumer, and sprite-sheet frame grid.

| Group | Runtime dimensions | Contents |
| --- | --- | --- |
| Terrain | 64 px cells on one atlas page | A few fill variants for each ground class, shared tintable edge and corner masks for compatible boundaries, the wall tiles' upper-layer repaint, and bridge plank tiles |
| Buildings | 64 px cells | Semantic roof tiles for the home, the inn, and the repair shed |
| Props | cell-sized treatments up to 3 by 2 cells | One tintable base per prop type, state overlays where the silhouette stays fixed, and bespoke stills only for silhouette-changing states |
| Scenery | 64 px cells | Three red pine variants and the market crate |
| Characters | 192 by 192 frames | Shared rotatable directly overhead masks for body, clothing, and details, with rest and walk frames, plus shadow and direction marks |
| Effects and dressing | 64 by 64 through 192 by 128 | Glow, flame, smoke, pump water, bell lines, and two white crane poses |

The separate 320 by 180 thumbnail is a final Hearthside Ink image, not a screenshot requirement or map claim. It shows night ink around a parchment fragment: a slack-water branch, low crossing, one home and garden, warm lantern light, and a cinnabar visitor.

### Collision truth and review

[ruleset.md](../ruleset.md) fixes impassable ground, catalog collision shapes, counts, states, transitions, and prop reach. Art and collision-overlay drawings must match it exactly. Water and walls read solid, doorway ground open, and round catalog shapes read round, so walkers visibly slide around the pump, hearth, bell, lantern, and pine. Non-solid shadows, glow, smoke, and other effects may extend outside a shape. Art needing another extent changes the ground table or catalog and its generator, fixture, overlay, and tests together.

Review the fixture and generated seeds at fitted, mid, and close fixed scales. Step 5.2 verifies the same result through interactive zoom. This step does not choose camera limits, pan behaviour, HUD typography, speech-bubble layout, use preview, or input controls. Retain step 3's collision toggle on watch, replay, and play.

## Tests

- Scene tests prove static terrain and building containers build once per static-layout key, dynamic nodes reconcile by id, and no tick rebuilds static tiles.
- Tile tests cover deterministic fill variants, derived edges at every boundary, frame edge, and corner, and planks on exactly bridge cells.
- Building tests cover ground painting from semantic rects, upper walls above occupants, and roof alpha from occupancy alone, including direct and replayed seeks.
- Prop tests cover each still, facing, exterior-footprint cap, and every catalog treatment: stall, bench, board, plot, repair bench, lantern, hearth, shrine, pump, and bell.
- Shape tests cover circular props and pine within catalog extents and box props filling theirs.
- Character tests cover exact heading rotation, walk-frame determinism, stable mask assembly, and hash-selected tint combinations.
- Seek and interpolation tests cover sustained animation, grade, walk frame, roof state, crane, endpoints, midpoints, cadence scaling, unpaced measured gaps, shortest heading turns, offscreen crane wrapping, and retained-pose equality after a per-frame motion pass.
- Phase tests cover one world-only grade, post-grade emissives, neutral non-daynight day, and ungraded collision overlay and HUD boundary.
- Asset tests cover the local manifest, dimensions, originals, runtime files, declared masks, and thumbnail.
- Collision tests prove overlay solids match wall ground, doorways stay passable, and prop and scenery sprites sit on their catalog shapes.
- Run the Three Branches browser e2e group while iterating. Before handoff, run the bare full browser e2e suite.

## Done when

The fixture and generated villages replay in approved Hearthside Ink with autotiled terrain, cutaway roofs, deterministic state treatments, phase grading, and a toggleable collision overlay that matches collision truth. Manifest assets and the thumbnail load in production, the Three Branches and full browser e2e suites pass, and this file retains the approved direction and presentation dates.
