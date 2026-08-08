# Step 5.1: Art style

Status: planned.

Part of [the plan](../README.md). This is the first of build-order step 5's two signed parts: the village's visual identity as the realistic render mode beside the debug view. The hands-on surface is the pinned fixture replaying in the realistic style behind a viewer toggle.

## Why this is its own seam

The look of the village is an owner decision, and it is the largest pure-art effort in the plan. Splitting it from the HUD, interaction, and camera keeps each sign-off small and lets the debug view carry development in the meantime.

## What to build

The full palette, tileset direction, and mockups are authored inside this stage and approved before build. The scope:

- The realistic ground tileset over the same shared tiled-map pipeline the debug view uses; the two modes differ by tileset and dressing, not by rendering path.
- Buildings with readable doorways, props, and characters, with the visitor visually distinct.
- Sustained prop-state animations derived from state alone: a lit lantern glows, the lit hearth burns, a tended shrine trails incense smoke, the flowing pump pours, and the ringing bell swings. Prop states come from the shared `props.json`.
- Day-phase lighting when daynight is on, and ambient white cranes as pure renderer dressing.
- The debug-or-realistic viewer toggle on watch, replay, and play. Both modes read the same overlay, and a replay seek produces the same state in either mode.
- A readable still presentation when `prefers-reduced-motion` is enabled: sustained Pixi animation stops while the current prop state, phase lighting, and all other game state remain readable.

## Tests

- Renderer unit tests for state-derived animation and phase lighting from the fixture.
- Both modes replay the pinned fixture to the same state.
- The realistic mode has a readable still presentation when `prefers-reduced-motion` is enabled, covered by a renderer test.
- Asset and thumbnail checks in the pattern of the existing renderer asset tests.
- While iterating, run the `three-branches` browser e2e group. Before handoff, run the bare full browser e2e suite.

## Done when

The fixture replays in the final style behind the toggle, the bare full browser e2e suite passes, and the owner's sign-off is recorded in this file's status line.
