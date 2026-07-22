# Rendering

Each environment has one browser renderer shared by live play and replay. Renderers use PixiJS through a common base class, draw from per-step state, and never inspect the live environment.

Read [the interaction specification](../specs/interaction.md) for the product contract and [Frontend](frontend.md) for the pages that host a renderer.

## Rendering model

```text
StepState → computeScene(state) → Scene → reconcile PixiJS objects → canvas
```

The important invariant is determinism: rendering a state must produce the same visible frame regardless of which state was rendered before it. A replay can therefore jump directly to any tick.

The renderer owns the game frame and environment-specific controls. The host page owns shared chrome such as connection status, pause, stop, the active timeout, decision log, result, and replay transport.

## Why PixiJS

PixiJS v8 provides:

- A retained scene graph.
- GPU compositing.
- High-DPI rendering through `resolution` and `autoDensity`.
- Pointer and touch events.

The shared `PixiRenderer` base handles those concerns so environment modules focus on game visuals. PixiJS stays in the browser renderer path and does not enter the recording parser or backend.

## Contract

The types live in `src/renderers/types.ts`:

```ts
interface RendererContext {
  container: HTMLElement
  meta: EnvironmentMeta
  header: RecordingHeader
  controlledSlots: readonly string[]
  sendAction?: (slot: string, action: unknown) => void
}

interface RendererInstance {
  readonly internalSize: { width: number; height: number }
  readonly aspectRatio: number
  render(state: StepState, options?: RenderOptions): void
  destroy(): void
}

interface RenderOptions {
  snap?: boolean
  transitionMs?: number
}

interface Renderer {
  mount(ctx: RendererContext): RendererInstance
}
```

The registry stores a `PixiRenderer` subclass. Its static `mount` method creates the instance. Registration also supplies a static SVG thumbnail for environment cards.

### Size declarations

| Value | Meaning |
| --- | --- |
| `internalSize` | Fixed logical coordinate system used by renderer code |
| `aspectRatio` | `internalSize.width / internalSize.height`, used by page layout |

The subclass declares only `internalSize`; the base derives `aspectRatio`.

## Base class responsibilities

`PixiRenderer` owns:

- Asynchronous PixiJS application setup and teardown.
- A root container that maps internal coordinates to CSS pixels.
- High-DPI backing-store resolution.
- Debounced `ResizeObserver` handling without recreating the GPU context.
- Caching the latest state until asynchronous setup finishes.
- Input listener setup and cleanup.
- A jsdom guard that skips GPU initialization during unit tests.

A subclass implements:

| Hook            | Purpose                                    |
| --------------- | ------------------------------------------ |
| `setup(root)`   | Create persistent PixiJS display objects   |
| `update(state)` | Make those objects match the current state |
| `inputs()`      | Optionally declare human-input intents     |

## Sizing and scaling

```text
internalSize
    ↓ determines aspect ratio
host lays out stage
    ↓ provides CSS size
base resizes PixiJS and uniformly scales root
```

The host controls responsive layout. The renderer always draws in internal coordinates and never reads device pixels.

The base initializes PixiJS with `window.devicePixelRatio` and `autoDensity: true`. It scales the root by `cssWidth / internalSize.width`. Matching aspect ratios avoid letterboxing.

When the stage changes size, the base resizes in place, reapplies scale, and renders the cached state.

### Text resolution

PixiJS `Graphics` remain sharp under root scaling because they are vector geometry. `Text` uses a rasterized texture and can become soft when enlarged.

Set each text node's resolution from:

```ts
node.resolution = this.textResolution()
```

`textResolution()` returns device pixel ratio multiplied by the current root scale. `update` runs again after resize, so text tracks the new size.

## Deterministic retained rendering

Retained mode does not permit history-dependent output. Keep the drawing logic in two layers:

1. `computeScene(state, config)` is a pure function that returns plain scene data.
2. `update(state)` reconciles persistent PixiJS objects to that scene.

The reconciler must be idempotent:

- Create a node when the scene first needs it.
- Set every visible property from the current scene.
- Remove nodes absent from the current scene.

Unit-test `computeScene` under jsdom with checked-in recording states. Cover GPU reconciliation and visible canvas behavior in the browser end-to-end suite.

