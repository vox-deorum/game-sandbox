# Stage 4: The Flappy Bird Renderer

Status: complete.

Part of [Stage 4](../stage-04-frontend-core.md). This file records the first real renderer module: the Flappy Bird game frame drawn from the per-step state's overlay, the in-game UI that makes it read as a game, and raw device input wired through the WebSocket as actions, per [interaction.md](../../specs/interaction.md). It implements the contract from [frontend-infrastructure.md](frontend-infrastructure.md) and registers under the metadata key `"flappy-bird"`; the same module runs unchanged from a stored recording, which [replay-and-retention.md](replay-and-retention.md) relies on.

## Drawing the world from the overlay

The overlay is the whole truth — the renderer never reaches behind the state object. Stage 2's `extract_overlay` already carries everything needed, in unnormalized screen pixels: `width`/`height` (the game's logical surface), `player` (`x`, `y`, `vel_y`, `rot`), `pipes` (each with `x` as the left edge and `gap_top`/`gap_bottom` as the gap's edges), and `pipes_passed`. The module renders into a 2D canvas sized to the logical `width`×`height` and scaled to its container with CSS, preserving aspect ratio.

The art is original flat-color vector drawing — simple shapes, no sprites from the original game, whose assets are not ours to ship. The bird is drawn at `player.x`/`player.y` rotated by `rot` (with `vel_y` available for animation flourish); each pipe is a pair of columns from the top edge down to `gap_top` and from `gap_bottom` to the bottom edge. The overlay carries no pipe width, deliberately — it is a visual constant of the pinned game, so the renderer draws a fixed column width matching the game's pipe sprite proportions. A later overlay field can replace the constant if an environment variant ever varies it.

Rendering is split into two layers, and the split is a testing decision as much as a design one: a pure `computeScene(state): Scene` that turns one `StepState` into a list of drawing primitives (shapes, transforms, HUD text), and a thin `paint(ctx, scene)` that rasterizes them. The scene computation is where all the logic lives and is unit-testable in plain Vitest with no canvas implementation (jsdom has none); painting is trivial enough to be covered by the end-to-end suite. This also makes the contract's purity rule mechanically checkable: same state in, same scene out, regardless of what was rendered before — the property the replay scrubber depends on.

## The in-game UI

Per the parent file, the frame must read as a game rather than a debugger view. The HUD drawn into the canvas: the cumulative score from `agents.player_0.score` rendered large (the game's one number that matters), `pipes_passed` from the overlay as the pipe counter, and the tick — which, with the environment's `recommended_episode_ticks` and `episode_limit_ms` from metadata, doubles as the "attempts/time" indicator for a single-episode session. Session-level status (starting, paused, ended with reason and final score) is host chrome per the contract's chrome split — the hosting page overlays it, so a "PAUSED" or end-of-run banner appears identically over every environment's renderer.

The metadata's `pace_interval_ms` (50 ms, 20 steps/second) was flagged in Stage 2 for tuning during this stage's playtesting with the real renderer. Playtesting confirmed that value reads well as a game, so the environments package metadata and regenerated `environments.json` stayed unchanged.

## Input

Flappy Bird uses raw device input, the first of the two input styles in [interaction.md](../../specs/interaction.md) — no on-screen input UI. Keydown (Space, ArrowUp, W — ignoring key repeat), pointerdown on the canvas, and touchstart all map to the flap action and send `{"kind": "input", "slot": "player_0", "action": 1}` through the context's `sendAction` immediately, using the shared `Command` envelope. The renderer never sends noops: the container applies the environment default for a step with no input, and the harness latches the latest input per pace interval, so sending only flaps is both sufficient and bandwidth-minimal. The page prevents default scrolling on Space and touch while the renderer is mounted.

Input listeners attach only when the context says they should: `sendAction` present and `player_0` in `controlledSlots` — which is exactly live human play by the owner. Spectators and the replay viewer mount the same module with `controlledSlots` empty and get a draw-only renderer with zero input code paths active.

## Replay parity

There is no replay mode. The module draws whatever state it is handed; the live page hands it states as they stream, the replay page hands it states the transport or the scrubber selects, and the purity rule guarantees the frames are identical for identical states. The Stage 2 determinism fixtures double as renderer fixtures: a checked-in recording feeds the scene-computation tests, and any future visual regression has a stable byte-identical input to reproduce against.
