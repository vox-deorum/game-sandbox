# Step 6: Human play, the visitor

Status: planned.

Part of [the plan](../README.md). This is build-order step 6: the visitor seat live in a human's hands, implementing the input UI specified in step 5.2. The hands-on surface is playing the visitor in the browser against a running cast, and locally.

## Why this is its own seam

This is the platform's first analog human input: pointer and keyboard compose a continuous `Dict` action (heading, speed, action) inside the 500 millisecond window, where every earlier environment sent discrete choices. It deserves its own build and test pass on top of an approved interaction design.

## What to build

### Locomotion

Pointer and keyboard input composed into a heading and relative speed each input window, per the 5.2 specification. The 500 millisecond cadence is the input window; there is no separate move clock.

### Expression and speech

The expression palette with the nine emotes plus use, and the use-preview highlight computed by the same pre-tick selection rule the environment applies, informational only. Chat through the host page's panel, with recipient choices following the talk policy: nearest first, the nearest as default, broadcast when nobody is near. Spectators and replay viewers receive no input.

### Session behavior

Step 1's human-session idle rule stops reclaiming a connected visitor who is watching quietly. The timeout arms only after the last owner socket disconnects. Spectators do not keep the visitor session alive, and scripted watch sessions remain viewer-based. Standing still is normal play in this game.

### Local parity

The visitor seat playable through `scripts/play.py` and the template launcher, which resolve `player_0` in every plan.

## Tests

- jsdom unit tests for input composition, palette state, and preview correctness against fixture observations. Renderer tests cover every human control, per the design.
- A Playwright human-play journey: join as the visitor, walk, emote, observe the use preview, send a talk.
- Local launcher coverage for the visitor seat.
- Integration coverage keeps a quiet connected visitor live, starts the idle timeout after the final owner disconnects, and confirms that a spectator alone does not extend the session.
- While iterating, run the `three-branches` browser e2e group. Before handoff, run the bare full browser e2e suite.

## Done when

A human plays the visitor live in the browser and locally, with locomotion, the palette, the preview, and chat behaving per the design, a quiet visitor is never reclaimed while connected, and the bare full browser e2e suite passes.