## Animation between states

A renderer may animate the transition from one state to the next instead of cutting to it. This is opt-in so it never weakens the determinism above: `computeScene` still returns the static frame a scrubber lands on, and the animation is a separate layer the retained renderer runs on top.

A subclass that animates sets `animated = true` and implements `onFrame(dtMs)`, which the base drives off the PixiJS ticker. `update(state, options)` sets the new target and may begin a transition toward it; `onFrame` advances that transition (and any ambient motion) each frame and returns false once it settles, which stops the loop. A renderer that does not animate leaves `animated` false and is reconciled once per `render` and drawn, the draw-only path Flappy Bird uses.

The `RenderOptions` argument is how the host controls presentation. Live play passes none, and the renderer uses its own natural transition length. The replay transport passes its cadence as `transitionMs` while playing, so an animated transition runs at replay-time scale and fits inside the cadence, and passes `snap` on any scrub, step, or seek, since jumping to an arbitrary state must not trigger a transition. A draw-only renderer ignores `RenderOptions` entirely.

## Input

`inputs()` declares mappings from device gestures to environment actions. The base handles:

- Keyboard listeners.
- PixiJS pointer and touch events.
- Auto-repeat suppression.
- `preventDefault` where the game surface owns the gesture.
- Listener cleanup.

Input is enabled only when `sendAction` exists and the renderer controls at least one slot. Spectators and replay viewers mount a draw-only renderer.

Send meaningful actions only. The harness supplies the environment's default action when no input arrives.

`inputs()` fits a fixed gesture-to-action mapping such as a flap. On-screen controls whose action depends on where the gesture lands, such as a clickable card hand or board cell, instead make the relevant display objects interactive (an `eventMode` and a hit area) and send the action for the object that was clicked. A control is wired only when the renderer controls that slot and a `sendAction` exists, so spectators and replay viewers stay draw-only. Hearts is the reference for this: a legal card on the controlled seat's turn is clickable and plays itself.

The overlay carries semantic objects (a card is a `{"suit", "rank"}` object), so the scene draws, animates, and hit-tests them directly; encode a choice to its integer action (`cardToAction(card)`, `bidToAction(n)`, or Flappy's `1`) only at the `sendAction` boundary.

## Add a renderer

1. Create `src/renderers/<env>/`.
2. Add a class extending `PixiRenderer`.
3. Declare `internalSize`.
4. Create display objects in `setup`.
5. Put state-to-scene logic in a pure `computeScene`.
6. Reconcile the scene in `update`.
7. Add `inputs()` if humans can control the environment.
8. Add `thumbnail.svg`.
9. Register the class and thumbnail in `src/renderers/index.ts`.
10. Add unit tests and update the browser journeys.

No host or environment metadata changes are needed when the metadata already names the renderer key.

## Flappy Bird reference

`src/renderers/flappy-bird/` is the reference implementation.

- Internal size: `288 × 512`.
- Scene source: the per-step overlay.
- Drawing: original vector art with PixiJS `Graphics` and `Text`.
- Inputs: Space, ArrowUp, W, pointer, and touch map to flap.
- Tests: pure scene computation in Vitest, canvas behavior in Playwright.

Its `computeScene` describes the sky, pipes, ground, bird, score, pipe count, and time or tick display. `update` reuses pipe nodes as they move through the scene.

## Hearts reference

`src/renderers/hearts/` is the reference for a turn-based environment with on-screen input and animation.

- Internal size: `960 x 720`.
- Scene source: the per-step overlay (hands, current trick, per-slot penalty scores, turn, legal-action mask).
- Drawing: a browser-native PixiJS scene built from the semantic overlay.
- Input: a legal card on the controlled seat's turn is clickable and plays itself; illegal cards are greyed straight from the emitted mask, never a reimplementation of the rules.
- Animation: the trick-won sweep and the active-seat glow ride the base's `onFrame` loop and replay at replay-time scale.
- Tests: pure scene, replay, animation math, and hit-testing in Vitest; canvas behavior in the browser suite.

It also draws the move clock as a deterministic budget chip on the controlled human's turn, and reveals every hand only when spectating or replaying (no controlled slots), face-down otherwise.
