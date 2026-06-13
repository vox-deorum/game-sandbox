# Rendering

This page is the authority for how environments are drawn in the browser: the renderer contract, the PixiJS base class every renderer inherits, the sizing-and-scaling model, the input plumbing, and the rule that keeps live play and replay byte-for-byte identical. [frontend.md](frontend.md) covers the package around it (the hosts, the routing, the identity layer) and points here for the renderer itself.

The renderer is built so that adding a new environment's visuals is one self-contained class. Flappy Bird is the first renderer, but it is an example, not the shape of the system — everything here is designed for the environments that come after it (board games, grid worlds, multi-agent boards), not for one falling bird.

## Why PixiJS

The first renderer drew into a raw 2D canvas. That was enough for flat vector shapes, but it pushed three concerns onto every future renderer that none of them should have to solve again: rasterizing shape-by-shape on a `CanvasRenderingContext2D`, hand-managing device-pixel-ratio sharpness, and re-deriving a responsive size from rendered pixels. PixiJS (v8, WebGL with a WebGPU path) is the shared substrate that absorbs all three. It gives us a retained scene graph (display objects that persist and are mutated, rather than a surface cleared and repainted every frame), GPU compositing, a high-DPI story (`resolution` + `autoDensity`), and a federated event system for pointer input. The base class wraps PixiJS so a renderer subclass writes game drawing and nothing else.

PixiJS is a browser-only, GPU-backed dependency; it never reaches the recording parser or any Node code, so the bundle rule the replay viewer depends on (no Ajv, no `node:fs` — see [frontend.md](frontend.md)) is unaffected.

## The contract

The contract lives in `renderers/types.ts`. A renderer is handed its context once, draws each state, and is torn down once:

```ts
interface RendererContext {
  container: HTMLElement                       // the region the renderer owns
  meta: EnvironmentMeta                        // pace interval, slots, display name
  header: RecordingHeader                      // environment, schema_version, seed
  controlledSlots: readonly string[]           // empty when spectating or replaying
  sendAction?: (slot: string, action: unknown) => void  // absent outside live human play
}

interface RendererInstance {
  readonly internalSize: { width: number; height: number }  // the logical space the renderer draws in
  readonly aspectRatio: number                 // width / height; the layout-facing shape
  render(state: StepState): void               // draw one step
  destroy(): void                              // tear down once
}

interface Renderer {                           // the static side of a renderer class
  mount(ctx: RendererContext): RendererInstance
}
```

A renderer is **one class**: the `PixiRenderer` subclass _is_ the `Renderer` the registry stores. Its static side is just `mount` (the factory); a renderer's shape — `internalSize` and the derived `aspectRatio` — rides on the mounted `RendererInstance`. There is no separate module object to keep in sync with the class. The home-card thumbnail is not on the renderer at all: it is a static SVG asset (e.g. `flappy-bird/thumbnail.svg`) passed alongside the class to `registerRenderer`, so the cards never mount a renderer to show its art.

Two declarations replace the single `targetCanvasSize` of the 2D era, and the difference matters:

