# Step 3: Renderer, collision overlay, registration, watch and replay

Status: planned.

Part of [the plan](../README.md). This is build-order step 3: the first visible artifact, and the first production exercise of the platform's simultaneous frontend paths. The hands-on surface is a live match watched in the browser, its replay scrubbed to exact frames, and `npm run play` showing a local watch-mode day.

## Why this is its own seam

The collision overlay is a permanent viewer feature, not scaffolding: toggled on, it shows the game at collision truth, which is what students need when their villager gets stuck. Shipping the renderer and the overlay before any art proves both complete and seek-safe, registers the environment so every later step works against the real catalog, and gives step 4 the tool it uses to iterate on village generation visually.

## What to build

### The shared tiled-map base

Tile-map rendering joins the shared renderer base under `frontend/src/renderers/base/`, built on [pixi-tiledmap](https://github.com/riebel/pixi-tiledmap), pinned and verified against the project's Pixi version. A renderer hands it a tile grid and a tileset and gets a drawn ground layer back. This part is common: any environment with tiled ground can reuse it.

### The renderer and its collision overlay

The renderer package at `environments/three_branches/renderer/` with a `PixiRenderer` subclass and a thumbnail. The ground renders through the shared tiled-map base with a flat type-colored placeholder tileset, from packed ground-grid rows the overlay carries. The grid is sampled Python-side from the engine's own ground classifier, so the frontend never reimplements the ground rules and the view shows exactly what the engine believes. A viewer-toggleable collision overlay draws above the ground layer, at collision truth: building footprints with their doorway gaps, props as footprint rectangles with state labels, characters as 0.4 m circles with a heading tick, id, and expression label, and bell, tick, and phase chrome. The whole village fits the view; camera work comes in step 5.2. Prop types and states label themselves from the same `props.json` the engine reads. Speech reaches the chat panel, and a watcher sees every delivered NPC message live, the consumer test for step 1's visibility rule.

### Session limits

Step 1's environment-aware duration rule applies to this live day. Its derived default covers the paced day, every agent-controlled player's compute budget, and the 60-second platform-overhead allowance, unless a deployment explicitly overrides it. The current 600-second default covers only the pacing windows and would end a live day at the finish line.

### Fixture and e2e

A pinned fixture recording on the step 2 fixture village, with its generator script, recorded unpaced by the harness. The `three-branches` e2e directory; a directory with a spec under `frontend/e2e/` is the entire wiring. Live journeys watch the opening ticks and stop the session; full-day coverage rides the fixture replay, because the day length is fixed and the design declares no length parameter.

## Tests

- Renderer unit tests from the fixture: seek anywhere, idempotent update, overlay-only state.
- Playwright watch and replay journeys, and the spectator chat visibility check.
- An integration test proves the live day reaches its natural end under the derived duration default.
- While iterating, run the `three-branches` browser e2e group. Before handoff, run the bare full browser e2e suite.

## Done when

A live match renders in the browser, its replay scrubs to exact frames, `npm run play` shows a local watch-mode day, the bare full browser e2e suite passes, and the catalog lists the environment.
