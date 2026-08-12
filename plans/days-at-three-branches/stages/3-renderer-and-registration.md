# Step 3: Renderer, collision overlay, watch and replay

Status: planned.

Part of [the plan](../README.md). This step replaces step 2's registered renderer stub with the production watch and replay surface. It is the first production use of the simultaneous frontend paths. A browser can watch a live day, explore the village, scrub exact replay frames, and show a local watch-mode day through `npm run play`.

## Scope

The permanent collision overlay shows collision truth. This step ships it with tile layers and camera before art. Step 4 uses the viewer for review. The shared camera machinery already exists; this step mounts it, and step 5.2 tunes limits with final art and HUD.

### Shared tile base

`frontend/src/renderers/base/tiled-ground.ts` keeps the project on one drawing path. Extend `createTiledGround` with:

- an ordered layer stack over one frame, with a reserved empty code, while preserving single-grid callers; and
- an eight-bit same-code neighbour mask passed to the `variant` callback for step 5.1's autotiler.

`setTile` remains unchanged. One unit case covers a repaint landing on the correct cell and rejecting an out-of-bounds cell. Layer and tileset validation stays pure and jsdom-tested with a small packed map. Browser tests cover pixels behind the renderer base's headless guard.

### Renderer package

`environments/three_branches/renderer/` replaces the stub under the existing automatic discovery glob. The thumbnail remains the step 2 placeholder until step 5.1. Pure logic has no Pixi imports and is unit-tested under jsdom; Pixi modules draw only.

| Module | Responsibility |
| --- | --- |
| `overlay.ts` | Recording types and mount-time `readStatic(header)` checks for frame, ground rows, and rosters |
| `scene.ts` | Cached static and per-state dynamic drawable scene, palette, labels from shared JSON |
| `collision.ts` | Pure collision-truth scene |
| `map-layer.ts`, `buildings.ts`, `props-layer.ts`, `characters.ts` | Pixi ground stack, semantic roofs, stable-id props and scenery, and stable-id character reconciliation |
| `collision-layer.ts`, `chrome.ts` | Overlay drawing; fixed tick, phase, bell, terminal strip and named collision-toggle rectangle |
| `index.ts` | `PixiRenderer`, container tree, camera, toggle, probes, and `RendererDefinition` |

The renderer does not expand building geometry. Ground rows already encode floors, walls, and doorways; semantic building rects come from origin and catalog footprint. Shared catalog helpers resolve prop footprint, shape, and art. World space is 16 units per cell, with a single exported metres-to-world conversion. `internalSize` is 1200 by 1000 and layout uses `aspectRatio`.

`worldRoot` contains `gradedWorld` (map, building statics, props, characters) followed by collision. Chrome is separate and screen-fixed. Step 5.1 can add roofs, phase grade, and emissives inside `gradedWorld`; collision stays above art and ungraded, and the later HUD joins chrome.

The header's `overlay_static` is read once at mount. The renderer retains it and builds static layers once; dynamic payloads update stable-id layers. Live play and seeks to the same state produce the same frame. Probes follow the `data-crane-*` convention: ground readiness, first live opening, tick, phase, collision state, centimetre visitor position, camera value, and terminal state.

### Camera and collision contracts

The shared `base/camera.ts` and `base/camera-gestures.ts` provide limits, fit, clamp, pan, wheel and pinch zoom, and transforms. The renderer follows these rules:

- uses the village frame as world bounds and fits it into the content viewport below the 54-unit chrome strip;
- transforms `worldRoot` only, keeping chrome fixed;
- accepts gestures only in that content viewport, so the collision button cannot pan, zoom, or reset the view;
- opens every session and replay at the fitted reset, with every cell visible; and
- uses the shared default clamped zoom range until step 5.2 tunes the maximum.

Camera state is not part of scene computation. A seek at any zoom draws the same world. Tests pin frame-derived bounds, fit, default range, and probe format. The shared camera reducer tests remain in `frontend/test/camera.test.ts`.

The toggleable collision overlay is above the map and depicts:

- every impassable ground cell, including water and building walls, while leaving doorways open;
- catalog-derived shapes for every interactive prop and scenery item, with interactive type and state labels;
- all four world boundaries; and
- every character body circle, heading tick, id, and expression.

