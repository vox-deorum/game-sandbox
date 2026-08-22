# Step 5.3: Visual refinement and fitted-view hierarchy

Status: in progress. Unit 1 has removed the daytime authored grade from the live renderer. Tune the current graphics toward the approved Hearthside Ink direction: a village that reads clearly at fitted view and rewards close inspection without losing its calm, hand-made hierarchy.

Part of [the plan](../README.md). This stage uses the [5.0 atlas pipeline](5-0-atlas.md), the [5.1 visual direction](5-1-art-style.md), and the [5.2 HUD semantics and input design](5-2-hud-interaction-and-camera.md). It improves the live presentation, not technical parity for its own sake.

## Visual tuning contract

The world remains an exact 90 degree top-down projection. Do not redesign gameplay, collision, replay, input, the generator, layout, camera limits, or camera gestures. The collision overlay remains collision truth, never an art approximation. The presentation catalog owns each atlas group's mipmap flag. Do not add procedural LOD, a new rendering engine, or a second art pipeline.

Keep the night grade, prop contact shadows, and emissives. Unit 1 removes only the daytime authored grade. HUD and annotation layers remain ungraded, including nameplates, speech, and expression marks.

Work one owner-started unit at a time. Visual decisions belong to the owner. Tests and contract checks protect behaviour, but never substitute for visual judgment. Only run selected, focused tests.

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

A controlled style comparison keeps subject geometry, projection, canvas, crop, scale, placement, palette family, proofing field, and exclusions fixed. Each named variant changes one art-language hypothesis only, such as line-led, balanced, or wash-led. Do not vary construction, size, prop lore, or decoration inside a style-only experiment.

Proof images may use a flat neutral field so wash behaviour can be judged, but they do not use paper texture or tint the object through simulated absorption. The proof field is never runtime art. Promoted sources require clean alpha outside and through transparent gaps, cleared RGB in fully transparent pixels, no baked ground or cast shadow, and opaque solid materials except for intentional antialiasing or approved glow. If a tighter regeneration still returns a baked field, normalize it through the shared [asset-normalization module](../art/tools/AssetNormalization.psm1) and retain a small comparison-local recipe. The recipe records the known matte values, matte-distance ramp, final alpha ramp, island threshold, output size, and optional registration bounds. Widen the matte-distance ramp and raise the final alpha thresholds when pale matte contamination creates a visible border on dark terrain. The shared tool may remove the known proof background, decontaminate its edge colour, resize, restore registration, create a grayscale-alpha mask from a white proof, and clear RGB at alpha zero. It may not redraw or cosmetically restyle the asset. Add another reusable operation to the shared module when a later asset needs it instead of copying the pixel pipeline into that comparison.

Derive secondary states from the selected neutral or base construction. Preserve silhouette, projection, material family, scale, and registration. Add only the state cue needed for gameplay readability at runtime size. The cue may be proportionally bold when the prop is small, but it must not enlarge the prop or change its gameplay footprint.

Every comparison records a stable prompt ID, variant name, exact sent prompt, input images and their roles, output dimensions, proof or production status, and selection result. Retain the selected source provenance and reusable crop, resize, alpha, atlas, and diagnostic scripts. Remove rejected raster outputs after selection.

## Owner approvals

Gate A is a concise asset-direction approval. Show the complete proposed asset treatment at its intended viewing role, including the details that must survive fitted, middle, and close views. The owner approves the visual direction before it becomes runtime art.

Gate B is a concise integrated-scene approval. Show the approved art in the fixture and generated villages at the relevant scales and phases. Confirm that the intended visual gap is closed and that the retained behavior boundary still holds. Record both approvals and a short acceptance note under the unit.

## Ordered visual units

### 1. Tintable terrain repaint and no daytime authored grade

Desired result: terrain carries the Hearthside Ink material character and route hierarchy at fitted scale, with texture detail that rewards close inspection.

First, inspect the current terrain against the approved references at fitted, middle, and close scales, plus night. Present prioritized deviations, their effect, and proposed tuning focus to the owner, then wait for direction before art or runtime changes.

Keep the tintable terrain composition, deterministic patterning, routes, bridge ownership, and layer ownership. Bridge cells remain water in the contour pass, and their banks remain ordinary free shoreline beneath the shared deck cover. Remove the daytime authored grade only. Keep the night grade, contact shadows, emissives, and ungraded HUD and annotations.

