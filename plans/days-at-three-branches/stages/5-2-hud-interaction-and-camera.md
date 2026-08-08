# Step 5.2: HUD, interaction design, and camera

Status: planned.

Part of [the plan](../README.md). This is the second of build-order step 5's two signed parts: the information layer over the village, the specification of step 6's input UI, and the camera. The hands-on surface is the pinned fixture replaying under the full HUD, explored close up without losing it.

## Why this is its own seam

These are interface decisions rather than art, and step 6 must not invent interaction on the fly: this stage specifies the input UI with text mockups, gets the owner's approval, and step 6 builds exactly that. The camera belongs with them because the HUD frames it: a 0.8 m character in a 100 m village is unreadable without zoom.

## What to build

Mockups are authored inside this stage and approved before build. The scope:

- The information layer: tick and phase, the bell state, character identification, and speech bubbles over speakers per the public-message rule, with the chat panel carrying the transcript.
- The interaction specification for step 6: the locomotion affordances, the expression palette with its nine emotes plus use, and the use-preview highlight, as text mockups.
- The camera: the reset view fits the whole village with nothing hidden, pan and zoom within bounds below the fixed HUD, and zoom limits far enough to see the village and close enough to read expressions and speech bubbles, following the camera conventions Skirmish at Crane Reach established.

## Tests

- Renderer unit tests for the HUD elements and for camera fit, bounds, and zoom limits from the fixture.
- The e2e journey covers pan and zoom on the watch page, and locator updates land in the same change where markup moves.
- While iterating, run the `three-branches` browser e2e group. Before handoff, run the bare full browser e2e suite.

## Done when

The fixture replays under the full HUD and can be explored close up in both render modes, step 6's input UI is specified and approved, the bare full browser e2e suite passes, and the owner's sign-off is recorded in this file's status line.