- **`internalSize`** is the fixed logical coordinate space the renderer draws in (Flappy Bird's is `288 × 512`). The renderer's code only ever speaks these coordinates; it never sees a device pixel. The base class scales this space onto whatever real size the host gives it.
- **`aspectRatio`** is `internalSize.width / internalSize.height`, surfaced explicitly because it is the shape the host reasons about: it sizes the stage element with a CSS `aspect-ratio` and places the decision log beside a portrait canvas (`aspectRatio < 1`, a column is left free) or below a landscape one. The base derives it from `internalSize` with a getter, so a renderer only ever declares `internalSize` and the two can never disagree.

Two rules give the architecture its properties.

- **Determinism.** `render(state)` must draw a frame that is a pure function of `state` (plus the mount-time header and metadata) — no dependence on what was rendered before. This is the property the replay scrubber relies on: jumping to tick 200 must look identical whether you played forward to it or scrubbed backward to it. Retained-mode drawing does **not** weaken this; see [the scene graph](#the-retained-scene-graph-and-determinism) below.
- **The chrome split.** The renderer owns the game frame — the world plus the in-game UI that belongs inside the game (score, tick, in-world status). The hosting page owns the session chrome that must work for every environment: the status strip, the pause/stop controls, the active-timeout display, the decision log, the end-of-session card. That split is what lets the live and replay hosts be built once, for every future environment.

`registry.ts` maps the environment metadata's `renderer` key to its renderer class and home-card thumbnail; `index.ts` is the registration barrel `main.ts` imports. The thumbnail is the SVG asset the barrel passes to `registerRenderer` alongside the class, with a placeholder (`renderers/placeholder.svg`) for an environment whose renderer is not registered yet.

## The base class

`PixiRenderer` (abstract, in `renderers/base/`) is the `Renderer`/`RendererInstance` in one: its instances implement `RendererInstance`, and its static side is the `Renderer` the registry stores. It carries everything common to every environment, including the static `mount` factory and the `aspectRatio` getter derived from each subclass's `internalSize`. A subclass inherits it and supplies only the game.

The base class owns:

- **The PixiJS application lifecycle.** It constructs the `Application`, runs the async `init()` (PixiJS v8 initializes asynchronously), appends the canvas to the container, and tears it all down on `destroy()`. `render(state)` calls that arrive before `init()` resolves are not lost: the base caches the latest state and applies it the moment the app is ready.
- **The internal→actual scale.** A single root container is scaled so that one internal unit maps to the right number of CSS pixels for the current size. Subclasses add their display objects to this root and draw in internal coordinates; the scale is the base's concern alone.
- **Resize in place.** A `ResizeObserver` on the container drives a debounced resize: on a settled size change the base calls `renderer.resize(...)` to the new actual resolution, re-applies the root scale, and re-renders the cached latest state. The PixiJS app and its GPU context survive — no teardown, no flash. (This is the responsive "re-launch on rect change" goal, met without an actual relaunch; because `render` is deterministic, a true teardown-and-remount would also be correct, but resizing in place is cheaper and flicker-free.)
- **Input plumbing.** It wires the device input a renderer declares (see [Input](#input)), but only for the owner of a live human session, and tears the listeners down on `destroy()`.
- **The headless guard.** Under jsdom (unit tests) there is no WebGL or WebGPU context, so the base skips PixiJS initialization entirely and `render`/`destroy` become no-ops. This is the direct heir of the 2D renderer's "tolerate a null context" rule: pixels are the end-to-end suite's job, and the pure scene layer stays unit-testable without a GPU.

A subclass implements three protected hooks:

- `setup(root)` — build the persistent display objects once (containers, the `Graphics`/`Sprite`/ `Text` nodes the game needs). Called after the app is ready.
- `update(state)` — mutate those display objects so the frame matches `state`. Called for every `render(state)`. This is where the per-step drawing logic lives, and it must be deterministic.
- `inputs()` — declare the device-input intents (optional; renderers with no human control omit it).

## Sizing and scaling

The renderer declares the shape it wants; the runtime decides the pixels. The flow:

1. The renderer declares `internalSize` (its logical coordinate space) and, by derivation, `aspectRatio`.
2. The host lays out the stage element at that aspect ratio, capped to the available width (and, on the live/replay stage, leaving room for the decision log beside a portrait canvas). The element's real CSS size is therefore decided by responsive layout, not by the renderer.
3. The base class reads the element's content-box size and initializes the PixiJS app to it with `resolution: window.devicePixelRatio` and `autoDensity: true`, so the backing store is sharp on high-DPI displays while the CSS size matches the element.
4. The base scales the root container by `cssWidth / internalSize.width` so the renderer's internal coordinates fill the surface exactly. Because the aspect ratios agree, this single uniform scale needs no letterboxing.

When the element's size changes — a window resize, the decision log moving from beside to below at a breakpoint, a panel collapsing — the `ResizeObserver` fires, the base debounces, then resizes the renderer and re-applies the scale. The renderer subclass is never told the size changed; it keeps drawing in internal coordinates and the frame simply lands at the new resolution.

This keeps the responsive policy in one place. A renderer cannot get DPI sharpness wrong, cannot fight the layout for size, and cannot drift out of aspect — those are the base class's invariants, the same for every environment.

### Crisp text under the root scale

The single root scale is what keeps a renderer in internal coordinates, but it is also a trap for one kind of display object. The scale magnifies the whole scene graph, and the two node families react to that differently:

- **`Graphics` are vector.** Their geometry is GPU-tessellated and the scale is applied in the vertex shader, so they re-rasterize sharply at the framebuffer resolution at any scale. The base's `resolution: devicePixelRatio` + `autoDensity` is all they need.
- **`Text` bakes a bitmap.** A `Text` node rasterizes its glyphs once into a texture at the app's `resolution` (i.e. `devicePixelRatio`), and the root scale then *magnifies that bitmap*. Whenever the host lays the element out larger than `internalSize.width` — which the Flappy Bird stage does, the element running up to `480px` against a `288`-unit space — the scale is `> 1` and the baked text is upscaled into softness. This is the most common "why isn't it crisp?" once the geometry already looks right.

The base solves this generically: `textResolution()` returns `devicePixelRatio × scale`, the device-pixel density a `Text` must bake at so its texture's native size matches its on-screen size. A renderer assigns `node.resolution = this.textResolution()` when it applies a `Text`. Because a resize re-runs `update`, the renderer re-reads it on every frame and it tracks the live size with no extra wiring — set it wherever you set the text's other style, and the HUD stays as sharp as the vector art around it. (Flappy Bird does this in `applyHud`.)

## The retained scene graph and determinism

PixiJS is retained-mode: you create display objects once and mutate them, rather than clearing a surface and repainting it each frame. The previous renderer was immediate-mode (`computeScene` → `paint`, rebuilding everything per state). Reconciling the two is the central design point, and it is done by splitting drawing into a pure description and an idempotent application of it:

- **`computeScene(state, config): Scene`** stays a pure function — one state in, one plain-data `Scene` out (a list of drawing primitives and HUD text, in internal coordinates), with no canvas and no accumulated history. This is where the drawing _logic_ lives, and it is unit-tested in plain Vitest under jsdom, exactly as before. The same state always yields the same scene.
- **`update(state)`** computes the scene and **reconciles** the retained PixiJS objects toward it: for each element in the scene it creates the display object if missing, sets its properties from the scene, and removes display objects the scene no longer contains (e.g. a pipe that scrolled off).

The determinism rule is therefore preserved, restated precisely: a frame is a pure function of state because the `Scene` is a pure function of state and the reconciliation toward a given `Scene` is idempotent. "No accumulated history" becomes "the visible result depends only on the current state," not "throw the scene graph away every frame." Retained objects are an implementation detail beneath a deterministic surface — which is exactly what the replay scrubber needs and what the immediate-mode version gave at the cost of rebuilding everything 20 times a second.

The split is also still the testing seam: `computeScene` is pure and unit-tested; the reconciler touches the GPU and is covered by the end-to-end suite. A checked-in recording feeds the scene-computation tests, so any visual logic has a byte-identical input to reproduce against.

## Input

Renderers that allow human control declare their input intents from `inputs()`; the base class wires them, and only for the owner of a live human session — `sendAction` present **and** at least one of the renderer's slots in `controlledSlots`. Spectators and the replay viewer mount the same renderer with no `sendAction` and get a draw-only instance with every input path inert. This is the same capability rule as before, lifted out of each renderer and into the base.

An intent maps a device gesture to an action sent through `sendAction`. The base handles the mechanics every renderer would otherwise repeat: keyboard listeners on `window`, pointer and touch through PixiJS's federated events on the stage, `preventDefault` so the game surface does not scroll or zoom the page, auto-repeat suppression so a held key is one action and not a stream, and teardown on `destroy()`. A renderer says "Space, ArrowUp, or W, and a pointer or touch on the stage, all mean `flap`"; it does not write listener bookkeeping.

A renderer never sends a no-op: the container applies the environment default for a step with no input, and the harness latches the latest input per pace interval, so sending only meaningful actions is both sufficient and minimal.

## Adding a renderer

This is the page a new environment lands on. To give an environment its visuals:

1. Write a class under `src/renderers/<env>/` that extends `PixiRenderer`. Declare its `internalSize` (an instance field), build its persistent display objects in `setup`, mutate them from state in `update` (keep the per-state logic in a pure `computeScene` so it is testable in jsdom), and, if it is human-playable, declare its input intents in `inputs`. The class is the `Renderer`: `mount` and the derived `aspectRatio` come from the base, so `internalSize` is all the class supplies.
2. Add a `thumbnail.svg` next to the class so the home card shows the environment's art instead of the placeholder.
3. Register it in the barrel `src/renderers/index.ts` (the one `main.ts` imports): `registerRenderer("<renderer-key>", YourRenderer, yourThumbnail)` with the environment metadata's `renderer` value, the class itself, and the imported SVG.

Adding an environment's visuals is one frontend class plus a thumbnail and zero metadata or host changes.

## The Flappy Bird renderer

`renderers/flappy-bird/` is the first renderer and the reference for the rules above. It declares an `internalSize` of `288 × 512` (a `9 / 16`-ish portrait surface, so the host seats the decision log in the column it leaves free) and draws entirely from the per-step overlay, which carries the whole truth in unnormalized screen pixels: the surface `width`/`height`, the `player` (`x`/`y` top-left, `vel_y`, `rot`), the `pipes` (`x` left edge, `gap_top`/`gap_bottom`), and `pipes_passed`. The art is original flat-color vector drawing — no sprites from the original game ship here.

It keeps the pure/retained split: `computeScene(state, config)` turns one `StepState` into a `Scene` (sky, pipes, ground, the bird, and the HUD — the big score, the pipe counter, and a paced time/tick readout), and the renderer's `update` reconciles PixiJS `Graphics` and `Text` nodes toward that scene — scrolling the existing pipe nodes, adding one as a pipe enters and removing one as it leaves, rather than rebuilding the world each frame.

Input is raw device input: Space, ArrowUp, or W (auto-repeat ignored), and a pointer or touch on the stage, each map to `flap` and send `sendAction("player_0", 1)`, which the host wraps in an `input` command. Wired only for the live owner; draw-only for everyone else.

## Notes for the 2D-era reader

If you know the previous renderer, here is what moved:

- `paint(ctx, scene)` (a 2D rasterizer) is gone; its role is now the retained reconciler inside `update`. `computeScene` and the `Scene` type are unchanged in spirit and still unit-tested.
- `targetCanvasSize` is replaced by `internalSize` + the derived `aspectRatio`. The host reads these the same way it read `targetCanvasSize` (CSS aspect-ratio on the stage element, log beside vs. below), so the page layout logic is a rename, not a rewrite.
- Per-renderer canvas CSS (`flappy.css`'s `width:100%; height:auto`) is now a base-class concern: the base assigns a stable class to the PixiJS canvas and owns its presentation. The end-to-end suite locates the canvas; the locator moves with it (from `canvas.flappy-canvas` to the base class's canvas class), and the watch/journey specs assert visibility against the new selector.
