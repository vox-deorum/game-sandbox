# Step 5.3: Visual refinement and fitted-view hierarchy

Status: in progress. Unit 1 has removed the daytime authored grade from the live renderer. Tune the current graphics toward the approved Hearthside Ink direction: a village that reads clearly at fitted view and rewards close inspection without losing its calm, hand-made hierarchy.

Part of [the plan](../README.md). This stage uses the [5.0 atlas pipeline](5-0-atlas.md), the [5.1 visual direction](5-1-art-style.md), and the [5.2 HUD semantics and input design](5-2-hud-interaction-and-camera.md). It improves the live presentation, not technical parity for its own sake.

## Visual tuning contract

The world remains an exact 90 degree top-down projection. Do not redesign gameplay, collision, replay, input, the generator, layout, camera limits, or camera gestures. The collision overlay remains collision truth, never an art approximation. Do not add mipmaps, procedural LOD, a new rendering engine, or a second art pipeline.

Keep the night grade, prop contact shadows, and emissives. Unit 1 removes only the daytime authored grade. HUD and annotation layers remain ungraded, including nameplates, speech, and expression marks.

Work one owner-started unit at a time. Visual decisions belong to the owner. Tests and contract checks protect behaviour, but never substitute for visual judgment. Only run selected, focused tests.

## Required start for every unit

The first mandatory step is a rendered-state diagnosis, before generating art or editing runtime code.

1. Inspect the current unit against the approved references at fitted, middle, and close scales, plus night where relevant.
2. Present the owner with prioritized deviations, the visual effect of each deviation, and the proposed tuning focus. Use the [Hearthside Ink approval mockup](../art/hearthside-ink-approval.png) and [material board](../art/hearthside-ink-material-board.png). Cast work also uses the [approved top-down shooter direction](../art/top-down-shooter-direction.png).
3. Stop and wait for owner direction. Do not generate comparison art or change runtime code until the owner releases the unit.

After that direction, make only the smallest art or integration changes that close the agreed visual gaps. Start with one Git-visible, unstaged comparison batch, present it to the owner, and stop again until the owner selects or redirects the approach. Keep the current fallback and deterministic presentation behaviour unless a unit explicitly needs bounded support.

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

### 3. Ordinary props and a dedicated lantern page

Desired result: ordinary props clearly express their states, and the lantern becomes a warm vertical landmark that reads at night without crowding the day scene.

First, inspect the current props and lantern against the approved references at fitted, middle, and close scales, plus night. Present prioritized deviations, their effect, and proposed tuning focus to the owner, then wait for direction before art or runtime changes.

Keep prop state meanings and interaction and collision footprints. Move the lantern out of the ordinary props page into its own taller treatment, registering the approved art without shifting its world position or established glow placement. Keep its contact shadow and emissive behavior. Pump and bell remain monuments.

The owner directed one provisional runtime comparison before Gate A. This exception exists only to judge the current lantern candidate in the village. The comparison uses a dedicated 2 by 1 page with 384 by 512 cells, keeps the lantern at scale `0.14`, anchors its one-cell footing at `(192, 384)`, and splits the same state texture at runtime row `362`: the footing draws below characters and the post and lamp draw above them. Its 2048 by 1536 provenance page retains the unchanged high-resolution candidate in both state cells. The lit candidate supplies both runtime state slots for this comparison, so the provisional `unlit` still contains its gilt core and baked halo. The `lit` state also keeps the established runtime flicker, glow, and `(0, -70)` effect anchor. This diagnostic art stays unstaged and does not count as Gate A or Gate B approval.

Lantern, pump, and bell share the same registered-prop behavior without sharing page dimensions. Each reads about two cells tall while occupying one gameplay cell, keeps its base below characters, and draws its upright structure above characters. Pump keeps density divisor `4` and its source anchor, with complementary clips separating the circular well base from its upper mechanism. Bell keeps its lower foundation, upper state treatment, density divisor `8`, and role anchors. The lantern uses density divisor `1` and complementary lower and upper clips. Registration, fixed facing, collision scaling, contact shadows, and layer roles remain separate renderer contracts. Each catalog rectangle, collision circle, selection, generation placement, shadow, and highlight remains one cell.

Review the provisional lantern at fitted, middle, and close views in day and night. Include the collision overlay, character overlap, building adjacency, and both recorded states. Revise its geometry, exact overhead projection, combined baked and runtime glow, split occlusion, and timber tone until the owner accepts it. Then derive a true unlit state with identical geometry and registration.

The accepted lantern becomes the qualitative timber reference for all interactive props and the market crate. Regenerate full-colour art rather than tinting it at runtime, and use no wood mask, shader, numeric colour tolerance, or colour snapshot test. Work one family at a time in this order: stall, bench, shrine, board, plot, hearth, repair bench, pump, bell, then market crate. Accept the neutral or base state first, then edit it into the remaining states so registration and silhouette stay fixed. Grain, wear, and light-to-dark proportions may vary, but the props do not form separate blond, orange, gray, or dark-brown timber families. Buildings and pines remain outside this pass. The board stays on its 384 by 256 canvas and keeps its interim scale override until its later re-authoring.

Formal Gate A waits for one sheet containing every revised prop state and the crate. After Gate A, promote the accepted loose frames and source provenance and update steps 5.0 and 5.1. Gate B then checks the pinned fixture and generated seeds `0`, `17`, and `37` for fitted hierarchy, middle and close material unity, state readability, night behavior, unchanged registration, and the one-cell collision contract.

### 4. 128 px roof tiles

Desired result: roof materials establish a readable building hierarchy from fitted view and reward close inspection without obscuring residents.

First, inspect the current roofs against the approved references at fitted, middle, and close scales, plus night. Present prioritized deviations, their effect, and proposed tuning focus to the owner, then wait for direction before art or runtime changes.

Keep semantic building extents, collision, and the existing occupancy fade and replay-seek behavior.

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