The live renderer now has no daytime authored grade. The first Hearthside palette comparison adds dedicated terrain colours and remaps only terrain materials. Dedicated packed-earth road and sparse worn-stone path frames are integrated for the first comparison. The owner accepted the shared even road base, which prevents per-cell tonal blocks. The next integrated comparison gives the path a darker neutral tint and strengthens the contrast of its existing texture; it awaits owner visual approval. The remaining terrain review and both owner approvals remain in this unit.

### 2. High-resolution pines

Desired result: pines create readable village massing at fitted view, while base, canopy, and line work hold up nearby.

First, inspect the current scenery against the approved references at fitted, middle, and close scales, plus night. Present prioritized deviations, their effect, and proposed tuning focus to the owner, then wait for direction before art or runtime changes.

Keep static placement, collision, and stable variant selection. Draw each pine as one complete sprite after roofs so trees occlude characters and nearby architecture. Mask trees out of an entered building's semantic footprint so its cutaway interior remains clear.

Gate A accepted six complete, full-color 512 px pine variants. The owner approved the ground and night comparison, and variants B and F were reframed with transparent left padding before promotion. The 4 by 2 scenery page keeps the market crate in the seventh cell and leaves the eighth cell transparent. Runtime scale is divided by 8 so placement and collision registration remain unchanged. Gate B remains open for the integrated fitted, middle, close, and night review.

Pines now occupy a retained post-roof layer above props, effects, and characters. The layer has an inverse semantic building mask that snaps to the same recorded occupancy as roof fading, without waiting for roof art. Gate B remains open for owner visual approval.

The shared market crate is a closed square magic-punk supply coffer. Its construction follows the earlier approved coffer closely, including two indigo iron straps, rounded corner caps, a bone ceramic side conductor, and a sparse asymmetric brass latch. It uses the same medium warm timber family as the lantern and stalls without reusing their post frame, facade, blue binding, or central mechanism. Its authored silhouette fills the 512 px frame. The renderer applies the `0.25` scenery baseline across its 2 by 2 catalog footprint, and generation reserves all four solid cells as each crate is scattered around the market.

Generate the market crate with the approved lantern and closed stall as direct colour references. Keep its timber close to their warm medium-brown tone, its iron close to their charcoal-indigo, and its ceramic and brass accents equally restrained. Preserve its closed square coffer role, exact overhead projection, 512 px runtime frame, and 2 by 2 gameplay footprint.

### 3. Ordinary props and a dedicated lantern page

Desired result: ordinary props clearly express their states, and the lantern becomes a warm overhead beacon landmark that reads at night without crowding the day scene.

First, inspect the current props and lantern against the approved references at fitted, middle, and close scales, plus night. Present prioritized deviations, their effect, and proposed tuning focus to the owner, then wait for direction before art or runtime changes.

Keep prop state meanings and interaction and collision footprints. Keep the lantern on its dedicated page while treating it as an ordinary centered prop. Its art, contact shadow, selection, runtime flicker, and emissive light share the collision center. Pump and bell remain monuments.

The lantern keeps its dedicated 2 by 1 page with 384 by 512 cells but behaves like an ordinary one-cell prop. Each state is one complete lower-layer sprite centered at `(0, 0)`, with its visible 160 px silhouette scaled by `0.10` to match the 16-unit collision cell. Its contact shadow, selection outline, runtime flicker, and emissive light use the same collision center. The complete lantern does not use registered anchors, split clips, or an upper-layer sprite.

Pump keeps registered high-resolution art while occupying one gameplay cell. It keeps density divisor `4` and its source anchor, with complementary clips separating the circular well base from its upper mechanism. The props, lantern, monuments, bell, and scenery atlas groups use generated mipmaps for clean minification, covering stalls and pines as well as the remaining interactive props. Bell uses a dedicated double-density page with 1536 by 1024 frames and density divisor `16`. Its state-independent foundation stays below characters; its fixed gantry and separately animated circular bell stay above them. Registration, fixed facing, collision scaling, contact shadows, and layer roles remain separate renderer contracts. The notice board joins lantern, shrine, pump, and bell as a fixed-facing prop, so it always draws north whatever facing generation records. Every prop retains its catalog footprint, collision, selection, generation placement, shadow, and highlight.

