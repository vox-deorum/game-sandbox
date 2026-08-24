# Step 5.3: Visual refinement and fitted-view hierarchy

Status: in progress. Unit 1 has removed the daytime authored grade from the live renderer. Tune the current graphics toward the approved Hearthside Ink direction: a village that reads clearly at fitted view and rewards close inspection without losing its calm, hand-made hierarchy.

Part of [the plan](../README.md). This stage uses the [5.0 atlas pipeline](5-0-atlas.md), the [5.1 visual direction](5-1-art-style.md), and the [5.2 HUD semantics and input design](5-2-hud-interaction-and-camera.md). It improves the live presentation, not technical parity for its own sake.

## Visual tuning contract

The world remains an exact 90 degree top-down projection. Do not redesign gameplay, collision, replay, input, the generator, layout, camera limits, or camera gestures. The collision overlay remains collision truth, never an art approximation. The presentation catalog owns each atlas group's mipmap flag. Do not add procedural LOD, a new rendering engine, or a second art pipeline.

Keep the night grade, centered texture outlines, and emissives. Unit 1 removes only the daytime authored grade. HUD and annotation layers remain ungraded, including nameplates, speech, and expression marks.

Work one owner-started unit at a time. Visual decisions belong to the owner. Tests and contract checks protect behaviour, but never substitute for visual judgment. Run selected, focused tests during each unit and the complete verification set only after the final Gate B.

## Required start for every unit

The first mandatory step is a rendered-state diagnosis, before generating art or editing runtime code.

1. Inspect the current unit against the approved references at fitted, middle, and close scales, plus night where relevant.
2. Present the owner with prioritized deviations, the visual effect of each deviation, and the proposed tuning focus. Use the [Hearthside Ink approval mockup](../art/hearthside-ink-approval.png) and [material board](../art/hearthside-ink-material-board.png). Cast work also uses the [approved top-down shooter direction](../art/top-down-shooter-direction.png).
3. Stop and wait for owner direction. Do not generate comparison art or change runtime code until the owner releases the unit.

After that direction, make only the smallest art or integration changes that close the agreed visual gaps. Start with one Git-visible, unstaged comparison batch, present it to the owner, and stop again until the owner selects or redirects the approach. Keep the current fallback and deterministic presentation behaviour unless a unit explicitly needs bounded support.

Use image generation as the primary correction loop for raster art. When generated geometry, projection, material colour, or alpha is wrong, regenerate the affected asset with a tighter prompt before reaching for pixel postprocessing. Accept small losses of decorative detail when regeneration produces a clearer silhouette, correct projection, and a more coherent material family. Keep any crop, resize, alpha-normalization, atlas assembly, or diagnostic scripts used along the way. Those scripts must remain reusable and easy to inspect, but they do not become a second art-authoring pipeline and must not cosmetically redraw generated assets.

## Concept-first raster prompting contract

Use this reference hierarchy for every raster comparison:

1. The approved Hearthside Ink scene controls world integration, palette family, value density, and fitted-view hierarchy.
2. A tight crop of the approved conceptual subject controls silhouette character, mark making, material restraint, and identity.
3. Material crops control physical surface behaviour, including timber wash, ink density, value separation, pooling, dry edges, and broken lines.
4. Existing runtime art is secondary continuity evidence only. It must not override the approved concept or material references and may be revised when it conflicts with them.

The stable Hearthside Ink language is physical hand-inked drawing with controlled hand tint on a smooth illustration surface. Use irregular translucent umber or charcoal ink with changing pressure, broken passages, overlaps, dry-brush taper, and occasional pooled seams. Establish form with two or three broad, clearly separated wash values before small marks. Washes retain visible brush decisions, selective dry edges, pooled joints, and quiet unmarked areas without relying on paper absorption, bloom, granulation, or fibrous surface noise. Timber remains restrained but has enough warm colour and local value separation to survive against similarly coloured terrain. Grain is sparse, uneven, nonparallel, and allowed to disappear. Reserve the darkest values for selected joints, undersides, and seams. Preserve exact gameplay registration and overhead projection while letting the visible silhouette retain hand-drawn irregularity.

