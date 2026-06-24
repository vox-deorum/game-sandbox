# Stage 7.7: Hearts Renderer and On-Screen Input

Status: not started.

Part of [Stage 7](../stage-07-multi-agent.md). This is build-order step 7 and the last functional step. It draws Hearts and turns clicks into card plays. It is Docker-free frontend work, tested against fixtures and recordings the way the Stage 4 renderer was, separately from live session control. It depends on the environment state schema from step 1; the live human-slot wiring it drives is exercised by steps 5 and 6.

## Why this is its own seam

Rendering and on-screen input are pure functions of session state, so they test against fixtures and recordings without a live session, mirroring the Stage 4 renderer-versus-live split. Building the renderer last means it draws against the real recorded Hearts state shape that steps 1, 5, and 6 have settled, rather than a guess. The on-screen input UI from [interaction.md](../../docs/specs/interaction.md) replaces raw device input for Hearts.

## What to build

A `hearts` renderer under `frontend/src/renderers/hearts/`, extending the Pixi base and registered once in `frontend/src/renderers/index.ts`, with a pure `computeScene(state)` like `frontend/src/renderers/flappy-bird/scene.ts`. The renderer is the `renderer="hearts"` key the environment metadata declares in step 1. This is the browser renderer for the web app; it is distinct from the local Python renderer step 1 ships for students testing in pygame, though both draw the same recorded state and grey from the same legal-action mask.

It draws:

- The player's hand.
- The current trick.
- A turn indicator.
- The running per-slot penalty scores.
- The active move clock, using the session value.

## On-screen input

Clicking a card plays it. Cards that are not legal on the current turn are greyed out: wrong suit when the led suit is held, hearts before broken, and the first-trick restrictions. The greying reads the legal-action mask the environment emits into the recorded state (step 1), not a JavaScript reimplementation of the rules, so the browser and the environment never disagree about legality. The move-clock display lives here; the timeout behavior that auto-plays a legal move lives in step 5.

## Replay

The replay of a multi-agent match renders trick-by-trick turns and per-slot penalty scores correctly, using the same `computeScene` path as live rendering.

## Tests

Vitest, jsdom, no canvas, no network, following the Stage 4 and 5 renderer test pattern:

- `computeScene` greys exactly the cards absent from the emitted legal-action mask, across representative led-suit, hearts-not-broken, and first-trick fixtures.
- Per-slot penalty scores and the turn indicator render from a fixture state.
- A recorded multi-agent Hearts fixture replays trick-by-trick with correct per-slot penalty scores.

## Done when

A Hearts session renders the player's hand, the current trick, a turn indicator, per-slot penalty scores, and the move clock from the session value. Clicking a legal card plays it, and illegal cards are greyed from the environment's emitted legal-action mask, so the browser never recomputes legality. A replay of a multi-agent Hearts match renders trick-by-trick turns and per-slot penalty scores correctly. The jsdom scene and replay tests above pass with no canvas or network.