The owner selected magic-punk lantern C. Its compact octagonal beacon, exact overhead projection, timber tone, baked light, and runtime glow define the current reference treatment. Its true unlit state keeps identical geometry and centered placement while removing the powered core and baked halo. The selected lit and unlit art, dedicated runtime page, and source provenance are promoted for integrated scene review.

The lantern's solid materials use opaque interior alpha with cleared colour in fully transparent pixels. The lit state retains soft alpha only for the intentional baked halo and exterior antialiasing. This prevents terrain colour and texture filtering from breaking through its solid silhouette while preserving the approved geometry and glow.

The prop language is old magical infrastructure kept alive by rough, competent village repairs. Hearthside timber provides the main mass. Dark indigo iron casings, pale bone ceramic insulation, sparse gilt at powered points, and one visible conductor path explain the inherited magic. Cracked-core clamps, staples over broken traces, and mismatched brackets provide restrained repair history. Avoid gears, boilers, pipes, neon, screens, ornamental rune fields, and crystal clusters. Use broad value groups and low-frequency grain so each construction remains readable at its runtime size.

The owner approved all three magic-punk stall constructions and their matching open states. All three use the same medium warm timber family, including construction C in both states. The renderer assigns a construction once from the prop ID and preserves it across state, facing, reconciliation, and art reinstall. Numeric suffixes cycle A, B, C by modulo three (`stall_0` uses A, `stall_1` uses B, `stall_2` uses C, `stall_3` uses A); IDs without a numeric suffix use A. State selects only the matching open or closed frame. All six frames remain ordinary lower-layer art on the 384 by 256 props grid. Their configured source cells, compiled atlas, and source provenance are promoted together as one art change. The stall texture's front reads the opposite way from the recorded facing, so the renderer draws each stall sprite half a turn round from where it stands.

The approved concept and material board define the art language for all interactive props and the market crate. The selected lantern supplies secondary production continuity for timber tone and magic-punk material accents only when it agrees with those primary references. Regenerate full-colour art rather than tinting it at runtime, and use no wood mask, shader, numeric colour tolerance, or colour snapshot test. Continue one family at a time in this order: bench, shrine, board, plot, hearth, repair bench, pump, then bell. For each neutral or base state, generate three alternatives with fixed construction and one named mark-making hypothesis each, then present them without runtime integration. The owner selects or redirects one treatment before the remaining states are derived from it. A later construction study may change silhouette only when the owner explicitly makes construction the experiment variable. Gameplay footprint, state meaning, registration, and projection remain fixed. Grain, wear, and light-to-dark proportions may vary, but the props do not form separate blond, orange, gray, or dark-brown timber families. Buildings and pines remain outside this pass. The board keeps a 512 by 512 canonical source inside the shared props atlas contract.

On 2026-08-22, the owner made the Hearthside Ink concept and material board the primary style authorities and rejected bench comparison 1 because it varied plank construction while missing the concept's ink-and-wash language. [Bench comparison 2](../art/bench-comparison-2/prompts.md) excluded the lantern, stalls, runtime props, and comparison 1 from the controlled style experiment. It held one exact-overhead three-plank construction fixed and varied only line-led, balanced, and wash-led mark making against the direct conceptual bench crop and isolated timber and ink references. The owner selected balanced variant B, then requested clearer colour without the absorbent-paper treatment. The revised empty and occupied states use the same small registered bench, clearer warm cedar values, controlled hand tint, and no bloom, granulation, or paper haze. A larger indigo-violet cloth supplies the readable occupied cue at runtime size. Their cleaned 384 by 256 sources are in the working props atlas for the later complete-prop Gate A review.

The owner selected the decorated riven conduit arch from [shrine comparison 2](../art/shrine-comparison-2/prompts.md). Its original warm gray-ochre stone stays fixed while indigo-violet cloth, an ochre beaded cord, brass votive discs, a bone aperture, and an indigo iron brace provide readable permanent accents. The tended state adds fruit, a green sprig, incense, a violet-blue aperture light, and warm light along the existing conductor. Both state stills remain centered lower-layer art on the 384 by 256 props grid with the existing 3 by 3 gameplay footprint, fixed north presentation, state names, and timing.