Avoid clean vector contours, uniform digital fills, ruler-straight visible edges, sticker-black outlines, smooth airbrush gradients, PBR gloss, repeated procedural grain, evenly distributed texture, high-frequency scratches, and mobile-icon polish.

A controlled style comparison fixes every non-style variable. Each named variant changes one art-language hypothesis only, such as line-led, balanced, or wash-led. Construction and decoration change only in a construction study requested by the owner.

Proof images may use a flat neutral field so wash behaviour can be judged, but they do not use paper texture or tint the object through simulated absorption. The proof field is never runtime art. Promoted sources have clean alpha, cleared colour in fully transparent pixels, no baked ground or cast shadow, and opaque solid materials except for intentional antialiasing or approved glow. If regeneration still returns a baked field, remove it through the shared [asset-normalization module](../art/tools/AssetNormalization.psm1) and retain a small reusable recipe. Normalization may remove the known proof field, clean edge colour, fit the asset to its configured registration, or create an effect mask. It may not redraw or cosmetically restyle the asset.

Derive secondary states from the selected neutral or base construction. Preserve silhouette, projection, material family, runtime fit, and registration. Add only the state cue needed for gameplay readability. The cue may be proportionally bold when the prop is small, but it must not change the gameplay footprint.

Every comparison records a stable prompt ID, variant name, exact sent prompt, input images and their roles, proof or production status, and selection result. Retain the selected source provenance and reusable normalization or diagnostic scripts. Remove rejected raster outputs after selection.

## Owner approvals

Gate A is a concise asset-direction approval. Show the complete proposed asset treatment at its intended viewing role, including the details that must survive fitted, middle, and close views. The owner approves the visual direction before it becomes runtime art.

Gate B is a concise integrated-scene approval. Show the approved art in the fixture and generated villages at the relevant scales and phases. Confirm that the intended visual gap is closed and that the retained behavior boundary still holds. Record both approvals and a short acceptance note under the unit.

### Current compositing comparison

The exact top-down projection uses no directional prop contact shadows. Interactive props, the market crate, and composed bridge decks instead receive a centered falloff below their artwork. Props and crates use two copies of the current texture, sharing its state and visual rotation. Bridges use the same two opacity weights with their existing component mask geometry, including compact unions. One faint outer layer uses the full configured spread, while one stronger inner layer uses half that spread. This avoids zoom-dependent filtered render targets without introducing a general layering system or changing bridge route contacts and collision. The treatment has no world offset, footprint ellipse, cast direction, or dependency on the character-shadow frame. Pines receive no outline, and no outline or cast shadow is baked into raster art.

The provisional shared outline candidate uses backdrop tint, `0.12` total opacity, and `0.08` spread. The outer copy receives one third of the opacity, and the inner copy receives two thirds. These values are comparison candidates, not Gate B approval. Review the fixture and representative generated villages at fitted, middle, and close scales before accepting or revising them, including continuous zoom through those ranges. Review night separately for emissive balance. Do not add a daytime grade, change raster colour, or move gameplay, collision, or art registration during this pass.

## Ordered visual units

### 1. Tintable terrain repaint and no daytime authored grade

Desired result: terrain carries the Hearthside Ink material character and route hierarchy at fitted scale, with texture detail that rewards close inspection.

Keep the tintable terrain composition, deterministic patterning, routes, bridge ownership, and layer ownership. Bridge cells remain water in the contour pass, and their banks remain ordinary free shoreline beneath the shared deck cover. Remove the daytime authored grade only. Keep the night grade, texture outlines, emissives, and ungraded HUD and annotations.

The live renderer has no daytime authored grade. Terrain uses dedicated material colours, an even road base, and worn-stone path art. The current path treatment awaits owner visual approval, and terrain Gate B remains open.

