# Step 4.3: Camera

Status: complete. The owner approved the shared camera boundary, map-style gestures, screen-fixed HUD, and double-click or double-tap reset on 2026-08-06. Implementation and verification finished on 2026-08-06.

Part of [the Skirmish at Crane Reach plan](../README.md). This is build-order step 4.3: a fitted view of the entire battlefield that a spectator can pan and zoom. It follows the [art style](4-1-art-style.md) and [HUD](4-2-hud.md), and it keeps their scene geometry and screen layout unchanged.

## Outcome

The battlefield fills the 1200 by 860 logical view as closely as its shape allows while every non-void tile remains visible. Wheel, pointer drag, and two-pointer pinch gestures move through the field. Double-click or double-tap restores the fitted view. The board moves below the top and bottom HUD strips, while the HUD and inspection layer remain fixed to the screen.

Zoom participates in the existing presentation ladder. The renderer passes the effective CSS hex radius, base display scale times camera zoom, to `presentationFor`. A wider or closer view therefore promotes compact marks to tokens and tokens to figures without changing the scene or board geometry.

## Shared camera boundary

The reusable implementation lives in `frontend/src/renderers/base/` as two modules:

- `camera.ts` owns pure camera state, fit and clamp rules, point projection, wheel normalization, pan, anchored zoom, and pinch reduction. It imports neither PixiJS nor the DOM.
- `camera-gestures.ts` owns DOM pointer, wheel, double-click, and double-tap wiring. It knows nothing about PixiJS and reports view-space intents to a renderer.

Renderers compose these modules when they need a movable world, in the same way that Hearts and Spades compose the shared card-table renderer. `PixiRenderer` remains unchanged.

Camera state is `{ zoom, x, y }`, where `x` and `y` name the world point at the view center. The limits contain the padded world bounds and minimum and maximum zoom. For view width `Vw`, view height `Vh`, padded world width `Bw`, and padded world height `Bh`:

```text
fit = min(Vw / Bw, Vh / Bh)
minZoom = fit
maxZoom = 4 * fit
```

The world bounds receive 20 logical pixels of padding on each side. Reset uses the fit zoom and the padded bounds center. At fit zoom, panning is a no-op and reset is the unique minimum-zoom state. At larger zooms, each axis stops when the padded edge reaches the corresponding view edge. An axis stays centered whenever the view covers that full padded extent.

Wheel zoom uses `exp(-delta * 0.0015)` on pixel deltas, converting line deltas at 16 pixels and page deltas at 384 pixels. Cursor zoom keeps the world point below the cursor fixed. Pinch uses the distance ratio for zoom, keeps the midpoint anchored, and also applies midpoint movement as a pan. All point calculations use the renderer's 1200 by 860 logical view.

## Renderer composition

Crane groups its battlefield, zone marker, range, unit, activation, event, and transient layers into one `worldLayer`. The root contains the moving world, then the fixed HUD, then the fixed inspection layer.

When the battlefield key changes, the renderer computes a bounding box from every non-void tile center plus its hex extents, rebuilds the camera limits, and resets before the first reconciliation. The camera transform is applied to `worldLayer` only. The renderer redraws the retained frame immediately after a camera change and rebuilds zoom-dependent unit art after a 100 ms debounce.

The host element carries `data-crane-camera` in the form `zoom@x,y`, rounded to two decimal places for zoom and whole logical coordinates for the center. Inspection coordinates are projected into view space, so browser tests and inspection cards follow units after pan and zoom. Dragging suppresses Pixi-generated inspect and dismiss taps, but hover inspection remains active.

## Gestures and teardown

The canvas owns touch gestures and sets `touch-action: none` on its host. Wheel prevents the page from scrolling. Pointer down cancels the browser's mouse defaults, so a drag that leaves the canvas cannot select page text, while clicks and double-clicks still fire. A pointer drag begins after 4 CSS pixels of movement. Pointer movement and release are observed on `window`, without pointer capture, so Pixi hover continues to work. The drag flag remains set through the canvas `pointertap` and clears on the later window `pointerup`.

Two active pointers drive pinch. Pointer cancellation and window blur clear gesture state. Two taps within 300 ms and 30 logical view pixels reset the camera. Native double-click resets it as well. Destroying the renderer removes every listener and clears the delayed art rebuild.

## Step 5 input seam

[Step 5](5-human-play.md) must make order input interactive through objects inside the transformed Pixi world container. It must rely on Pixi's transformed hit testing and must not derive board coordinates directly from raw canvas positions.

## Tests

Shared unit tests cover fit math, clamp edges, fit-zoom pan locking, anchor invariance for wheel and pinch zoom, wheel delta modes, transform and projection agreement, probe formatting, gesture thresholds, reset, touch ownership, and listener teardown.

Crane presentation tests pin token art at the fitted desktop scale for both fixture board sizes and figure promotion after additional zoom. The Crane browser journey covers the default camera probe, responsive presentation levels, wheel zoom, drag pan, tap suppression, inspection after projection, reset, and preservation of the single battlefield build.

## Done when

Both fixture boards load fitted with every tile visible and token art at ordinary desktop widths. Zooming further in promotes tokens to figures. Wheel, drag, pinch, and both reset gestures work without moving the HUD. Inspection follows the transformed unit position and no tap opens a card at the end of a drag. Camera reducers and DOM wiring pass their unit suite, Crane's presentation pins pass, the Crane browser journey passes, and the full frontend browser suite remains green.