The selected notice board from [board comparison 1](../art/board-comparison-1/prompts.md) combines decisive dry-brush structural ink with clear warm cedar colour. Its five pinned notices carry bold pictorial postings for a river route, market fruit, an herb sprig, a lantern, and a repair task, with no readable writing. Indigo iron clips, a bone ceramic insulator, and one brass conductor path carry the shared magic-punk language. The shared normalizer places its visible pixels within the centered `(32, 32, 448, 448)` target on a 512 by 512 canonical source. The shared props-atlas recipe then uses the full safe 252 px cell height and preserves the source proportions, producing a centered 251 by 252 runtime silhouette. Scale `0.12444444444444444` preserves the prior 31.36-unit vertical extent and gives a 31.24-unit horizontal extent. The fixed-north presentation, ordinary centered anchor, 2 by 2 gameplay footprint, collision, state name, shadow, and highlight remain unchanged. The board does not use a dedicated atlas.

[Plot comparison 1](../art/plot-comparison-1/prompts.md) was rejected because its directional raised-wall projection did not remain credible under runtime rotation. [Plot comparison 2](../art/plot-comparison-2/prompts.md) was also rejected because its shallow edge depth still read as a wall. Both rejected batches retain prompt provenance but no raster proofs. [Plot comparison 3](../art/plot-comparison-3/prompts.md) was rejected because its remaining depth cues still failed the rotation-safe projection requirement. [Plot comparison 4](../art/plot-comparison-4/prompts.md) defines the production garden as a 100 percent top-down orthographic plan view with one flat ground-inlaid boundary and no visible vertical face, rim thickness, drop shadow, perspective, or directional facade. Its medium-dark cedar frame is bounded by the selected bench and notice board timber family. Contrast comes from dark soil, distinct plant greens, charcoal-indigo plates, pale bone ceramic, restrained brass, and violet and ochre flowers rather than bright wood. The overgrown and tended states share a centered 376 by 188 visible rectangle on ordinary 384 by 256 sources. Both remain on the shared props page at scale `0.17`, use the existing `overgrown` and `tended` names, rotate with recorded facing, and preserve the 4 by 2 gameplay footprint, collision, selection, and interaction contract.

The tended shrine's drifting violet cloud is a separate 192 by 128 grayscale-alpha effect mask. The base still contains no drifting wisps or detached motes. A reusable optional `opacityAnimation` treatment on any sustained prop effect accepts `mode`, `min`, `max`, and `periodTicks`. The `pingPong` mode resolves absolute opacity from `min` to `max` and back once per configured period. It uses fractional presentation tick and the existing stable prop phase, so the same replay seek always produces the same opacity. The shrine uses `min: 0`, `max: 1`, and `periodTicks: 8`, with a fixed centered scale that aligns the full effect canvas to the shrine canvas. Only opacity animates. This adds no gameplay state, collision rule, mutable effect clock, or shrine emissive.

The lantern and bell use an exact 90 degree overhead projection, including bases that read entirely from above. Both keep their one-cell gameplay footprint, state meanings, and shared timber, indigo iron, bone ceramic, and sparse gilt material tones. The lantern uses its ordinary centered prop contract. The bell keeps registered foundation, fixed-gantry, and moving-bell roles.

The regenerated comparison uses a compact octagonal lantern whose height is conveyed through concentric foreshortened surfaces, plus a bell whose gantry rails and circular bell are visible only from above. Lit and unlit lantern states share the same construction. Silent and ringing bell states share the same registered art layers. The silent bell remains centered. The ringing state applies a small seek-safe back-and-forth rotation to the circular bell alone, using fractional playback tick and prop ID, around its authored suspension bolt. State names and one-cell gameplay contracts remain unchanged.

Formal Gate A waits for one sheet containing every revised prop state and the crate. After Gate A, promote the accepted source art, declare its cell transforms in `presentation.json`, compile the runtime atlas, and update steps 5.0 and 5.1. Gate B then checks the pinned fixture and generated seeds `0`, `17`, and `37` for fitted hierarchy, middle and close material unity, state readability, night behavior, unchanged registered-prop placement, and the crate's 2 by 2 collision contract.

### 4. 128 px full-roof building sprites

Desired result: roof materials establish a readable building hierarchy from fitted view and reward close inspection without obscuring residents.