The owner selected the full-colour bridge atlas direction, with ink joints and visible ends plus portal and side overlap. The selected production-2 source and its exact prompt and normalization recipe are retained in `../art/bridge-texture-production-2/`. Production-1 remains archival provenance only. Gate A records this selection. Generated art supplies the bridge material and construction. Runtime supplies component layout, direct colour composition, ink joints, visual portal and side overlap, and shared visual geometry. Gate B remains pending visual integration in the fixture and generated villages.

The bridge pass keeps the terrain and dedicated bridge source atlases unmipmapped. Runtime rendering builds one mipmapped canvas for each connected bridge component from the shared visual deck geometry and existing component mask. Axis decks visibly extend 0.50 cells into each route landing. Their canvases keep 0.20 cell of hidden transparent source padding beyond that visible extension, and board material stops at the visible landing so the rectangular component mask does not slice through opaque boards. Deterministic terminal source selection and mirroring expose authored irregular alpha at horizontal left and right edges or vertical top and bottom edges. The route cutout remains 0.30 cells, leaving 0.20 cell of road beneath the visible landing. Internal seams and restrained cross-edge shadows provide depth without changing route contacts. Compact components and gameplay, collision, water, ownership, and layer semantics remain unchanged.

Focused automated checks cover source extraction and registration, deterministic component composition, direct colour and ink-joint ordering, prepared portal overlap, inset shared masks, cross-edge shadows, and mipmapped component output. Gate B then uses owner visual review of the pinned fixture and representative generated villages at fitted, middle, close, and night views. The relevant bridge source and component renderer tests run before the full stage verification set.

### 2. High-resolution pines

Desired result: pines create readable village massing at fitted view, while base, canopy, and line work hold up nearby.

Keep static placement, collision, and stable variant selection. Draw each pine as one complete sprite after roofs so trees occlude characters and nearby architecture. Mask trees out of an entered building's semantic footprint so its cutaway interior remains clear.

The accepted pine family and market crate occupy the current scenery set. Pines use the retained post-roof layer and the same semantic building occupancy as roof fading. Gate B remains open for owner visual approval.

The shared market crate is a closed square magic-punk supply coffer with indigo iron straps, rounded corner caps, a bone ceramic side conductor, and a sparse asymmetric brass latch. It uses the same medium warm timber family as the lantern and stalls without copying their construction. Placement and collision keep the configured catalog footprint.

Generate the market crate with the approved lantern and closed stall as direct colour references. Keep its timber close to their warm medium-brown tone, its iron close to their charcoal-indigo, and its ceramic and brass accents equally restrained. Preserve its closed square coffer role, exact overhead projection, and configured gameplay footprint.

### 3. Ordinary props on a shared atlas

Desired result: ordinary props clearly express their states, and the lantern becomes a warm overhead beacon landmark that reads at night without crowding the day scene.

Keep prop state meanings and interaction and collision footprints. Keep the lantern in the shared props atlas while treating it as an ordinary centered prop. Its art, texture outline, selection, runtime flicker, and emissive light share the collision center. Treat the pump, which is the gameplay well, and the bell as ordinary centered props as well.

The lantern, pump, and bell use compact, prior-equivalent centered base sprites in the ordinary props atlas. The pump uses one regular well base for both idle and flowing states, with a separate water ripple effect shown only while flowing, using the same presentation pattern as the tended shrine cloud. The ripple fits inside the water opening, and its subpixel motion follows a slow circular ellipse with minimal scale travel. The bell base and striker share the ordinary prop atlas. The striker is registered to a presentation-owned hinge: it remains stationary while silent and makes a slow, restrained, seek-safe swing while ringing, alongside its separate sound-line effect. The notice board, lantern, shrine, pump, and bell remain fixed north. The shared props atlas uses the configured sampling treatment, and every prop retains its placement, collision, selection, texture-outline, and highlight contracts.

The current lantern is a compact octagonal beacon in exact overhead projection. Lit and unlit states share construction and centered registration; the lit state adds its approved core, baked light, runtime flicker, and glow. Its runtime glow is corrected for the authored mask's low visual centroid and uses two overlapping adjacent frames with a smooth opacity crossfade, so the effect stays centered and continuous instead of stepping between frames.