It is on by default in this step so collision truth stays visible while the art is provisional, is view-only, and works for spectators and replay viewers. Step 5.2 settles the shipped default and adds keyboard access.

### Speech, duration, and fixture

Speech remains host chrome through `StepState.messages`; the renderer draws no bubbles until step 5.2. Messages are range-limited broadcasts or direct lines naming one addressee, and both require hearing range and an unblocked line. Watchers and replay see every delivered line. A visitor controller sees broadcasts delivered to `player_0` and direct lines sent to or received by `player_0`. Step 5.2 specifies the host controls, and step 6 implements them.

Step 1's live-duration contract is pinned in `backend/src/session/session-duration.ts`. A `resolveSessionMaxDurationMs` regression case pins the Three Branches default at 18 minutes: 1200 paced 250-millisecond ticks, six 120-second agent budgets, and the 60-second allowance. The roughly five-minute scripted watch day fits this derived limit.

`scripts/gen_three_branches_fixture.py` records an unpaced Season 1 cast_5 fixture day, with naive cast, scripted visitor, daynight off, and a pinned seed. It writes `frontend/test/fixtures/three-branches-recording.jsonl` with one header and 1200 post-step states. The live tick 1 opening is not a recording requirement. Step 4 regenerates the fixture at each gate.

The generator asserts fixture properties rather than fixed lines or ticks: every cast member moves, one stalls after beginning to walk, the visitor waves, and at least one line is spoken and delivered. The fixture covers the static village, simultaneous movement, collision contacts, waves, speech, and seek determinism. Hand-authored unit frames cover the remaining emotes, prop transitions, bell, daynight phases, and terminal chrome.

### Browser journeys

`frontend/e2e/three-branches/three-branches.spec.ts` creates the `three-branches` group. Add it to the [groups table](../../../docs/contributors/testing/browser-e2e.md#groups).

- The watch journey starts a pinned-seed scripted watch, checks its fitted live opening and ready canvas, observes increasing ticks, drives clamped zoom and pan, toggles collision, stops the session, then opens replay. Repeating a seek returns identical tick and visitor probes, and replay frame 1 is the first recorded post-step state at fit.
- The watcher journey uses the spades visibility pattern. Read-only spectators see delivered broadcasts and direct visitor lines live; a mid-session reload has at most one best-effort catch-up copy because only latest state is retained; replay and the reopened ended session show the recorded lines. It carries produced lines forward without pinning text or tick. Visitor-controller visibility of delivered broadcasts and direct lines sent to or from `player_0` stays in the shared host coverage until steps 5.2 and 6 add Three Branches controls.

The unit suite exercises the full fixture replay. No e2e journey waits out the day.

## Tests

- `renderer/overlay.test.ts` accepts the fixture header and rejects inconsistent ground, missing roster, and mismatched state counts.
- `renderer/scene.test.ts` checks seek determinism and static reference identity, ground-code palette, shared labels, hand-authored chrome states, and all-frame wall-clock budget.
- `renderer/collision.test.ts` checks impassable cells, open doors, catalog shapes and facings, boundaries, character geometry, stable ids, and labels.
- `renderer/camera.test.ts` and `renderer/chrome.test.ts` cover the camera contract and toggle hit rectangle.
- `frontend/test/tiled-ground.test.ts` covers layer stack, empty code, edge and corner neighbour masks, deterministic variants, and repaint.
- `scripts/tests/test_gen_three_branches_fixture.py` regenerates a byte-identical temporary fixture; the backend test pins the duration regression; and the two journeys above cover browser behavior, including watcher visibility for broadcasts and direct lines.

Run the `three-branches` e2e group while iterating and the bare full browser suite before handoff.

## Build order

1. Add the shared layer stack and neighbour hook with unit coverage.
2. Add the generator script and pinned recording.
3. Add pure overlay, scene, and collision modules with shape, determinism, label, frame, and performance suites.
4. Add Pixi layers, chrome, toggle, camera, gestures, probes, and the `index.ts` swap. Verify a local watch-mode day.
5. Add the e2e group and group-table row, duration pin, full browser run, and handoff sweep.

## Done when

A live match renders, pans, and zooms within bounds; replay seeks exact frames; `npm run play` shows a local watch-mode day; and the full browser e2e suite passes.
