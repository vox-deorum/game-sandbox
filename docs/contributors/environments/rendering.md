# Rendering

Each environment has one browser renderer for both live play and replay. Renderers use PixiJS through a common base class, draw from per-step state, and never inspect the live environment.

Read the [interaction specification](../../specs/interaction.md) for the product contract and [Frontend](../frontend/development.md) for the pages that host a renderer.

## Add a renderer

1. Create `environments/<env>/renderer/` beside the environment package.
2. Add a `PixiRenderer` subclass and declare `internalSize`.
3. Put pure state-to-scene logic in `computeScene` and reconciliation in `update`.
4. Add `inputs()` when humans can control the environment.
5. Add `thumbnail.svg`, default-export `{ key, renderer, thumbnail }`, and ensure the key equals `ENTRY.meta.renderer`.
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

The registry stores each `PixiRenderer` subclass with its static SVG thumbnail. The frontend discovers every `environments/*/renderer/index.ts` module on its own.

`PixiRenderer` owns PixiJS setup and teardown, high-DPI sizing, resize handling, pending-state caching, input listeners, and the jsdom guard, which skips canvas and WebGL work when a test runs under jsdom, the DOM simulator. A subclass creates persistent nodes in `setup(root)`, reconciles them in `update(state)`, and may declare fixed gesture mappings in `inputs()`.

## Deterministic retained rendering

Keep drawing logic in two layers:

1. `computeScene(state, config)` is a pure function that returns plain scene data.
2. `update(state)` reconciles persistent PixiJS objects to that data.

The reconciler creates the nodes the current scene needs, sets every visible property from it, and removes the ones it no longer contains. Unit-test `computeScene` with checked-in states, then cover GPU reconciliation and visible canvas behavior in the browser suite.

A renderer may animate between states without weakening determinism. The static scene remains the frame for seeks and scrubs, while `onFrame(dtMs)` advances an optional transition layer.

## Input and semantic data

Input is enabled only for controlled players with a `sendAction` callback. Spectators and replay viewers mount draw-only renderers.

Use `inputs()` for fixed mappings such as Flappy Bird's flap. Make scene objects interactive when their action depends on the clicked card or board cell.

The [overlay](package.md#overlay) contains meaningful game objects. Draw and hit-test those objects directly, then convert the selection to an encoded action only at the `sendAction` boundary.

The harness supplies a legal default action when no input arrives.
