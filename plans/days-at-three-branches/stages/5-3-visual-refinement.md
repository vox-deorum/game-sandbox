# Step 5.3: Visual refinement and fitted-view hierarchy

Status: planned. This is owner-gated work. No unit begins its runtime integration before its Gate A asset-sheet approval, and no unit is complete before its Gate B integrated approval.

Part of [the plan](../README.md). This stage follows [step 5.1](5-1-art-style.md) and [step 5.2](5-2-hud-interaction-and-camera.md), and uses [step 5.0](5-0-atlas.md) for every raster asset. It refines the finished Hearthside Ink presentation without changing the village generator, camera behaviour, simulation, collision, or visitor-input rules.

## Scope and boundaries

The goal is a clear hierarchy at the fitted village view and a rewarding close inspection view. Art should make the village easy to read before it asks the viewer to notice small marks. The world remains an exact 90 degree top-down view, with the existing retained scene lifecycle, replay determinism, collision overlay, roof occupancy fade, phase cadence, and player ids.

This stage covers:

- direct-colour terrain, finished scenery, ordinary props, the dedicated lantern, roof tiles, cast art, monument and effect art, HUD art, and a fitted-view district representation;
- the atlas declarations, source art, loose frames, runtime pages, presentation calibration, renderer installation, and tests needed by those assets;
- owner review of each source sheet and integrated scene at fitted, middle, and close scales, including night where the unit is visible at night.

It does not cover:

- a new village layout, generation rule, static-layout key, camera limit, camera gesture, zoom limit, replay format, action, collision shape, prop transition, or gameplay rule;
- a replacement for the approved 5.2 HUD semantics, speech delivery, expression behaviour, visitor controls, or accessibility behaviour;
- mipmaps, automatic texture generation, a new rendering engine, procedural LOD, or a second art pipeline;
- subjective pixel directions. Gate A reviews the finished sheet as a coherent practical asset, while the implementer retains normal craft decisions inside the approved purpose and contract.

Keep the existing night grade, prop contact shadows, and emissives. Unit 1 removes the daytime authored grade only. The ungraded HUD and annotation layers stay outside world grades. The existing collision overlay remains collision truth, not an art approximation.

## Shared approval and artifact rules

Every unit uses the same two gates. The owner is the sole approver of visual quality. Automated tests protect contracts and do not substitute for either gate.

### Gate A: asset sheet

Prepare each candidate sheet under the ignored path `build/three-branches-art-review/<unit>/`. Include the full sheet at its intended runtime dimensions, its named-cell guide, and practical crops that make transparent bounds, anchors, and overlap legible. For a higher-resolution source, include both the editable master and the exact mechanically downsampled runtime sheet. The owner approves the runtime pixels as well as the source quality. Show tintable pages on their intended tints and full-colour pages against the intended world ground. Do not merge candidate art into committed runtime assets.

The owner approves the sheet's role coverage, readability, composition, transparent bounds, and the parts that must survive the intended fitted, middle, and close views. Gate A can ask for another candidate. It cannot silently change a behavioural or geometric contract: raise that as a plan or specification question.

An accepted Gate A runtime sheet supplies the exact pixels exported to runtime. Complete any downsampling before Gate A. Do not repaint, scale, filter, crop, or reconstruct an accepted runtime sheet between approval and the committed loose frames or atlas page. Slice those pixels into the 5.0 loose-frame layout, use the same pixels for the compiled atlas, and preserve the approved high-resolution master in `assets/source-art/` with its source-art metadata. The approved runtime page can be the accepted sheet where its grid is already the runtime grid.

Commit the accepted sheet or approved source, source-art metadata, every loose frame, the compiled atlas page, the manifest update, and the approval date recorded in this stage in one change. Run `npm run atlas --workspace @game-sandbox/frontend -- check three_branches` before Gate B. The ignored review directory is not a source of truth and is never committed.

### Gate B: integrated scene

