# Step 3: Renderer, collision overlay, watch and replay

Status: planned.

Part of [the plan](../README.md). This is build-order step 3: it replaces step 2's minimal registered renderer stub with the real browser renderer and watch surface, and it is the first production exercise of the platform's simultaneous frontend paths. The hands-on surface is a live match watched in the browser and explored close up, its replay scrubbed to exact frames, and `npm run play` showing a local watch-mode day.

## Why this is its own seam

The collision overlay is a permanent viewer feature, not scaffolding: toggled on, it shows the game at collision truth, which is what students need when their villager gets stuck. Shipping the tile map, the overlay, and the camera before any art proves the whole watch surface complete and seek-safe, turns the registered stub into the real viewer, and gives step 4 the tool it uses to iterate on village generation visually. The camera ships here because its machinery already exists in the shared renderer base; this stage only mounts it, and step 5.2 tunes its limits under the final art and HUD.

## What to build

### The shared tile map base

Tile rendering joins the shared renderer base as `frontend/src/renderers/base/tile-map.ts`, wrapping [pixi-tiledmap](https://github.com/riebel/pixi-tiledmap) behind a project-owned API. The fork requires pixi.js 8.7 or later and the project ships 8.19. The dependency is pinned exact in `frontend/package.json`, because the packed map is the only drawing path for the village: a Pixi upgrade the fork cannot follow has to be taken deliberately rather than arriving with a patch release. The wrapper API is the contract, so environments never import the library and replacing that path later reaches no environment renderer.

- `TileGrid`: a column count plus row strings of single-character codes, row-major.
- `TileLayers`: an ordered stack of grids over one frame, drawn bottom to top, with one reserved code that draws nothing. Ground, edges, and object tiles are three layers over one village rather than three separate maps.
- `Tileset`: a tile size and, per code, one texture or an ordered list of variant textures. `solidColorTileset(colors)` builds a one-variant set from flat 2D-canvas fills, no assets and no GPU, which is this stage's placeholder path.
- `createTileMap(layers, tileset, {cellSize, variant})` validates the layers against the tileset and returns the drawn map: a positioned `view` container, `setTile(layer, column, row, code)` for single-cell repaints, and `destroy`.
- `variant(code, column, row, neighbours)` deterministically picks among a code's textures and defaults to the first. `neighbours` is the eight-bit mask of surrounding cells carrying the same code, computed by the base, which is exactly what step 5.1's autotiler consumes. The hook is the whole seam between the base and the art.

Layer and tileset validation is pure and tested under jsdom, where the suite also builds a small packed map to keep the one drawing path exercised. Real pixels stay the browser suite's job, since a renderer's own drawing sits behind the base class's headless guard.

### The renderer package

`environments/three_branches/renderer/` replaces the stub, keeping the `three-branches-village` key and the automatic discovery contract (the frontend globs `environments/*/renderer/index.ts`, so no registration edits). The thumbnail stays the stage 2 placeholder until step 5.1's art pass. The package mirrors the Skirmish at Crane Reach split: pure modules with no Pixi imports carry the logic and are unit-tested under jsdom, and Pixi modules only draw.

| Module | Responsibility |
| --- | --- |
| `overlay.ts` | The strict decoder mirroring `overlay.py`: `decodeStatic(header)` and `decodeDynamic(state, static)`, enforcing key sets, the declared frame, `q` roster counts, record lengths, base36 ranges, cells inside the frame, the movement cap, use implies stillness, a single prop holder, terminal only on the final tick, and producing the same friendly JSON in metres, cells, and words |
| `scene.ts` | `computeScene(state, staticOverlay)`: the pure drawable scene and placeholder palette. The static part reads the decoded ground, semantic buildings, structural props, interactive props, scenery, and spawn. It is computed once per static overlay and cached by reference. The dynamic part carries characters, interactive-prop states, and chrome strings, every drawable keyed by stable id. Labels come from `../catalog.json` and `../rules.json`, imported as JSON modules the way the crane renderer imports `tile_types.json` |
| `collision.ts` | `computeCollisionScene(state, staticOverlay)`: the collision-truth drawables listed under the overlay below, including catalog-derived structural shapes. Pure, and untouched by step 5.1's art swap |
| `map-layer.ts` | Pixi: expands the decoded ground rows into the layer stack, builds the palette's `solidColorTileset`, and mounts the shared tile map base |
| `buildings.ts` | Pixi: semantic building roof containers keyed by building id, with floors already present in the decoded ground and walls and doorways drawn by the structural-prop layer |
| `props-layer.ts` | Pixi: structural props plus per-state interactive props and labels, reconciled by stable object id; the seam step 5.1's stills and sustained animations replace |
| `characters.ts` | Pixi: per-state reconciliation of the cast by character id: 0.4 m circles with a heading tick, id, and expression label |
| `collision-layer.ts` | Pixi: draws `collision.ts`'s scene, visible while the viewer has the overlay on |
| `chrome.ts` | Pixi: the screen-fixed strip (tick, phase, bell state, terminal banner) and the in-canvas collision toggle button, whose rectangle it exports so tests can press it by name |
| `index.ts` | The `PixiRenderer` subclass: the world container tree, the shared camera mount, the toggle state, the probe attributes, and the `RendererDefinition` export |

There is no duplicate geometry module and no renderer-side building expansion. Small shared-catalog helpers turn each decoded type token into its footprint, shape, passability, opacity, and art. The decoded grid already includes floor terrain, and the decoded structural records already identify every wall and doorway. Static records carry type, cell, facing, and owner where applicable, never shape or footprint dimensions. No renderer formula can drift from the engine catalog.

World space uses 16 units per cell, the authoring scale step 5.1 fixes, so a tile lands at scale 1. The decoder reports the frame and its cell size, and the scene layer converts metres through one exported constant. Grid and overlay bounds follow the decoded frame; the shipped art and fixture remain authored for the shipped village frame. `internalSize` is 1200 by 1000, a near-square logical view with room for the chrome strip; the host lays out from `aspectRatio`.

The container tree is built for the art pass: `worldRoot` carries `gradedWorld` (map layers, building statics, props, characters, in that order) and then the collision layer, with chrome outside `worldRoot` entirely. Step 5.1 inserts its roofs, world-only phase grade, and emissives inside `gradedWorld` without restructuring, the collision overlay stays above the art and outside the grade as 5.1 requires, and the HUD later joins chrome unscaled and ungraded. One recording header pins one village for a whole session, so at mount the renderer decodes `ctx.header.overlay_static` once, retains it, and builds the map, the buildings, and the prop, character, and collision layers from it. Each step it decodes the dynamic overlay and updates those layers by stable id, so live play and a replay seek to the same state produce the same frame.

The browser suite reads renderer truth through data attributes on the container, the `data-crane-*` convention: `data-three-branches-ground` (ready), `data-three-branches-opening` (seen once the live tick 1 presentation renders), `data-three-branches-tick`, `data-three-branches-phase`, `data-three-branches-collision` (on or off), `data-three-branches-visitor` (the visitor position in centimetres), `data-three-branches-camera` (the shared `cameraProbeValue`), and `data-three-branches-terminal`.

### The camera

The shared camera modules carry the whole feature: `base/camera.ts` supplies limits, fit, clamp, pan, wheel and pinch zoom, and the world transform, and `base/camera-gestures.ts` wires the pointer and wheel events, both already proven by Skirmish at Crane Reach. The renderer feeds them the village bounds (the decoded frame in world units), fits against the masked content viewport below the 54-unit chrome strip, applies the resulting transform to `worldRoot`, and keeps chrome screen-fixed. The strip is outside the camera in both directions: the renderer answers the gesture module's `accepts` check with the content viewport, so pressing the collision button never also pans, zooms, or resets the view. The reset view is the fit: the whole village visible with nothing hidden, which is also the state every session and replay opens in. Zoom, pan, and pinch stay inside the module's clamped limits with its default zoom range; step 5.2 tunes the maximum zoom for expression and speech-bubble readability once the final art and HUD exist. This stage guarantees only that camera state is part of no scene computation, so a seek at any zoom renders the same world.

### The collision overlay

A viewer-toggleable overlay above the map, at collision truth: every solid ground cell shaded, every structural, interactive, and scenery collision shape drawn from its catalog type, interactive shapes carrying their type and state labels, passable doorways left visibly open, the four world boundaries, and characters as 0.4 m circles with a heading tick, id, and expression label. Together the shaded cells and catalog-derived shapes are the engine's whole static collision model. Wall structural props render in both the art and collision layers; doorway structural props render in the art and preserve visible openings in the overlay. The shared catalog supplies types, shapes, opacity, and interactive states, and `rules.json` supplies emote names. The overlay is on by default in this step, since until step 5.1 lands art it is the only depiction of characters and props; 5.1 revisits the default. The toggle is an interactive Pixi button inside the canvas, the pattern the crane order buttons set. It is view-only and never touches `sendAction`, so it works for spectators and replay viewers alike; keyboard access to it arrives with step 5.2's HUD pass.

### Speech

Chat is host chrome: NPC and visitor lines flow through `StepState.messages` to the shared chat panel, and the renderer draws nothing for them (speech bubbles are step 5.2). The e2e chat journey below is the consumer test for step 1's watcher visibility rule.

### Session limits

Step 1 landed the derived live-session duration in `backend/src/session/session-duration.ts`. For a cast_5 scripted watch day the ceiling resolves to 1200 ticks times 250 ms pacing, plus six agent episode budgets of 120 seconds, plus the 60 second platform allowance: 18 minutes over a roughly five-minute paced day. A unit case in the backend session-duration test pins the three_branches numbers through `resolveSessionMaxDurationMs`, so this environment's live day provably fits its derived default.

### Fixture and sidecar

`scripts/gen_three_branches_fixture.py` records one unpaced harness day on the fixture village with the shipped builtins (the naive cast and scripted visitor), Season 1 defaults (cast_5, daynight off), and a pinned seed. It writes `frontend/test/fixtures/three-branches-recording.jsonl` with 1,201 lines: one header plus 1,200 recorded post-step states. The live tick 1 opening presentation is intentionally not part of the recording contract. Step 4 regenerates both files on a generated village at each of its gates.

The generator also writes a test-only sidecar, `frontend/test/fixtures/three-branches-decoded.json`: the Python `decode_overlay` output for the header static, the compact overlay and friendly decode for the unrecorded tick 1 opening, and friendly decodes (with the repeated village stripped) for both terminal states, every 100th recorded tick, the first recorded frame, and every recorded frame where any character's expression or target changes. Each recorded sample carries its zero-based frame index. The sidecar is the cross-language drift guard: renderer tests assert exact decoder agreement within the overlay codec's precision.

The fixture is an interactive collision and rendering exercise: the naive cast performs its seeded random walk while the scripted visitor follows its waypoint graph. Generation asserts that every cast member moves, at least one cast member stalls after walking begins, the visitor waves, and the recording carries a pinned greeting from one player to another. No builtin uses a prop and the bell never rings. The fixture therefore carries seek determinism, the static village, simultaneous cast and visitor movement, collision contacts, waves, and speech, while renderer coverage of the other visuals (each emote, each prop-transition kind, the bell, the daynight phases, the terminal banner) comes from hand-authored compact frames and a synthetic daynight static in the unit tests, mirrored from `test_overlay`'s vocabulary.

### The e2e group

`frontend/e2e/three-branches/three-branches.spec.ts`; a directory with a spec under `frontend/e2e/` is the entire wiring. The [groups table](../../../docs/contributors/testing/browser-e2e.md#groups) gains a `three-branches` row. Two journeys, neither waiting out the day:

- Watch, explore, collision truth, stop, exact replay frames. Start a scripted watch from the environment page with a pinned seed, assert the live opening presentation renders at the fitted camera, assert the canvas paints and `data-three-branches-ground` reads ready, poll the tick attribute strictly increasing, drive a wheel zoom and a drag pan and assert the camera attribute changes and clamps, click the collision toggle and assert its attribute flips, stop the session, open the finalized replay, and scrub: the same seek twice yields identical tick and visitor attributes, and replay frame 1 renders the first recorded post-step state at the fitted camera.
- Watchers see every spoken line. The spades watcher-visibility pattern: spectator contexts with read-only chat panels see the visitor's canned lines live; after a mid-session reload, the live best-effort catch-up contains at most one copy because only the latest state is retained; and the recording supplies the exact line in replay and on the reopened ended-session page. The pinned seed must produce the first canned line within the opening ticks; picking it is a named implementation task.

Full-day coverage rides the fixture replay in the unit suite, because the day length is fixed and the design declares no length parameter.

## Tests

- `renderer/overlay.test.ts`: every malformed rejection mirrored from `test_overlay` (key sets, versions, `q` catalog and pose counts, record lengths, cells outside the frame, coordinate and heading ranges, movement above one metre, use with movement, two holders of one prop, a state out of range, terminal off the final tick), a focused alternate-frame static payload decoding correctly, and decoder isolation from consumer mutation.
- `renderer/agreement.test.ts`: the TypeScript static decode equals the sidecar's Python decode, and every sidecar frame decodes equal.
- `renderer/scene.test.ts`: seek-anywhere determinism over the fixture (recompute an already-visited frame after replaying every state and compare deep-equal, with static reference identity), the palette covering exactly `rules.json`'s ground codes, label pins from the shared JSON, chrome pins from synthetic frames (each emote, each prop state, the bell, each daynight phase, the terminal banner), and an all-frames wall-clock budget.
- `renderer/collision.test.ts`: the shaded solid set equal to the decoded map's impassable ground; decoded wall structural props solid and decoded doorway structural props passable; one drawn shape per solid structural, interactive, and scenery item, exact under each facing and catalog extent; the boundary; character circle and heading-tick geometry; and stable ids and labels.
- `renderer/camera.test.ts`: the village bounds in world units derived from the decoded frame, the fitted reset containing every cell below the chrome strip, the default zoom range, and the probe value format. The reducers themselves stay covered by the shared `frontend/test/camera.test.ts`.
- `renderer/chrome.test.ts`: the collision toggle centred where the browser journey presses it, and inside the strip. The journey has no DOM control to locate, so a moved button fails here in milliseconds instead of as a press that lands on nothing.
- `frontend/test/tile-map.test.ts`: layer and tileset validation, unknown-code and bounds rejection, the reserved empty code, span maths, deterministic variant selection including the neighbour mask at edges and corners, and the packed map's repaint, bounds, and single release.
- `scripts/tests/test_gen_three_branches_fixture.py`: regenerate the recording and decoded sidecar in a temporary directory and require both to remain byte-identical to the checked-in fixtures.
- The backend session-duration unit case pinning the derived three_branches limit.
- The two Playwright journeys above.
- While iterating, run the `three-branches` browser e2e group. Before handoff, run the bare full browser e2e suite.

## Build order

Six milestones, each ending green:

1. Shared tile base: pixi-tiledmap pinned and verified against the shipped Pixi, `tile-map.ts` with its layer stack and neighbour-aware variant hook, its unit tests.
2. Fixture and sidecar: the generator script, the pinned recording, the decoded sidecar.
3. Decoder and pure scenes: `overlay.ts`, `scene.ts`, and `collision.ts` with the rejection, agreement, determinism, label, synthetic-frame, and perf suites.
4. The renderer: the Pixi layers, chrome, toggle, camera mount and gestures, probe attributes, and the `index.ts` swap. Hands-on: `npm run play` shows a local watch-mode day explored close up.
5. The e2e group: both journeys, the pinned chat seed, the groups-table row.
6. Handoff: the session-duration pin, the bare full browser e2e run, and the done-when sweep.

## Done when

A live match renders in the browser and can be panned and zoomed within bounds, its replay scrubs to exact frames, `npm run play` shows a local watch-mode day, and the bare full browser e2e suite passes.