The lantern's solid materials use opaque interior alpha with cleared colour in fully transparent pixels. The lit state retains soft alpha only for the intentional baked halo and exterior antialiasing. This prevents terrain colour and texture filtering from breaking through its solid silhouette while preserving the approved geometry and glow.

The prop language is old magical infrastructure kept alive by rough, competent village repairs. Hearthside timber provides the main mass. Dark indigo iron casings, pale bone ceramic insulation, sparse gilt at powered points, and one visible conductor path explain the inherited magic. Cracked-core clamps, staples over broken traces, and mismatched brackets provide restrained repair history. Avoid gears, boilers, pipes, neon, screens, ornamental rune fields, and crystal clusters. Use broad value groups and low-frequency grain so each construction remains readable at its runtime size. Colour prompts use approved runtime assets as direct authorities. When a target lies between two rejected passes, name the brighter pass as the upper bound, the darker pass as the lower bound, and one approved asset as the target centre. Preserve contrast through material separation rather than raising the timber brightness or applying a programmatic grade.

Any prop that rotates with recorded facing must use a 100 percent top-down view: the camera is directly above at exactly 90 degrees with orthographic projection. The image plane is parallel to the ground, opposite edges remain parallel, and every structural element shows only its top face. Prompts explicitly forbid visible front or side faces, wall thickness, raised rims, bevels, perspective, foreshortening, directional facades, cast shadows, and ambient-occlusion shadows beneath a boundary. Generate a fresh image when projection or material color changes. Do not repair those properties through raster warping, recoloring, contrast adjustment, or other programmatic image edits.

The approved stall family has three constructions with matching open and closed states. A stable prop-id choice preserves construction across state, facing, reconciliation, and art reinstall. State changes only the matching open or closed frame. All constructions share the same warm timber family, ordinary lower-layer role, and existing facing correction.

The approved concept and material board define the art language for all interactive props and the market crate. The selected lantern supplies secondary continuity only when it agrees with those primary references. Regenerate full-colour art rather than tinting it at runtime, and use no wood mask, shader, numeric colour tolerance, or colour snapshot test. Continue one family at a time in this order: bench, shrine, board, plot, hearth, repair bench, pump, then bell. Present a controlled neutral-state comparison before deriving the remaining states. Gameplay footprint, state meaning, registration, and projection remain fixed. Grain, wear, and value balance may vary, but the props stay within one timber family.

The current bench uses balanced field ink, clear warm cedar, controlled hand tint, and no paper haze. Every construction keeps a free-form indigo-violet textile; empty and occupied states share construction and registration, while one compact personal textile supplies the occupied cue.

The bench and storage-crate direction is retained in `../art/ordinary-props-production-1/`. The owner approved Fabric Bench A, B, and C as the stable empty-bench variety set. Each keeps its permanent free-form indigo textile, while its matching occupied state adds one compact personal textile without changing construction, visible bounds, centered registration, projection, or gameplay footprint. The owner selected Crate C for production. Its canonical source preserves the existing 512-square centered scenery contract and restrained wood-led material balance. The repair bench keeps its approved construction and state cues. Its idle state receives the owner-approved bounded RGB correction from the busy state while preserving every alpha value, visible bound, tool, and registration coordinate.

The current shrine is a decorated riven conduit arch in warm gray-ochre stone, with indigo-violet cloth, an ochre beaded cord, brass votive discs, a bone aperture, and an indigo iron brace. The tended state adds fruit, a green sprig, incense, aperture light, and warm conductor light. Both states keep the centered lower-layer role, fixed-north presentation, and existing gameplay contract.

The current notice board combines decisive dry-brush structural ink with clear warm cedar. Its pictorial notices cover a river route, market fruit, an herb sprig, a lantern, and a repair task without readable writing. Indigo iron clips, a bone ceramic insulator, and one brass conductor path carry the shared magic-punk language. It keeps its ordinary centered treatment, fixed-north presentation, shared props page, and existing gameplay contract.