First, inspect the current roofs against the approved references at fitted, middle, and close scales, plus night. Present prioritized deviations, their effect, and proposed tuning focus to the owner, then wait for direction before art or runtime changes.

Keep semantic building extents, collision, and the existing occupancy fade and replay-seek behavior. Use one layered `buildings` atlas declaration that resolves to three mipmapped full-color one-frame pages: `buildings-home-atlas.png` at 1024 by 896, `buildings-inn-atlas.png` at 1536 by 1280, and `buildings-shed-atlas.png` at 1024 by 1024. Each source is authored at 128 px per semantic cell for the home 8 by 7, inn 12 by 10, and shed 8 by 8 extents. The roof schema names one frame per building layer. Runtime keeps one centered full-roof sprite per semantic building, scales it by `cellSize / 128`, and rotates it by facing around the rect center. Retain the roof container, clear alpha `0.18`, fade duration `220` ms, occupancy targets, snap on mount, seek, repeated frames, resize, and reinstall, plus reversible easing when occupancy changes.

Acceptance note: Gate A approved the concept-3 wash-led family on 2026-08-22. The cyclic assignment is timber-plank shed proof to home, cedar-shingle home proof to inn, and indigo ceramic inn proof to shed. Normalized sources have clean alpha, and compiled pages use mipmaps. Gate B remains pending until integrated manual review.

### 5. Four layered cast sets

Desired result: the visitor and villagers are distinct, legible people at close and middle scale, with clear far marks at fitted view.

First, inspect the current cast against the approved references at fitted, middle, and close scales, plus night. Present prioritized deviations, their effect, and proposed tuning focus to the owner, then wait for direction before art or runtime changes.

Create one visitor set and three villager sets across the existing body, clothing, and arm layers. Keep the visitor identity, deterministic villager selection, recorded heading, walk cadence, shadows, far marks, nameplates, and chip-and-text expressions. Do not add the retired embodied-arm study.

### 6. Monument and effect completion

Desired result: monuments feel like memorable village anchors, while effects make activity, light, and expression readable without visual noise.

First, inspect the current monuments and effects against the approved references at fitted, middle, and close scales, plus night. Present prioritized deviations, their effect, and proposed tuning focus to the owner, then wait for direction before art or runtime changes.

Complete the monument treatments, effect set, ten expression pictograms, and two expression accents. Keep monument anchors, fixed orientation, collision, effect timing, and layer order. Contact shadows remain below props, and emissives retain their night behavior.

### 7. District LOD at fitted view

Desired result: the fitted view reads as an intentional district map, then resolves smoothly into the detailed village as the viewer approaches.

First, inspect the current fitted, transition, and detailed district views against the approved references at fitted, middle, and close scales, plus night. Present prioritized deviations, their effect, and proposed tuning focus to the owner, then wait for direction before art or runtime changes.

Use authored district representations, not mipmaps. Keep terrain and routes visible, preserve character far marks, emissives, annotations, HUD, and collision overlay, and derive the district view from the existing static layout. Crossfade from district at or below 1.25 times fitted zoom to detail at or above 1.5 times fitted zoom without changing generation, camera, input, collision, replay, or gameplay.

### 8. Hearthside HUD atlas and retained interaction chrome

Desired result: Hearthside Ink chrome supports the detailed and district views while controls, annotations, and player intent remain immediately legible.

First, inspect the current HUD against the approved references at fitted, middle, and close scales, plus night where relevant. Present prioritized deviations, their effect, and proposed tuning focus to the owner, then wait for direction before art or runtime changes.

Keep every approved 5.2 semantic, including watch and replay chrome, collision access, recenter and follow behavior, visitor controls, expression palette, chat, accessibility, and input state. HUD and annotations stay ungraded, and art loading must not reset retained controls or their state.

## Visual review and validation

At Gate B, compare the pinned fixture first, then generated villages to expose density and placement issues. Review day before night, and review fitted before middle and close. Inspect relevant loading, replay seek, resize, and live transitions when the unit touches them.

Run focused renderer and frontend checks for each changed boundary. Update [5.0](5-0-atlas.md) only when accepted assets or pipeline facts land. Keep tests focused on the contract, not subjective appearance. Do not stage changes.

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
