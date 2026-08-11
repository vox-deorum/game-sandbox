# Step 3: Renderer, collision overlay, watch and replay

Status: planned.

Part of [the plan](../README.md). This is build-order step 3: it replaces step 2's minimal registered renderer stub with the real browser renderer and watch surface, and it is the first production exercise of the platform's simultaneous frontend paths. The hands-on surface is a live match watched in the browser and explored close up, its replay scrubbed to exact frames, and `npm run play` showing a local watch-mode day.

## Why this is its own seam

The collision overlay is a permanent viewer feature, not scaffolding: toggled on, it shows the game at collision truth, which is what students need when their villager gets stuck. Shipping the tile layers, the overlay, and the camera before any art proves the whole watch surface complete and seek-safe, turns the registered stub into the real viewer, and gives step 4 the tool it uses to iterate on village generation visually. The camera ships here because its machinery already exists in the shared renderer base; this stage only mounts it, and step 5.2 tunes its limits under the final art and HUD.

## What to build

### The shared tile base

`frontend/src/renderers/base/tiled-ground.ts` already wraps [pixi-tiledmap](https://github.com/riebel/pixi-tiledmap) behind a project-owned API: `TileGrid`, `GroundTileset`, `solidColorTileset`, the validators, `createTiledGround`, and `setTile` for single-cell repaints. The village needs two additions to it and nothing else, so there is one tile module in the project and one drawing path.

- **A layer stack.** `createTiledGround` accepts an ordered list of grids over one frame, drawn bottom to top, with one reserved code that draws nothing. The village's terrain, its wall tops, and its object tiles become layers over one frame rather than three separate maps. A single grid keeps working unchanged, which is how Skirmish at Crane Reach already calls it.
- **A neighbour mask.** The `variant` callback receives the eight-bit mask of surrounding cells carrying the same code, computed by the base. That mask is exactly what step 5.1's autotiler consumes, and the hook is the whole seam between the base and the art.

`setTile` stays as it is: the village is fixed for a whole session so nothing repaints it here, but the contract belongs to the base rather than to any one environment. One unit case covers a repaint landing on the right cell and rejecting an out-of-bounds one.

Layer and tileset validation is pure and tested under jsdom, where the suite also builds a small packed map to keep the one drawing path exercised. Real pixels stay the browser suite's job, since a renderer's own drawing sits behind the base class's headless guard.

### The renderer package

`environments/three_branches/renderer/` replaces the stub, keeping the `three-branches-village` key and the automatic discovery contract (the frontend globs `environments/*/renderer/index.ts`, so no registration edits). The thumbnail stays the stage 2 placeholder until step 5.1's art pass. The package mirrors the Skirmish at Crane Reach split: pure modules with no Pixi imports carry the logic and are unit-tested under jsdom, and Pixi modules only draw.

| Module | Responsibility |
| --- | --- |
| `overlay.ts` | The TypeScript types for the recording's static and dynamic payloads, and one `readStatic(header)` shape check run at mount: the declared frame, ground rows summing to it, and the character and prop rosters present. The payloads are plain JSON in metres, cells, and words, so there is nothing to decode |
| `scene.ts` | `computeScene(state, staticOverlay)`: the pure drawable scene and placeholder palette. The static part reads the ground grid, semantic buildings, props, scenery, and spawn, and is computed once per static payload and cached by reference. The dynamic part carries characters, prop states, and chrome strings, every drawable keyed by stable id. Labels come from `../catalog.json` and `../rules.json`, imported as JSON modules the way the crane renderer imports `tile_types.json` |
| `collision.ts` | `computeCollisionScene(state, staticOverlay)`: the collision-truth drawables listed under the overlay below. Pure, and untouched by step 5.1's art swap |
| `map-layer.ts` | Pixi: expands the ground rows into the layer stack, builds the palette's `solidColorTileset`, and mounts the shared tile base |
| `buildings.ts` | Pixi: semantic building roof containers keyed by building id, with floors, walls, and doorways already present in the ground grid |
| `props-layer.ts` | Pixi: per-state interactive props and their labels, plus scenery, reconciled by stable id; the seam step 5.1's stills and sustained animations replace |
| `characters.ts` | Pixi: per-state reconciliation of the cast by character id: body circles with a heading tick, id, and expression label |
| `collision-layer.ts` | Pixi: draws `collision.ts`'s scene, visible while the viewer has the overlay on |
| `chrome.ts` | Pixi: the screen-fixed strip (tick, phase, bell state, terminal banner) and the in-canvas collision toggle button, whose rectangle it exports so tests can press it by name |
| `index.ts` | The `PixiRenderer` subclass: the world container tree, the shared camera mount, the toggle state, the probe attributes, and the `RendererDefinition` export |

There is no duplicate geometry module and no renderer-side building expansion. The ground grid already carries every floor, wall, and doorway cell, so a building's only renderer-side geometry is its rect, taken from its origin and its catalog footprint. Small shared-catalog helpers turn each prop's type token into its footprint, shape, and art. No renderer formula can drift from the engine catalog.

World space uses 16 units per cell, the authoring scale step 5.1 fixes, so a tile lands at scale 1. The static payload reports the frame and its cell size, and the scene layer converts metres through one exported constant. `internalSize` is 1200 by 1000, a near-square logical view with room for the chrome strip; the host lays out from `aspectRatio`.

The container tree is built for the art pass: `worldRoot` carries `gradedWorld` (map layers, building statics, props, characters, in that order) and then the collision layer, with chrome outside `worldRoot` entirely. Step 5.1 inserts its roofs, world-only phase grade, and emissives inside `gradedWorld` without restructuring, the collision overlay stays above the art and outside the grade as 5.1 requires, and the HUD later joins chrome unscaled and ungraded.

One recording header pins one village for a whole session, so at mount the renderer reads `ctx.header.overlay_static` once, retains it, and builds the map, the buildings, and the prop, character, and collision layers from it. Each step it reads the dynamic payload and updates those layers by stable id. Nothing rebuilds the village, because no state carries it, and live play and a replay seek to the same state therefore produce the same frame.

The browser suite reads renderer truth through data attributes on the container, the `data-crane-*` convention: `data-three-branches-ground` (ready), `data-three-branches-opening` (seen once the live tick 1 presentation renders), `data-three-branches-tick`, `data-three-branches-phase`, `data-three-branches-collision` (on or off), `data-three-branches-visitor` (the visitor position in centimetres), `data-three-branches-camera` (the shared `cameraProbeValue`), and `data-three-branches-terminal`.

### The camera

The shared camera modules carry the whole feature: `base/camera.ts` supplies limits, fit, clamp, pan, wheel and pinch zoom, and the world transform, and `base/camera-gestures.ts` wires the pointer and wheel events, both already proven by Skirmish at Crane Reach. The renderer feeds them the village bounds (the frame in world units), fits against the masked content viewport below the 54-unit chrome strip, applies the resulting transform to `worldRoot`, and keeps chrome screen-fixed. The strip is outside the camera in both directions: the renderer answers the gesture module's `accepts` check with the content viewport, so pressing the collision button never also pans, zooms, or resets the view. The reset view is the fit: the whole village visible with nothing hidden, which is also the state every session and replay opens in. Zoom, pan, and pinch stay inside the module's clamped limits with its default zoom range; step 5.2 tunes the maximum zoom for expression and speech-bubble readability once the final art and HUD exist. This stage guarantees only that camera state is part of no scene computation, so a seek at any zoom renders the same world.

### The collision overlay

A viewer-toggleable overlay above the map, at collision truth: every impassable ground cell shaded, which is exactly the water and the building walls; every interactive prop and scenery collision shape drawn from its catalog type, with interactive shapes carrying their type and state labels; doorway ground left visibly open; the four world boundaries; and characters as body circles with a heading tick, id, and expression label. Together the shaded cells and the catalog shapes are the engine's whole static collision model, in the same two layers the engine keeps them in. `catalog.json` supplies prop types and shapes, and `rules.json` supplies ground passability and emote names.

The overlay is on by default in this step, since until step 5.1 lands art it is the only depiction of characters and props; 5.1 revisits the default. The toggle is an interactive Pixi button inside the canvas, the pattern the crane order buttons set. It is view-only and never touches `sendAction`, so it works for spectators and replay viewers alike; keyboard access to it arrives with step 5.2's HUD pass.

### Speech

Chat is host chrome: every line flows through `StepState.messages` to the shared chat panel, and the renderer draws nothing for them (speech bubbles are step 5.2). Because every line is a broadcast, every socket sees every line, which the e2e journey below is the consumer test for.

### Session limits

Step 1 landed the derived live-session duration in `backend/src/session/session-duration.ts`. For a cast_5 scripted watch day the ceiling resolves to 1200 ticks times 250 ms pacing, plus six agent episode budgets of 120 seconds, plus the 60 second platform allowance: 18 minutes over a roughly five-minute paced day. A unit case in the backend session-duration test pins the three_branches numbers through `resolveSessionMaxDurationMs`, so this environment's live day provably fits its derived default.

### The fixture

`scripts/gen_three_branches_fixture.py` records one unpaced harness day on the fixture village with the shipped builtins (the naive cast and scripted visitor), Season 1 defaults (cast_5, daynight off), and a pinned seed. It writes `frontend/test/fixtures/three-branches-recording.jsonl` with 1,201 lines: one header plus 1,200 recorded post-step states. The live tick 1 opening presentation is intentionally not part of the recording contract. Step 4 regenerates the file at each of its gates.

The recording is plain JSON in the same words the engine and the guide use, so the renderer tests read it directly. There is no second decoded copy to keep in step and no cross-language drift guard to maintain.

The fixture is an interactive collision and rendering exercise: the naive cast performs its seeded random walk while the scripted visitor moves through the village. Generation asserts that every cast member moves, at least one cast member stalls after walking begins, the visitor waves, and at least one line is spoken and delivered. It asserts those as properties rather than as pinned ticks or pinned text, so a regenerated fixture never drags a constant behind it. The fixture therefore carries seek determinism, the static village, simultaneous cast and visitor movement, collision contacts, waves, and speech, while renderer coverage of the other visuals (each emote, each prop-transition kind, the bell, the daynight phases, the terminal banner) comes from hand-authored frames in the unit tests.

### The e2e group

`frontend/e2e/three-branches/three-branches.spec.ts`; a directory with a spec under `frontend/e2e/` is the entire wiring. The [groups table](../../../docs/contributors/testing/browser-e2e.md#groups) gains a `three-branches` row. Two journeys, neither waiting out the day:

- Watch, explore, collision truth, stop, exact replay frames. Start a scripted watch from the environment page with a pinned seed, assert the live opening presentation renders at the fitted camera, assert the canvas paints and `data-three-branches-ground` reads ready, poll the tick attribute strictly increasing, drive a wheel zoom and a drag pan and assert the camera attribute changes and clamps, click the collision toggle and assert its attribute flips, stop the session, open the finalized replay, and scrub: the same seek twice yields identical tick and visitor attributes, and replay frame 1 renders the first recorded post-step state at the fitted camera.
- Every socket sees every line. The spades watcher-visibility pattern: spectator contexts with read-only chat panels see the visitor's lines live; after a mid-session reload, the live best-effort catch-up contains at most one copy because only the latest state is retained; and the recording supplies the same line in replay and on the reopened ended-session page. The journey reads whatever line the session actually produced and carries it forward through replay, so it pins no text and no tick.

Full-day coverage rides the fixture replay in the unit suite, because the day length is fixed and the design declares no length parameter.

## Tests

- `renderer/overlay.test.ts`: the mount-time shape check accepting the fixture header and rejecting a frame that disagrees with its ground rows, a missing roster, and a state whose character or prop count does not match the header.
- `renderer/scene.test.ts`: seek-anywhere determinism over the fixture (recompute an already-visited frame after replaying every state and compare deep-equal, with static reference identity), the palette covering exactly `rules.json`'s ground codes, label pins from the shared JSON, chrome pins from hand-authored frames (each emote, each prop state, the bell, each daynight phase, the terminal banner), and an all-frames wall-clock budget.
- `renderer/collision.test.ts`: the shaded set equal to the impassable ground of the header's grid, water and wall alike; doorway ground unshaded; one drawn shape per interactive prop and scenery item, exact under each facing and catalog extent; the boundary; character circle and heading-tick geometry; and stable ids and labels.
- `renderer/camera.test.ts`: the village bounds in world units derived from the frame, the fitted reset containing every cell below the chrome strip, the default zoom range, and the probe value format. The reducers themselves stay covered by the shared `frontend/test/camera.test.ts`.
- `renderer/chrome.test.ts`: the collision toggle centred where the browser journey presses it, and inside the strip. The journey has no DOM control to locate, so a moved button fails here in milliseconds instead of as a press that lands on nothing.
- `frontend/test/tiled-ground.test.ts`: the added layer stack and reserved empty code, the neighbour mask at edges and corners feeding deterministic variant selection, and one repaint case. The module's existing validation coverage stays as it is.
- `scripts/tests/test_gen_three_branches_fixture.py`: regenerate the recording in a temporary directory and require it to remain byte-identical to the checked-in fixture.
- The backend session-duration unit case pinning the derived three_branches limit.
- The two Playwright journeys above.
- While iterating, run the `three-branches` browser e2e group. Before handoff, run the bare full browser e2e suite.

## Build order

Five milestones, each ending green:

1. The shared tile base: the layer stack and the neighbour-aware variant hook added to `tiled-ground.ts`, with its unit tests.
2. The fixture: the generator script and the pinned recording.
3. Pure scenes: `overlay.ts`, `scene.ts`, and `collision.ts` with the shape-check, determinism, label, hand-authored-frame, and performance suites.
4. The renderer: the Pixi layers, chrome, toggle, camera mount and gestures, probe attributes, and the `index.ts` swap. Hands-on: `npm run play` shows a local watch-mode day explored close up.
5. Handoff: the e2e group and its groups-table row, the session-duration pin, the bare full browser e2e run, and the done-when sweep.

## Done when

A live match renders in the browser and can be panned and zoomed within bounds, its replay scrubs to exact frames, `npm run play` shows a local watch-mode day, and the bare full browser e2e suite passes.
