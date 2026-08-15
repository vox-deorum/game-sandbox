# Step 3: Configurable renderer, watch, and replay

Status: in progress.

Part of [the plan](../README.md). This step replaces step 2's registered renderer stub with the provisional village viewer. It supports live watch, replay, local watch, a diagnostic collision overlay, and a visitor-focused camera. Final art, speech bubbles, and human input remain in later steps.

## Configuration contracts

The renderer treats the recording header, `rules.json`, and `catalog.json` as authoritative. It does not restate frame dimensions, ground codes, building counts, character radius, prop states, catalog contents, phases, or day length as renderer rules.

`overlay_static` is read once at mount. It contains the configurable size, south-first ground rows, buildings, props, scenery, and visitor spawn. The player roster remains in the recording header. Dynamic overlays contain tick, phase, ordered characters, prop states, and terminal state. A live opening with no dynamic overlay is valid before the first completed transition.

The recording uses one canonical identity space. `player_0` is the visitor and each later contiguous `player_i` is an NPC. Header keys must match `player_(0|[1-9][0-9]*)` and form the exact sequence `player_0` through `player_n`. Dynamic character ids must match that sequence exactly and in order. Speech endpoints must be exact roster members, except that a null recipient remains a broadcast. No renderer path normalizes ids or accepts the legacy `visitor` and `npc_i` aliases. Public renderer data contracts live in `renderer/types.ts`, separate from parsing and Pixi code. Exported contracts and their public members have concise JSDoc.

Configured metres become renderer units through shared conversion helpers. South-first, north-up environment coordinates become Pixi's downward y-axis only at the rendering boundary. Comments explain this inversion where it occurs.

## Shared tiled ground

`frontend/src/renderers/base/tiled-ground.ts` keeps single-grid callers compatible and adds:

- ordered `options.layers` packed into the same `TiledMap` as the base;
- a reserved space character for transparent overlay cells; and
- an eight-bit same-code neighbour mask passed as the fourth variant argument, with N=1, NE=2, E=4, SE=8, S=16, SW=32, W=64, and NW=128.

`setTile(column, row, code)` still repaints only its base target cell. Grid, layer, and tileset validation remains usable without mounting Pixi.

## Renderer package

`environments/three_branches/renderer/` uses pure parsing, scene, collision, and camera modules followed by retained Pixi display layers.

| Module | Responsibility |
| --- | --- |
| `types.ts` | Documented public static, dynamic, scene, coordinate, collision, and terrain data contracts |
| `overlay.ts` | Header and dynamic overlay parsing plus rules and catalog access |
| `presentation.ts` | Tunable canvas, world scale, camera values, and provisional diagnostic palette |
| `scene.ts` | Config-derived static scene, coordinate conversion, and pure frame computation |
| `collision.ts` | Pure static and dynamic collision truth |
| `camera.ts` | Visitor focus, inspection suspension, live return, and recenter policy over the shared camera reducer |
| `map-layer.ts`, `buildings.ts`, `props-layer.ts`, `characters.ts` | Layered ground and stable retained scene objects |
| `collision-layer.ts`, `chrome.ts` | Off-by-default collision drawing and the village information chrome |
| `index.ts` | `PixiRenderer` lifecycle, gestures, probes, and automatic renderer definition |

Presentation defaults are named in one configuration: a 1200 by 1000 logical canvas, a 54-unit chrome strip, 16 renderer units per configured metre, camera padding and zoom range, and a visitor opening zoom of twice the fitted zoom. These are presentation choices that step 5 can tune. Tests check semantic coverage and relationships rather than pinning palette values or map dimensions.

One layered-ground call paints a configured fill base, a landscape overlay, and a structure overlay. Classification uses ground properties and semantic names, not a fixed code alphabet. Ground already records floors, walls, and doorways, so the renderer does not reconstruct building walls.

Static display objects are built once. Props and characters reconcile by stable id, so a replay seek depends only on the delivered header and state. Delivered character positions and headings interpolate across the host's actual tick cadence. Replay scrubs and explicit seeks still snap, and this state motion does not honor reduced-motion preferences. `worldRoot` contains the map, buildings, props, characters, and collision. Fixed chrome remains outside the camera transform.