Install only the Gate A-approved files and exercise their renderer consumer in the pinned fixture and generated seeds 0, 17, and 37. Review the normal day phases, then review night for scenery, props, monuments, effects, and any light-adjacent art. Show fitted, middle, and close views. Turn on the collision overlay for objects with collision registrations. Exercise occupied and unoccupied roofs, prop states and effects, character rest, movement, turning, visitor identification, speech, expression chips, and the final LOD thresholds as applicable.

Gate B accepts the integrated visual result and the unchanged contracts around it. When integration changes code, the owner approves that implementation at Gate B. When an accepted repaint needs no code or configuration change, record `no code change required` and approve the in-engine result. Record the approval date in the unit below. A rejected integration returns to the candidate-sheet path or to a scoped renderer correction, then repeats the relevant gate. Do not carry an unapproved visual unit into a later unit.

### Review matrix

| Unit | Gate A sheet review | Gate B integrated review | Required mechanical evidence |
| --- | --- | --- | --- |
| 1. Terrain | Ground, water, road, path, wall, bridge, and seam cells on real direct colour | Fixture and generated villages across terrain classes and day phases | Atlas freshness, direct-colour loading, deterministic terrain ownership |
| 2. Scenery | Six pine base and canopy pairs plus crate | Occlusion after characters, collision overlay, fitted massing | Frame completeness, canopy order, stable placement |
| 3. Props and lantern | Ordinary prop states and both lantern cells with anchor guide | Every prop state, lantern light and shadow, unchanged 1 by 1 collision | Catalog mapping, anchor and effect placement, state reconciliation |
| 4. Roofs | Home, inn, and shed 128 px roof roles | Roof fade while a character enters and leaves each building | Tile plan, retained install, fade and seek semantics |
| 5. Characters | Visitor and three villager layered four-pose sets | Rest, movement, turning, far mark, nameplate, and expression chip | Pose selection, layer assembly, deterministic style selection |
| 6. Monuments and effects | Five monument cells and all 40 effects cells | Pump, bell, lantern, hearth, shrine, crane, and expression states at night | Frame mappings, anchors, effect cadence, grade lifecycle |
| 7. District LOD | Nine block and glyph cells | Fitted, transition, and detailed zooms across fixture and generated villages | Fitted-zoom factors, crossfade, static lifecycle, no camera or gameplay drift |
| 8. HUD | Twelve HUD cells, including one transparent trailing cell | Watch, replay, and visitor-play chrome under all control states | Existing semantics, focus behaviour, unit and browser coverage |

## Gate B implementation contracts

At each landed unit, update the code and evidence that consume its art together:

- `environments/three_branches/renderer/assets.ts` owns the catalog entry, exact frame names, dimensions, frame paths, `ATLAS_PAGES`, runtime page loader, and runtime-page count.
- `environments/three_branches/renderer/assets/`, its loose frame folders, and `assets/source-art/` hold the committed compiled pixels, editable loose truth, and provenance. The 5.0 packer and freshness test define their equality.
- `environments/three_branches/renderer/assets/presentation.json` and `core/presentation.ts` own validated colour, frame, scale, anchor, and threshold calibration. `generation.json` remains generation-only.
- The renderer consumer stays local to its responsibility: `terrain/`, `props/props-art.ts` and `props/props-layer.ts`, `buildings/buildings.ts`, `characters/`, `effects/`, `ui/chrome.ts`, `ui/annotations.ts`, `ui/visitor-input.ts`, `map/world-stack.ts`, and `index.ts`. Add a dedicated LOD module only if the existing map modules cannot keep the static and dynamic responsibilities clear.
- Update `assets.test.ts`, `atlas.test.ts`, the relevant renderer unit tests, `core/presentation.test.ts` when configuration changes, and the Three Branches browser journey. Keep tests structural and deterministic. Visual preference is recorded at the owner gate, not frozen in screenshot goldens.

