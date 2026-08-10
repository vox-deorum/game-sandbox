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

Rendering must be deterministic: the recording header's static data and a given [`StepState`](../data/state-schema.md) produce the same visible frame regardless of what was rendered before it. A replay can therefore jump directly to any tick.

The renderer owns the game frame and environment-specific controls. The host page owns shared chrome such as connection status, pause, stop, the active timeout, decision log, result, and replay transport.

## Shared contract

The shared types live in `frontend/src/renderers/types.ts`. A renderer mounts with metadata, a recording header, controlled players, and an optional action sender, then exposes a fixed internal size, aspect ratio, `render`, and `destroy`. Read episode-static environment data from `ctx.header.overlay_static` at mount and retain it for the episode; each `render` call receives only the dynamic overlay for that state.

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

The harness counts only time while controls are held and supplies a legal default action at the session budget. When a controlled player is on the clock, open the shared `renderers/base/move-clock.ts` with a unique turn key such as `String(state.tick)` and `meta.human_timeout_ms`, and call `RendererContext.setControlHeld` with that player in the same interaction.

Use the fields appropriate to the presentation from the available `remainingMs`, `fraction`, `seconds`, and `ember` set, with injectable `now` for tests. `setPaused` freezes the local clock, and releasing controls for the pause holds the harness budget for the same span. Reopening the same turn does not reset it. A newly mounted renderer that joins mid-turn starts its local display at the full budget while the harness retains elapsed time.

Keep elapsed time out of `computeScene`; it belongs to the reconciler, while the scene may carry the budget.
