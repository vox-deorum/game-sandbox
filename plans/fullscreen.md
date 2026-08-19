# Full-Screen Presentation for Game Renderers

Status: complete.

## Goal

Every renderer family plays at full screen: the bespoke Pixi renderers (flappy_bird, skirmish_crane, three_branches) and the card-table template renderers (hearts, spades), live and in replay.

## Mechanism

The feature lives entirely on the shared StageFrame host, which every renderer already resizes to. One reactive `isFullscreen` state drives both modes: the native Fullscreen API where `document.fullscreenEnabled` is true, and a CSS fallback (a fixed, inset-0 stage canvas) on browsers without it, such as iPhone Safari. The stage canvas letterboxes the renderer at its aspect ratio. Replays get a floating, auto-hiding transport bar (the shared ReplayTransport) inside fullscreen; the toggle sits top-left of the canvas, clear of three_branches' top-right chrome (its Recenter/collision plates), and is a shielded button that stops pointer/touch/click propagation so a click cannot flap, drag, or recenter a renderer's camera — or reach the renderers' canvas listeners at all.

## Files

- frontend/src/composables/useFullscreen.ts (new)
- frontend/src/components/StageFrame.vue
- frontend/src/components/ReplayTransport.vue (new)
- frontend/src/pages/ReplayPage.vue
- frontend/test/stage-frame.test.ts, frontend/test/replay.test.ts
- frontend/e2e/local/local-play.spec.ts, frontend/e2e/play/journey.spec.ts
- docs/specs/interaction.md, docs/specs/frontend.md