Each accepted unit amends the factual inventory in [step 5.0](5-0-atlas.md) in the same change. Do not revise 5.0 prospectively. Before a unit lands, this file is its design record. After it lands, 5.0 describes the committed page count, names, dimensions, source-art facts, and runtime loading set.

## Ordered units

### 1. Direct-colour terrain and no daytime authored grade

Repaint the existing 8 by 8 terrain page as direct-colour 128 px cells on a 1024 by 1024 page. Preserve the declared terrain frame names and the terrain consumer's cell-to-world mapping. The page is no longer a grayscale-alpha tint mask. `terrain-art.ts` should use the authored direct-colour frames without a per-material tint bake. Keep the contour, seam, route, reed, bridge, upper-wall, and map-ownership contracts from 5.1 intact.

Remove `postEffects.authoredGrade` from the presentation contract and from the daytime world stack. Daylight colour comes from the accepted terrain and the other approved direct-colour or tintable assets. Retain `postEffects.nightGrade` and its existing phase lifecycle. Retain contact shadows and emissives. The terrain is world art, so it remains inside the night grade; HUD, nameplates, speech, and expression annotations do not.

Gate A reviews all terrain roles together, including intentional seams and transparent or edge cells. Gate B checks that the direct-colour page loads, fallback behaviour remains useful while loading fails or is pending, and the fixture plus generated seeds keep their same geometry and deterministic terrain plan. Test that the removed daytime grade cannot be selected, that night still selects the night grade, and that direct-colour terrain does not enter the tint-cache path. Update the terrain entry and tintability facts in 5.0 only with this landed unit.

Approval record: Gate A pending. Gate B pending. Expected integration work: direct-colour loading and removal of the daytime authored grade.

Common failures: leaving a daytime filter active after colouring the page, tinting a direct-colour frame a second time, moving route or contour geometry while pursuing a visual seam, and allowing a failed atlas installation to discard the existing fallback.

### 2. Split pines and market crate

Replace the scenery page with a tintable 4 by 4 `scenery-atlas.png`, 1024 by 1024 pixels, with 256 by 256 runtime cells. Author every pine base and canopy as a 512 by 512 master, then review its exact 256 by 256 runtime export at Gate A. The named set is twelve pine frames, `pineABase` through `pineFBase` and `pineACanopy` through `pineFCanopy`, plus `marketCrate`. The three trailing cells remain transparent. The six pines keep the familiar catalogue identity while the base and canopy are separate renderable pieces. The crate is one 256 px runtime cell and may retain a native-size source if its repaint does not benefit from a larger master.

The pines remain tintable grayscale-alpha masks. Use the approved tint palette through the existing presentation contract, without embedding a separate per-pine colour palette in code. Draw the base in its ground-object position. Draw its canopy after characters so a character moving under a tree is appropriately occluded. The crate remains a normal scenery item. Preserve collision registrations, static placement, stable hash selection, and the existing scenery-scale contract unless Gate B records an approved calibration value.

Gate A must make the base-to-canopy pairing and alpha apertures clear. Gate B reviews dense and sparse stands, a character crossing beneath every canopy, crate placement, fitted readability, and the collision overlay. Add tests for all 13 named frames, transparent trailing cells, stable pine selection, and canopy-after-character order. Land the 4 by 4, 1024 by 1024, 13-frame scenery facts in 5.0 with the source, loose frames, compiled page, and runtime manifest change.

Approval record: Gate A pending. Gate B pending. Expected integration work: expanded atlas names, deterministic six-variant selection, and the front-canopy layer after characters.

Common failures: treating canopy as a world-shadow layer, drawing it before characters, using a dynamic tick to choose a pine variant, or letting the larger 256 px art change a scenery collision footprint.

### 3. Ordinary props and a dedicated lantern page

Restyle every ordinary prop state in the existing props atlas. Keep the ordinary catalog mapping and the full prop state surface: each catalog state still resolves through `SHIPPED_PROP_TYPES`, its declared state, and the renderer's retained reconciliation. Do not move pump or bell into this page. They remain monument art.

