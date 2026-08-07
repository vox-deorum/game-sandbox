# Rendering

Each environment has one browser renderer for both live play and replay. Renderers use PixiJS through a common base class, draw from per-step state, and never inspect the live environment.

Read the [interaction specification](../../specs/interaction.md) for the product contract and [Frontend](../frontend/development.md) for the pages that host a renderer.

## Add a renderer

1. Create `environments/<env>/renderer/` beside the environment package.
2. Add a `PixiRenderer` subclass and declare `internalSize`.
3. Put pure state-to-scene logic in `computeScene` and reconciliation in `update`.
4. Add `inputs()` when humans can control the environment.
5. Add one `thumbnail.svg` or `thumbnail.png`, default-export `{ key, renderer, thumbnail }`, and ensure the key equals `ENTRY.meta.renderer`.
6. Add renderer unit tests and update browser journeys.

`environments/flappy_bird/renderer/` is the reference for a realtime draw-only renderer, and `environments/hearts/renderer/` for turn-based card input and animation.

## Rendering model

```text
StepState -> computeScene(state) -> Scene -> reconcile PixiJS objects -> canvas
```

Rendering must be deterministic: a given [`StepState`](../data/state-schema.md) produces the same visible frame regardless of what was rendered before it. A replay can therefore jump directly to any tick.

The renderer owns the game frame and environment-specific controls. The host page owns shared chrome such as connection status, pause, stop, the active timeout, decision log, result, and replay transport.

## Shared contract

The shared types live in `frontend/src/renderers/types.ts`. A renderer mounts with metadata, a recording header, controlled players, and an optional action sender, then exposes a fixed internal size, aspect ratio, `render`, and `destroy`.

`render(state, options)` returns a promise that resolves once the transition it started has finished. A draw-only renderer, a snap, a scale of zero, and a change with nothing to animate all resolve immediately. A paced host (the replay transport, the live session socket) awaits that promise alongside its own cadence timer before it delivers the next frame, so a transition that genuinely runs longer than the cadence still finishes instead of being cut off. A render that supersedes an in-flight transition resolves the earlier promise too, and so does `destroy`, so a host is never left waiting on a frame that will not come.

`RenderOptions` has two fields: `snap` jumps straight to the state with no transition, for a replay scrub, seek, or step; `transitionScale` is a multiplier on the renderer's natural phase durations, where omitted or `1` is natural timing, `0` completes immediately, and a paced host passes its cadence relative to one second so the renderer's transitions run at that pace. It is not a time budget: a renderer whose natural timing exceeds the cadence simply takes longer, and the host waits.

The registry stores each `PixiRenderer` subclass with its static image thumbnail. The frontend discovers every `environments/*/renderer/index.ts` module on its own.

`PixiRenderer` owns PixiJS setup and teardown, high-DPI sizing, resize handling, pending-state caching, input listeners, and the jsdom guard, which skips canvas and WebGL work when a test runs under jsdom, the DOM simulator. A subclass creates persistent nodes in `setup(root)`, reconciles them in `update(state)`, and may declare fixed gesture mappings in `inputs()`.

Renderers that need pan and zoom can compose the shared pure camera reducers and DOM gesture wiring under `frontend/src/renderers/base/`. Keep the movable world in its own container so screen-fixed overlays remain outside the camera transform.

## Deterministic retained rendering

Keep drawing logic in two layers:

1. `computeScene(state, config)` is a pure function that returns plain scene data.
2. `update(state)` reconciles persistent PixiJS objects to that data.

The reconciler creates the nodes the current scene needs, sets every visible property from it, and removes the ones it no longer contains. Unit-test `computeScene` with checked-in states, then cover GPU reconciliation and visible canvas behavior in the browser suite.

A renderer may animate between states without weakening determinism. The static scene remains the frame for seeks and scrubs (`options.snap`), while `onFrame(dtMs)` advances an optional transition layer at `options.transitionScale`.

Split what redraws every frame from what redraws on interaction. Resolve data that changes only on a click, such as tile lookups and baked text, when it changes, and rebuild per frame only the marks that actually move. Two known deviations exist today and are the first places to look if a profile shows frame cost: the cards move-clock chip re-bakes its label every frame, and the Crane Reach order pulse rebuilds its tile lookup every frame.

## Input and semantic data

Input is enabled only for controlled players with a `sendAction` callback. Spectators and replay viewers mount draw-only renderers.

Use `inputs()` for fixed mappings such as Flappy Bird's flap. Make scene objects interactive when their action depends on the clicked card or board cell.

The [overlay](package.md#overlay) contains meaningful game objects. Draw and hit-test those objects directly, then convert the selection to an encoded action only at the `sendAction` boundary.

An overlay may carry the semantic state a renderer needs to derive the legal choices instead of listing them, which keeps long recordings small. A renderer that does derive them owes the environment an agreement test: Skirmish at Crane Reach recomputes walkable paths and nameable targets in `environments/skirmish_crane/renderer/legality.ts`, and its mask-agreement suite asserts that the result equals the masks the environment actually published, for every recorded activation of both fixture recordings. Read shared constants such as movement costs from the same data file the rules engine reads so the two sides cannot drift.

### The move clock

The harness supplies a legal default action once a person has held a player's controls for longer than the session budget. It counts held time alone: the browser reports the controls opening and closing through `RendererContext.setControlHeld`, which sends the `clock` command. A renderer that shows a countdown draws the browser's picture of that budget rather than the harness's own count of it.

`renderers/base/move-clock.ts` is that picture, shared by every renderer that wants one. A host renderer opens it with the acting turn and the session budget (`meta.human_timeout_ms`) when a state puts a controlled player on the clock, and calls `setControlHeld` with that player in the same place, so the harness and the picture start together. It reads `remainingMs`, `fraction`, `seconds`, and `ember` while drawing. Reopening the same turn leaves the countdown alone, so a resize or a late-arriving asset never gives a person their time back. It takes an injectable `now` for fake-clock tests. `setPaused` freezes the picture for a playback pause, and releasing the controls there holds the harness's budget for the same span. A page that reconnects mid-turn opens the clock again at the full budget: it reads high rather than low, and the harness keeps what it already spent.

Keep the number itself out of the pure scene. The scene carries the budget, which is a function of the state; elapsed time is not part of any frame and belongs to the reconciler.