The production garden is a flat, exact-overhead, ground-inlaid prop with no vertical faces, rim thickness, shadows, perspective, or directional facade. Its balanced medium cedar uses the bench for the target warm midtone and restrained highlight, and the notice board for dark seams, end-grain, structural ink, and weathering. Contrast comes from dark soil, distinct plant greens, charcoal-indigo plates, pale bone ceramic, restrained brass, and violet and ochre flowers rather than bright wood. Overgrown and tended states share the ordinary centered treatment, rotate with recorded facing, and preserve their names, footprint, collision, selection, and interaction behavior.

The tended shrine's drifting violet cloud is a separate grayscale-alpha effect and is made more salient by its configured presentation pulse. The base still contains no drifting wisps or detached motes. The reusable configured opacity animation is seek-safe and uses fractional presentation tick plus the stable prop phase. Only opacity animates, with no gameplay state, collision rule, mutable effect clock, or shrine emissive. The flowing pump uses the same separate-effect pattern for its water ripple, while its regular well base remains unchanged. Its one-frame ripple moves slowly in a subpixel circular ellipse, rather than shaking vertically.

The lantern, well, and bell use an exact 90 degree overhead projection, including bases that read entirely from above. All three keep their one-cell gameplay footprint, state meanings, and shared timber, indigo iron, bone ceramic, and sparse gilt material tones. Each uses the ordinary centered prop contract. The well's ripple and the bell's sound lines are separate presentation effects, not alternate solid bases or gameplay layers.

The compact octagonal lantern conveys height through concentric top surfaces. The well reads as a compact circular stone structure with a distinct ripple layer when flowing. The bell's compact circular body and single striker read only from above. Lit and unlit lantern states share construction, idle and flowing well states share the regular base, and silent and ringing bell states share the same base while the striker moves around its top hinge. State names and gameplay contracts remain unchanged.

Formal Gate A waits for one sheet containing every revised prop state and the crate. After approval, update source art, `presentation.json`, compiled pages, and focused tests. Revise 5.0 only when the compiler or catalog contract changes, and revise 5.1 only when the visual direction changes. Gate B checks the pinned fixture and representative generated villages for fitted hierarchy, material unity, state readability, night behavior, centered-prop placement, and crate collision.

### 4. Full-roof building sprites

Desired result: roof materials establish a readable building hierarchy from fitted view and reward close inspection without obscuring residents.

Keep semantic building extents, collision, and the existing occupancy fade and replay-seek behavior. Each building uses one centered full-roof sprite that rotates with facing. Retain the roof container, occupancy targets, reversible fade, and snap behavior on mount, seek, repeated frames, resize, and reinstall.

Current roof sources use the approved wash-led family with clean alpha and configured mipmaps. Gate B remains pending until integrated manual review.

### 5. Four registered cast sets

Desired result: the visitor and villagers are distinct, legible people at close and middle scale, with clear far marks at fitted view.

The owner selected the indigo conical traveler hat for the visitor. The villager appearance pool uses the soft round felt cap, quilted work cap, and pleated linen bonnet. Selection remains deterministic by player identity.

Each cast set uses static body and clothing art plus one canonical left and right arm. Walking animates those arms through seek-safe scripted shoulder rotation driven by displayed walk distance. Do not create raster pose sets or embodied expression poses. Keep recorded heading, walk cadence, shadows, far marks, nameplates, and merged expression pictograms.

The owner approved the visitor Gate A parts proof in `../art/visitor-rig-comparison-1/`, followed by the felt-cap, quilted-cap, and linen-bonnet villager choices in `../art/villager-comparison-1/`. Production sources, registration data, normalization, prompts, and the assembled cast preview live in `../art/character-rig-production-1/`.