The ordinary world art carries no text labels. The collision overlay ships off by default and supplies diagnostic object, state, character, and expression labels for watch, replay, and play. Its text resolution follows camera zoom. It derives impassable cells from ground passability, object shapes from the catalog, boundaries from the configured frame, and character circles from the configured body radius. Prop facing may add a visual direction marker. An east or west facing trades a prop rectangle's width and height, matching the environment, and every shape stays axis-aligned. The toggle never resets the camera. Its plate is drawn in the chrome strip and clicked in the browser's own coordinates, the way the camera gestures are: the gestures accept only the content below the strip, and the strip answers the band above it. Nothing here depends on display-object hit testing.

Environment-specific data probes expose readiness, opening state, tick, phase, visitor position, collision state, camera state, and terminal state. Tests and browser journeys assert state changes without pinning exact initial values.

## Visitor camera policy

The camera starts at `overlay_static.spawn` using the configured focus zoom, clamped to frame-derived limits. The first dynamic frame corrects the target to the recorded visitor position.

The camera opens on the visitor at the focus zoom and follows its movement on every state update. Pan, wheel zoom, or pinch suspends following for inspection. In watch and replay, the inspected view remains fixed until Recenter. In live visitor play, releasing manual camera control while the visitor is moving starts a gradual return to the visitor. Manual input cancels that return. The Recenter button, a double-click, or a double-tap centers on the current visitor immediately and resumes following. Return and Recenter both preserve the current zoom.

Full logical pointer coordinates are converted to the content-local viewport before calling camera reducers. Camera state stays outside pure scene computation.

Step 6 reads `ctx.controlledPlayers` to activate both visitor input and the live-play camera return.

## Fixture and local integration

`scripts/play.py` fills automatic seats with each resolved seat's `restricted_builtin`, falling back to `naive`. Three Branches local watch therefore assigns `scripted_visitor` to the visitor seat without a special environment branch.

`scripts/gen_three_branches_fixture.py` uses the real harness, seed 0, and current environment defaults. Since [step 4](4-village-generator.md), that seed's village is generated rather than the fixed map `fixture.py` holds, so the recorded ground, buildings, and props follow generation tuning and the script runs again at every gate close. It records until the configured terminal condition and uses fresh builtin entropy with bounded retries. Semantic checks require useful movement, visitor behavior, delivered speech, a terminal frame, and strict finite JSON. They do not require byte identity, exact ticks, or exact text.

The fixture exposed two Pymunk invariants. When a stopped kinematic character becomes dynamic, its configured mass and moment must be restored before contact solving. Collision bias remains Pymunk's one-second correction rate, with zero collision slop, so repeated movement into a wall cannot accumulate penetration and expel the body to the wrong side. Regressions keep positions finite, prevent wall crossing, and confirm a character can immediately move away from contact.

## Browser journey

`frontend/e2e/three-branches/three-branches.spec.ts` defines the `three-branches` group and is listed in the [browser groups table](../../../docs/contributors/testing/browser-e2e.md#groups). The focused journey starts a seed 0 watch session with the resolved scripted visitor, checks renderer probes and tick progress, exercises wheel zoom, the collision controls' isolation from the camera, and Recenter, stops through the UI, opens replay, and verifies stable visitor and tick probes across repeated seeks. Existing host coverage remains authoritative for general broadcast and direct-message visibility, and [step 6](6-human-play.md) adds the visitor's own journey with its controls.

## Focused verification

- Shared tiled-ground tests cover compatibility, layer ordering, empty cells, neighbour masks, validation, and target repaint.
- Renderer tests cover header and opening parsing, configuration-derived bounds, scene and collision geometry, tick interpolation, static reference reuse, seek determinism, camera follow, inspection suspension, gradual live return, and zoom-preserving Recenter.
- Python tests cover restricted builtin filling, fixture semantics, strict JSON, finite physics after a stop, and repeated wall contact.
- Frontend type checking covers the retained Pixi integration, and the Three Branches browser group covers its live and replay journey.

This step adds no exact session-duration regression, literal fixture length, wall-clock threshold, or mandatory full browser-suite run.

## Done when

A live watch session renders near the visitor, supports bounded camera gestures and the collision toggle, and opens as a deterministic replay. Local automatic filling uses the restricted visitor builtin, the generated fixture passes semantic checks, focused unit and browser checks pass, and this status is marked complete.