After extracting the lantern, the existing 6 by 6, 2304 by 1536 ordinary-props page keeps thirteen 384 by 256 frames in this exact order: `stallOpen`, `stallClosed`, `benchOccupied`, `benchEmpty`, `shrineTended`, `shrineUntended`, `boardNone`, `plotTended`, `plotOvergrown`, `hearthLit`, `hearthUnlit`, `repairBenchBusy`, and `repairBenchIdle`. Cells 13 through 35 are the unnamed transparent suffix. Update `PROPS_ATLAS_FRAME_NAMES`, its frame paths, and the 5.0 inventory with the extraction.

Move lantern art out of the ordinary props page into a dedicated full-colour `lantern-atlas.png`. Its 2048 by 1536 source page has two 1024 by 1536 masters. Mechanically downsample it to a 2 by 1 runtime page at 1024 by 768 pixels with two 512 by 768 frames: `lanternLit` and `lanternUnlit`. The lantern uses `textureDensityDivisor: 4`, `sourceAnchor: (256, 640)`, and `effectAnchor: (256, 144)`. Those anchors are runtime source-pixel coordinates in the 512 by 768 cell. The renderer places the visual source anchor at the same world registration used today, then derives the effect position from the same transform. The visual occupies a 1 by 2 northward silhouette, while its collision and interaction footprint remain exactly the existing 1 by 1 cell.

Add the lantern page to `assets.ts`, its direct runtime loader, atlas freshness coverage, and the props art installation path. The runtime page count grows from 10 to 11 when this unit lands. Put the lantern's density divisor and both source-pixel anchors in the validated presentation contract. Keep its existing emissive and six-frame glow treatment. The retained contact shadow remains below the lantern visual and uses the established contact-shadow treatment.

Gate A supplies an anchor guide, ordinary state coverage, and both lantern states. Gate B tests every ordinary prop state, lit and unlit lanterns, effect cadence, contact shadows, the 1 by 1 collision overlay, and visitor use transitions. Tests cover catalog-to-frame mapping, lantern page dimensions, anchors, density divisor, effect placement, unchanged collision, light-state reconciliation, and fallback preservation. Update 5.0 when accepted with the added lantern page and its runtime-count fact.

Approval record: Gate A pending. Gate B pending. Expected integration work: a dedicated page, source-anchor registration, and effect placement without a catalog or collision change.

Common failures: leaving lantern cells declared in the props atlas, anchoring a 512 by 768 image by its transparent page bounds, applying the divisor twice, using visual bounds as collision, or placing the glow after a canopy or HUD layer.

### 4. 128 px roof tiles

Replace the building page with a full-colour 4 by 4 `buildings-atlas.png`, 512 by 512 pixels, with sixteen 128 by 128 runtime frames downsampled from 256 by 256 masters. Retain the complete named roof-role set: `homeFill`, `homeEdge`, `homeCorner`, `homeRidge`, `innFill`, `innEdge`, `innCorner`, `innRidge`, `shedFill`, `shedEdge`, `shedCorner`, `shedRidge`, `homeFillAlt`, `innFillAlt`, `shedFillAlt`, and `eaveShadow`. The existing `presentation.roofs.frames` role keys remain the authority for all building types.

`buildings.ts` continues to build each retained roof container once from semantic building extents. It uses the accepted 128 px roles without changing building rectangles, collision, occupancy interpretation, fade duration, clear alpha, seek snapping, or fallback rectangles. The roof continues to sit in the existing authored composite above characters, with the established occupancy fade enabling interior inspection.

Gate A checks the role grid and repeatable fill alternatives. Gate B checks the home, inn, and shed with a character entering, standing inside, leaving, replay seeking, and installing art after a pending fallback. Tests assert the 4 by 4, 512 px page and 128 px frame dimensions, complete role mapping, tile-plan selection, retained-layer identity, fade targets, easing, and snap. Record the new building-page facts in 5.0 at landing.

