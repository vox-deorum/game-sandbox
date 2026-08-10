# Step 3: Renderer, collision overlay, watch and replay

Status: complete.

Part of [the plan](../README.md). This is build-order step 3: it replaces step 2's minimal registered renderer stub with the real browser renderer and watch surface, and it is the first production exercise of the platform's simultaneous frontend paths. The hands-on surface is a live match watched in the browser and explored close up, its replay scrubbed to exact frames, and `npm run play` showing a local watch-mode day.

## Why this is its own seam

The collision overlay is a permanent viewer feature, not scaffolding: toggled on, it shows the game at collision truth, which is what students need when their villager gets stuck. Shipping the renderer, the overlay, and the camera before any art proves the whole watch surface complete and seek-safe, turns the registered stub into the real viewer, and gives step 4 the tool it uses to iterate on village generation visually. The camera ships here because its machinery already exists in the shared renderer base; this stage only mounts it, and step 5.2 tunes its limits under the final art and HUD.

## What to build

### The shared tiled-map base

Tile-map rendering joins the shared renderer base as `frontend/src/renderers/base/tiled-ground.ts`, wrapping [pixi-tiledmap](https://github.com/riebel/pixi-tiledmap) behind a project-owned API. The fork requires pixi.js 8.7 or later and the project ships 8.19. The dependency is pinned exact in `frontend/package.json`, because the packed map is the only drawing path: a Pixi upgrade the fork cannot follow has to be taken deliberately rather than arriving with a patch release. The wrapper API is the contract: environments never import the library, so replacing that path later (with a plain per-cell sprite grid, or another library) reaches no environment renderer.

- `TileGrid`: a column count plus row strings of single-character ground codes, row-major.
- `GroundTileset`: a tile size and, per code, one texture or an ordered list of variant textures. `solidColorTileset(colors)` builds a one-variant set from flat 2D-canvas fills, no assets and no GPU.
- `createTiledGround(grid, tileset, {cellSize, variant?})` validates the grid against the tileset and returns the drawn ground layer: a positioned `view` container, `setTile` for single-cell repaints, and `destroy`. `variant(code, column, row)` deterministically picks among a code's textures and defaults to the first; step 5.1's seeded wash variants ride this hook unchanged.

Grid and tileset validation is pure and tested under jsdom, where the suite also builds a small packed ground to keep the one drawing path exercised. Real pixels stay the browser suite's job, since a renderer's own drawing sits behind the base class's headless guard.

### The renderer package

`environments/three_branches/renderer/` replaces the stub, keeping the `three-branches-village` key and the automatic discovery contract (the frontend globs `environments/*/renderer/index.ts`, so no registration edits). The thumbnail stays the stage 2 placeholder until step 5.1's art pass. The package mirrors the Skirmish at Crane Reach split: pure modules with no Pixi imports carry the logic and are unit-tested under jsdom, and Pixi modules only draw.

| Module | Responsibility |
| --- | --- |
| `overlay.ts` | The strict decoder mirroring `overlay.py`: `decodeStatic(header)` and `decodeDynamic(state, static)`, enforcing the same validations (key sets, record lengths, base36 ranges, the movement cap, use implies stillness, a single prop holder, terminal only on tick 1200) and producing the same friendly JSON in meters and words |
| `geometry.ts` | The closed-form pieces the view needs that the overlay does not carry: building wall segments with the 1.2 m doorway gap removed (the `layout.py` formula), rotated footprint corners, heading-tick endpoints |
| `scene.ts` | `computeScene(state, staticOverlay)`: the pure drawable scene and the placeholder palette. The static part (tile rows, building outlines, prop rectangles, scenery, bridges, spawn) is computed once per static overlay and cached by reference; the dynamic part carries characters, prop states, and the chrome strings, every drawable keyed by its stable id. Labels come from `../props.json` and `../rules.json`, imported as JSON modules the way the crane renderer imports `tile_types.json` |
| `collision.ts` | `computeCollisionScene(state, staticOverlay)`: the collision-truth drawables listed under the overlay below. Pure, and untouched by step 5.1's art swap |
| `ground.ts` | Pixi: expands the decoded 100 ground rows into a `TileGrid`, builds the palette's `solidColorTileset`, and mounts the shared tiled base |
| `village.ts` | Pixi: the static placeholder layer above the ground, drawn once per static overlay: building fills and outlines, bridge decks, scenery circles, the spawn marker |
| `props-layer.ts` | Pixi: per-state prop rectangles and state labels, reconciled by prop id; the seam step 5.1's stills and sustained animations replace |
| `characters.ts` | Pixi: per-state reconciliation of the cast by character id: 0.4 m circles with a heading tick, id, and expression label |
| `collision-layer.ts` | Pixi: draws `collision.ts`'s scene, visible while the viewer has the overlay on |
| `chrome.ts` | Pixi: the screen-fixed strip (tick, phase, bell state, terminal banner) and the in-canvas collision toggle button, whose rectangle it exports so tests can press it by name |
| `index.ts` | The `PixiRenderer` subclass: the world container tree, the shared camera mount, the toggle state, the probe attributes, and the `RendererDefinition` export |

World space uses 16 units per meter, the authoring scale step 5.1 fixes, so art assets land at scale 1. The decoder stays in meters and the scene layer converts through one exported constant; ground cells are 16-unit squares. `internalSize` becomes 1200 by 1000, a near-square logical view for the square village with room for the chrome strip; the host lays out from `aspectRatio`.

The container tree is built for the art pass: `worldRoot` carries `gradedWorld` (ground, village statics, props, characters, in that order) and then the collision layer, with chrome outside `worldRoot` entirely. Step 5.1 inserts its wall bands, world-only phase grade, and emissives inside `gradedWorld` without restructuring, the collision overlay stays above the art and outside the grade as 5.1 requires, and the HUD later joins chrome unscaled and ungraded. One recording header pins one village for a whole session, so at mount the renderer decodes `ctx.header.overlay_static` once, retains it, and builds the ground, village statics, and the prop, character, and collision layers from it. Each step it decodes the dynamic overlay and updates those layers by stable id, so live play and a replay seek to the same state produce the same frame.

The browser suite reads renderer truth through data attributes on the container, the `data-crane-*` convention: `data-three-branches-ground` (ready), `data-three-branches-opening` (seen once the live tick 1 presentation renders), `data-three-branches-tick`, `data-three-branches-phase`, `data-three-branches-collision` (on or off), `data-three-branches-visitor` (the visitor position in centimeters), `data-three-branches-camera` (the shared `cameraProbeValue`), and `data-three-branches-terminal`.

### The camera

The shared camera modules carry the whole feature: `base/camera.ts` supplies limits, fit, clamp, pan, wheel and pinch zoom, and the world transform, and `base/camera-gestures.ts` wires the pointer and wheel events, both already proven by Skirmish at Crane Reach. The renderer feeds them the village bounds (the 100 m square in world units), fits against the masked content viewport below the 54-unit chrome strip, applies the resulting transform to `worldRoot`, and keeps chrome screen-fixed. The strip is outside the camera in both directions: the renderer answers the gesture module's `accepts` check with the content viewport, so pressing the collision button never also pans, zooms, or resets the view. The reset view is the fit: the whole village visible with nothing hidden, which is also the state every session and replay opens in. Zoom, pan, and pinch stay inside the module's clamped limits with its default zoom range; step 5.2 tunes the maximum zoom for expression and speech-bubble readability once the final art and HUD exist. `presentationFor` thresholds and other art-level zoom behavior are 5.1 and 5.2 concerns; this stage only guarantees the camera state is part of no scene computation, so a seek at any zoom renders the same world.

### The collision overlay

A viewer-toggleable overlay above the ground layer, at collision truth: building walls with their doorway gaps; water-bank segments split around bridge decks plus the bridge rails and confluence disks; the four world boundaries; scenery circles; props as footprint rectangles with state labels; and characters as 0.4 m circles with a heading tick, id, and expression label. Static segments use the engine's 0.05 m collision radius. Prop types and states label themselves from the same `props.json` the engine reads, and emote names come from `rules.json`. The overlay is on by default in this step, since until step 5.1 lands art it is the only depiction of characters and props; 5.1 revisits the default. The toggle is an interactive Pixi button inside the canvas, the pattern the crane order buttons set. It is view-only and never touches `sendAction`, so it works for spectators and replay viewers alike; keyboard access to it arrives with step 5.2's HUD pass.

### Speech

Chat is host chrome: NPC and visitor lines flow through `StepState.messages` to the shared chat panel, and the renderer draws nothing for them (speech bubbles are step 5.2). The e2e chat journey below is the consumer test for step 1's watcher visibility rule.

### Session limits

Step 1 landed the derived live-session duration in `backend/src/session/session-duration.ts`. For a cast_5 scripted watch day the ceiling resolves to 1200 ticks times 250 ms pacing, plus six agent episode budgets of 120 seconds, plus the 60 second platform allowance: 18 minutes over a roughly five-minute paced day. A unit case in the backend session-duration test pins the three_branches numbers through `resolveSessionMaxDurationMs`, so this environment's live day provably fits its derived default.

### Fixture and sidecar

`scripts/gen_three_branches_fixture.py` follows the `_fixture_common.run_and_copy` pattern: one unpaced harness day on the step 2 fixture village with the shipped builtins (the naive cast, the scripted visitor), Season 1 defaults (cast_5, daynight off), and seed 22, copied byte for byte to `frontend/test/fixtures/three-branches-recording.jsonl` (1,201 lines, about 1.2 MiB). Those lines are one header plus 1,200 recorded post-step states. The live tick 1 opening presentation is intentionally not part of the recording contract. The generator also writes a test-only sidecar, `frontend/test/fixtures/three-branches-decoded.json`: the Python `decode_overlay` output for the header static, the engine's derived wall segments per building, the compact overlay and friendly decode for the unrecorded tick 1 opening, and friendly decodes (with the repeated village stripped) for both recorded tick 1200 states, every 100th recorded tick, the first recorded frame, and every recorded frame where any character's expression or target changes. Each recorded sample carries its zero-based frame index. The sidecar is the cross-language drift guard: renderer tests assert the TypeScript decoder and `geometry.ts` reproduce it exactly.

The fixture is an interactive collision and rendering exercise: the naive cast performs its seeded random walk while the scripted visitor follows its route graph. Generation asserts that every cast member moves, at least one cast member stalls after walking begins, the visitor waves, and the recording carries the pinned tick-105 greeting from player 0 to player 2. No builtin uses a prop and the bell never rings. The fixture therefore carries seek determinism, the static village, simultaneous cast and visitor movement, collision contacts, waves, and speech, while renderer coverage of the other visuals (each emote, each prop-transition kind, the bell, the daynight phases, the terminal banner) comes from hand-authored compact frames and a synthetic daynight static in the unit tests, mirrored from `test_overlay`'s vocabulary.

### The e2e group

`frontend/e2e/three-branches/three-branches.spec.ts`; a directory with a spec under `frontend/e2e/` is the entire wiring. The [groups table](../../../docs/contributors/testing/browser-e2e.md#groups) gains a `three-branches` row. Two journeys, neither waiting out the day:

- Watch, explore, collision truth, stop, exact replay frames. Start a scripted watch from the environment page with a pinned seed, assert the live opening presentation renders at the fitted camera, assert the canvas paints and `data-three-branches-ground` reads ready, poll the tick attribute strictly increasing, drive a wheel zoom and a drag pan and assert the camera attribute changes and clamps, click the collision toggle and assert its attribute flips, stop the session, open the finalized replay, and scrub: the same seek twice yields identical tick and visitor attributes, and replay frame 1 renders the first recorded post-step state at the fitted camera.
- Watchers see every spoken line. The spades watcher-visibility pattern: spectator contexts with read-only chat panels see the visitor's canned lines live; after a mid-session reload, the live best-effort catch-up contains at most one copy because only the latest state is retained; and the recording supplies the exact line in replay and on the reopened ended-session page. The pinned seed must produce the first canned line within the opening ticks; picking it is a named implementation task.

Full-day coverage rides the fixture replay in the unit suite, because the day length is fixed and the design declares no length parameter.

## Tests

- `renderer/overlay.test.ts`: every malformed rejection mirrored from `test_overlay` (key sets, versions, record lengths, coordinate and heading ranges, movement above one meter, use with movement, two holders of one prop, a state out of range, terminal off tick 1200), and decoder isolation from consumer mutation.
- `renderer/agreement.test.ts`: the TypeScript static decode equals the sidecar's Python decode, `geometry.ts` wall segments equal the engine's, and every sidecar frame decodes equal.
- `renderer/scene.test.ts`: seek-anywhere determinism over the fixture (recompute an already-visited frame after replaying every state and compare deep-equal, with static reference identity), the palette covering exactly `rules.json`'s ground codes, label pins from the shared JSON, chrome pins from synthetic frames (each emote, each prop state, the bell, each daynight phase, the terminal banner), and an all-frames wall-clock budget.
- `renderer/collision.test.ts`: the doorway gap splitting a perimeter into up to five segments; exact water-bank, bridge-opening, bridge-rail, confluence, boundary, scenery, prop, and character shapes; rotated footprint corners; segment and circle scale; heading-tick geometry; and stable ids and labels.
- `renderer/camera.test.ts`: the village bounds in world units, the fitted reset containing every layout point below the chrome strip, the default zoom range, and the probe value format. The reducers themselves stay covered by the shared `frontend/test/camera.test.ts`.
- `renderer/chrome.test.ts`: the collision toggle centered where the browser journey presses it, and inside the strip. The journey has no DOM control to locate, so a moved button fails here in milliseconds instead of as a press that lands on nothing.
- `frontend/test/tiled-ground.test.ts`: grid and tileset validation, unknown-code and bounds rejection, span math, deterministic variant selection, and the packed layer's repaint, bounds, and single release.
- `scripts/tests/test_gen_three_branches_fixture.py`: regenerate the recording and decoded sidecar in a temporary directory and require both to remain byte-identical to the checked-in fixtures.
- The backend session-duration unit case pinning the derived three_branches limit.
- The two Playwright journeys above.
- While iterating, run the `three-branches` browser e2e group. Before handoff, run the bare full browser e2e suite.

## Build order

Seven milestones, each ending green:

1. Shared tiled base: pixi-tiledmap pinned and verified against the shipped Pixi, `tiled-ground.ts`, its unit tests.
2. Fixture and sidecar: the generator script, the pinned recording, the decoded sidecar.
3. Decoder: `overlay.ts` and `geometry.ts` with the rejection and agreement suites.
4. Pure scenes: `scene.ts` and `collision.ts` with determinism, labels, synthetic-frame chrome, and the perf budget.
5. The renderer: the Pixi layers, chrome, toggle, camera mount and gestures, probe attributes, and the `index.ts` swap. Hands-on: `npm run play` shows a local watch-mode day explored close up.
6. The e2e group: both journeys, the pinned chat seed, the groups-table row.
7. Handoff: the session-duration pin, the bare full browser e2e run, and the done-when sweep.

## Done when

A live match renders in the browser and can be panned and zoomed within bounds, its replay scrubs to exact frames, `npm run play` shows a local watch-mode day, and the bare full browser e2e suite passes.