The live renderer uses one full-colour 576 by 768 character atlas. Its four rows are the visitor and three villager sets, and its three columns are the base, left arm, and right arm. The visitor is fixed to `player_0`; villagers select one of the three approved hats through a stable player-id hash. Runtime assembly turns the authored cast 180 degrees before applying recorded heading. One hand travels forward while the other travels back, supported by a small shared shoulder turn, restrained body sway, and an interpolated start and stop envelope. Every transform remains a seek-safe function of displayed walk distance and frame interpolation. The superseded tintable raster pose pages are removed. Gate B remains open for owner review of the integrated scale, movement, projection, and identity read.

### 6. Effect and expression completion

Desired result: village landmarks feel memorable, while effects make activity, light, and expression readable without visual noise.

Complete the remaining effect set and expression marks. The owner approved the compact Hearthside Ink symbol direction: a small white-mask pictogram with no text, background, border, or glow. The world annotation merges the player name and active expression in one dark pill. The centered name segment remains stationary over the character, while a left icon compartment appears only for an active expression. A restrained gilt divider separates the compartment. The compartment carries the selected emote or the target-specific use pictogram, including an eye for reading the board. Speech bubbles remain directly above the pill.

The world-label font, spacing, icon lane, and icon scale come from `presentation.expressions.worldLabel`. The input palette's plate geometry, label font, and icon scale come from `presentation.expressions.inputPalette`, so small-screen readability can be tuned without changing renderer code.

The effects page grows to a 12 by 4 grid at 2304 by 512 pixels. It retains 192 by 128 cells and declares ten emote or generic-use frames plus one exact activity-frame map for tending stall, lighting, sitting, tending shrine, reading board, tending plot, tending hearth, working bench, working pump, and ringing bell. Each expression source uses `fitVisible` into a centered 128 by 96 pixel maximum area, preserving simple silhouettes at small resolution. The generic `use` mark remains the fallback when no valid target exists.

Keep fixed prop orientation, collision, effect timing, retained icon hold and fade semantics, nameplate zoom gating, and layer order. Texture outlines remain below props, and emissives retain their night behavior.

### 7. District representation at fitted view

Desired result: the fitted view reads as an intentional district map, then resolves smoothly into the detailed village as the viewer approaches.

Use authored district representations, not procedural LOD or mipmaps. Keep terrain and routes visible, preserve character far marks, emissives, annotations, HUD, and collision overlay, and derive the district view from the existing static layout. Crossfade through the configured transition without changing generation, camera, input, collision, replay, or gameplay.

### 8. Hearthside HUD atlas and retained interaction chrome

Desired result: Hearthside Ink chrome supports the detailed and district views while controls, annotations, and player intent remain immediately legible.

Keep every approved 5.2 semantic, including watch and replay chrome, collision access, recenter and follow behavior, visitor controls, expression palette, chat, accessibility, and input state. HUD and annotations stay ungraded, and art loading must not reset retained controls or their state.

## Visual review and validation

At Gate B, compare the pinned fixture first, then generated villages to expose density and placement issues. Review day before night, and review fitted before middle and close. Inspect relevant loading, replay seek, resize, and live transitions when the unit touches them.

During each unit, run focused renderer and frontend checks for the changed contract. Update [5.0](5-0-atlas.md) only when the compiler or catalog contract changes, and update [5.1](5-1-art-style.md) only when the visual direction changes. Tests protect behavior, not subjective appearance. Do not stage changes.

The documented `three-branches` Playwright group is not present in the current `frontend/e2e/` tree. Use manual fixture captures and focused renderer tests during this provisional comparison. Keep the group command as the intended focused Gate B check once that journey exists, and run the complete browser suite at the final gate.

After the final Gate B, run:

```powershell
npm run atlas --workspace @game-sandbox/frontend -- check three_branches
uv run python scripts/ci.py check
uv run python scripts/ci.py test
uv run python scripts/ci.py frontend-e2e --group three-branches --fast
uv run python scripts/ci.py frontend-e2e
```

## Done when

All eight units have a recorded diagnosis, owner direction, first-comparison decision, Gate A asset-direction approval, and Gate B integrated-scene approval. The approved fixture and generated villages read clearly at fitted scale, reward close exploration, retain their protected behavior, and pass the focused checks and complete browser suite.