Approval record: Gate A pending. Gate B pending. Expected integration work: updated atlas dimensions and manifest-derived frame scale, with roof behaviour unchanged.

Common failures: treating `eaveShadow` as a required visible tile before a consumer needs it, re-creating roof containers on every tick, using a visual roof edge to alter a semantic building boundary, or letting an atlas replacement replay a fade during a seek.

### 5. Four layered cast sets

Replace the shared generic character masks with one visitor set and three villager sets. Body, clothing, and arms each become tintable 4 by 4 pages, 768 by 768 pixels, with sixteen 192 by 192 frames. Each identity supplies the four existing poses in order: `rest`, `leftForward`, `pass`, and `rightForward`. Name the sixteen slots by identity and pose in the manifest so the selected visitor or villager layer is unambiguous. The details page remains its existing four 192 px frames and continues to provide the separate detail treatment.

`player_0` always selects the visitor set and keeps its cinnabar identity. The three villager sets select deterministically from player id, independent of roster arrival order, replay history, or tick. Walking remains the current four-pose cadence, movement interpolation remains separate, and the full assembled character retains recorded heading. Preserve the close-view assembly, fitted far mark, nameplate threshold, expression-chip threshold, shadow, and direction mark contracts.

The optional embodied-arm study from 5.2 is retired. Do not add arm-expression frames, an arm override matrix, or a trial acceptance branch. The approved chip-and-text expression treatment remains the only expression indication above the character.

Gate A reviews all four identities in each layer and pose, including the visitor's cinnabar distinction. Gate B checks rest, movement, turning, expressions, speech, nameplates, fitted far marks, and replay seeks for visitor and all villager variants. Tests cover the 4 by 4, 768 px, sixteen-frame pages, exact identity-and-pose lookup, deterministic villager assignment, visitor cinnabar selection, unchanged walk timing, retained-node lifecycle, and absence of arm-study paths. Update 5.0's three character-layer facts at acceptance. The details page remains four frames.

Approval record: Gate A pending. Gate B pending. Expected integration work: identity-and-pose frame selection for the three layered cast pages.

Common failures: multiplying the visitor tint on already-specific art, choosing villager art from transient array position, making walk animation depend on browser frame time, replacing the character node while swapping art, or restoring the retired optional arm study.

### 6. Monument and effect completion

Finish the five named full-colour monument frames on the existing 3 by 2 `monuments-atlas.png`, 2304 by 1024 pixels, with 768 by 512 cells: `pumpFlowing`, `pumpIdle`, `bellRinging`, `bellSilent`, and `bellFoundation`. The sixth cell stays transparent. Preserve the documented pump and bell source-pixel anchors, texture-density divisors, fixed-north orientation, and separate bell foundation. Do not change monument collision registration to fit new pixels.

Finish all forty tintable grayscale-alpha effect frames on the 10 by 4 `effects-atlas.png`, 1920 by 512 pixels, with 192 by 128 cells. This includes the character shadow and direction mark, glow and flame loops, smoke, water, six bell-line frames, cranes, the ten expression pictograms, and both expression accents. The exact names already declared by `EFFECTS_ATLAS_FRAME_NAMES` remain the contract. Effects keep their existing phase and fractional-tick timing rules.

Gate A reviews the five monument cells and all forty effect cells as complete sheets. Gate B exercises pump, bell, lantern, hearth, shrine, crane, character, and every expression state. Review the result under the retained night grade. Contact shadows stay below their props and emissives retain their existing layer and phase behaviour. Tests cover named frame completeness, monument anchors and role mappings, all effect consumers, animation frame selection, phase determinism, and the retained night-grade lifecycle. Amend only the 5.0 facts that actually change with the accepted source or page material.

Approval record: Gate A pending. Gate B pending. Expected integration work: no code change required when accepted repaints preserve all current names, dimensions, anchors, and mappings.

Common failures: changing a monument anchor while trimming alpha, treating a bell effect as part of the fixed monument image, forgetting one expression frame because its text fallback remains readable, grading a HUD or annotation effect, or removing the night grade with the daytime authored grade.

### 7. District LOD at fitted view

Add a tintable grayscale-alpha 3 by 3 `district-lod-atlas.png`, 768 by 768 pixels, with nine 256 by 256 runtime frames downsampled from 512 by 512 masters: `homeBlock`, `innBlock`, `shedBlock`, `pumpGlyph`, `bellGlyph`, `marketGlyph`, `pineMassA`, `pineMassB`, and `pineMassC`. Add it to the runtime loader, raising the runtime page count from 11 to 12 when this unit lands. The page contains authored district representations, not generated mip levels, and uses named presentation colours rather than hard-coded per-sprite tints.

Express both thresholds as factors of the camera's current fitted zoom, which is `cameraLimits.minZoom` and changes with viewport and map span. Add `districtLod.farZoomFactor: 1.25` and `districtLod.fullZoomFactor: 1.5` to the validated presentation contract. At or below 1.25 times fitted zoom, show the district representation in place of detailed scenery, contact shadows, ordinary props, monument foundations and uppers, roof and upper structures, and non-emissive world effects. The `pumpGlyph` and `bellGlyph` replace both visual parts of their detailed monuments, so no foundation remains beneath a district glyph. At or above 1.5 times fitted zoom, show the detailed scene. Between those factors, crossfade the two retained representations from the current camera zoom divided by fitted zoom. The relationship is continuous, deterministic, and seek-independent.

Natural terrain and routes remain visible under the district representation. Existing character far marks, emissives, prop highlights, ungraded annotations, HUD, and collision overlay retain their responsibilities. District building blocks and landmark glyphs live with the graded world. District pine masses draw after character far marks so the fitted view keeps the same under-canopy occlusion cue as the detailed view. The collision overlay continues to show exact collision truth rather than invented district shapes. Do not add mipmaps.

The district plan is derived once from the existing static village drawables and static-layout key. It does not modify generator output, world ownership, character placement, collision, camera limits, camera gestures, input, or gameplay. Keep both static representations retained during the crossfade and avoid zoom-time or tick-time scene reconstruction.

Gate A checks the nine cells as a hierarchy at fitted scale. Gate B checks the pinned fixture and seeds 0, 17, and 37 at 1.25 times fitted zoom, several values in the transition band, and 1.5 times fitted zoom, with a moving character, collision overlay, roof state, and night. Tests cover exact frame names and dimensions, factor validation, alpha endpoints and interpolation relative to `cameraLimits.minZoom`, pure static-layout derivation, stable glyph selection, retained-container lifecycle, no mipmap configuration, unchanged camera bounds, and no gameplay or generation writes. Update 5.0 with the LOD page and twelve runtime pages when accepted.

Approval record: Gate A pending. Gate B pending. Expected integration work: a retained district layer, deterministic static plan, and fitted-zoom-relative crossfade.

Common failures: using absolute zoom values, using texture minification or mipmaps as LOD, changing camera limits to conceal a hierarchy problem, rebuilding either map per zoom or tick, fading characters and annotations with the district blocks, or deriving an LOD icon from mutable simulation state.

### 8. Hearthside HUD atlas and retained interaction chrome

Add a full-colour 4 by 3 `hud-atlas.png`, 1024 by 768 pixels, with twelve 256 by 256 runtime cells downsampled from a 2048 by 1536 source page with 512 by 512 masters. Its eleven named frames are `chromePaper`, `plateIdle`, `plateHover`, `plateActive`, `plateDisabled`, `joystickRing`, `joystickKnob`, `nameplate`, `speechPanel`, `speechTail`, and `expressionChip`. The final cell is transparent. Add the page to the runtime loader, raising the runtime page count from 12 to 13 when this unit lands.

Restyle `ui/chrome.ts`, `ui/annotations.ts`, and the visitor input components to consume the atlas. Preserve all approved 5.2 behaviour: opening and terminal chrome text, bell state, collision off by default and C-key access, zoom-preserving Recenter, visitor follow and manual suspension, ungraded nameplates and bubbles, expression hold and seek rules, permanent joystick semantics, expression palette semantics, and chat ownership. Art loading still leaves readable current fallbacks, and installing the HUD page must not replace retained controls or reset their state.

This is the final visual unit by design. Review it over the accepted detailed world and district LOD so the chrome supports both scales without competing with either. Add the missing `three-branches` browser end-to-end group under `frontend/e2e/three-branches/` and make it runnable as `uv run python scripts/ci.py frontend-e2e --group three-branches`. Cover real navigation and interactions that require the browser. Keep text, state, and structure assertions in fast renderer or frontend unit tests. Gate B runs the group in normal watch, replay, and visitor-play paths.

Tests cover manifest dimensions and the transparent cell, required frame installation, control state art without semantic changes, ungraded layer membership, fallback and retained-node installation, plus existing accessibility and keyboard contracts. Update 5.0 with the HUD page and the final thirteen-page runtime count only as this unit lands.

Approval record: Gate A pending. Gate B pending. Expected integration work: HUD atlas loading and skinning of existing retained controls without behavioural changes.

Common failures: baking HUD pixels into the graded world, using HUD art as a reason to alter an interaction target, resetting follow or a held input while artwork loads, omitting a disabled plate, or relying on a browser journey for assertions a focused unit test can make.

## Visual evaluation guidance

Use the pinned fixture to make like-for-like comparison possible, then use generated villages to expose density and edge cases. Start at the fitted view because it establishes the hierarchy. Move to a middle view to check interactions between scenery, props, roofs, and people. Use close view to inspect anchors, transparent apertures, line work, and readable HUD controls. Review night after the daytime result is accepted, not as a substitute for daylight legibility.

For each integration, inspect loading, a replay seek, a repeated delivered state, resize, and a live transition. The art should remain deterministic because static selection depends only on the static layout or stable id, and animated selection depends only on the recorded presentation time. The fallback must remain coherent until a successful asset installation. Do not turn an art correction into a new state or a special rendering path unless the unit's stated contract requires it.

Keep the review discussion concrete: named cell, runtime scale, phase, overlap, anchor, and expected retained layer. Record the Gate A and Gate B dates and a short acceptance note under the unit. Store any review screenshots in the existing committed art evidence location only when they are durable reference material. Candidate sheets stay in the ignored review directory.

## Final verification

Run these commands after the final Gate B, with the browser suite run from a working Docker environment:

```powershell
npm run atlas --workspace @game-sandbox/frontend -- check three_branches
uv run python scripts/ci.py check
uv run python scripts/ci.py test
uv run python scripts/ci.py frontend-e2e --group three-branches --fast
uv run python scripts/ci.py frontend-e2e
```

Run focused renderer tests throughout implementation, including the relevant `assets`, atlas freshness, presentation, terrain, props, buildings, characters, effects, UI, and LOD tests. The bare full browser command is the handoff check. Do not stage changes.

## Done when

All eight units have dated Gate A and Gate B owner approvals. Accepted sheets are the committed runtime pixels, with their source-art provenance, loose frames, compiled atlases, manifests, and 5.0 facts aligned. The final asset catalog loads thirteen runtime pages: terrain, props, monuments, lantern, buildings, scenery, body, clothing, arms, details, effects, district LOD, and HUD. The fitted village reads through the district representation at or below 1.25 times fitted zoom, crossfades to detailed art through 1.5 times fitted zoom, and uses no mipmaps. Daytime has no authored grade, while night grade, contact shadows, and emissives remain. The fixture and generated villages preserve their generation, camera, collision, replay, input, and gameplay contracts, the Three Branches browser group exists and passes, the full browser suite passes, and this stage records the owner's final acceptance date.
