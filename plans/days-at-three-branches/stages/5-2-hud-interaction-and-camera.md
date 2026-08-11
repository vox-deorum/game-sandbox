# Step 5.2: HUD and interaction design

Status: planned.

Part of [the plan](../README.md). This is the second of build-order step 5's two signed parts: the information layer over the village, the specification of step 6's input UI, and the tuning of the step 3 camera's zoom limits under the final art. The hands-on surface is the pinned fixture replaying under the full HUD, explored close up without losing it.

## Why this is its own seam

These are interface decisions rather than art, and step 6 must not invent interaction on the fly: this stage specifies the input UI with text mockups, gets the owner's approval, and step 6 builds exactly that. The zoom limits are tuned here because the HUD and the final art fix what must stay readable.

## What to build

Mockups are authored inside this stage and approved before build. The scope:

- The information layer: tick and phase, the bell state, character identification, and speech bubbles over every speaker for every viewer, since every line is public, with the chat panel carrying the transcript.
- The interaction specification for step 6: the locomotion affordances, the expression palette with its nine emotes plus use, and the use-preview highlight, computed by the same reach-plus-unblocked-line selection rule the environment applies to prop use, as text mockups.
- The camera tuning: the step 3 camera keeps its fitted reset below the fixed HUD, and its zoom limits land far enough to see the village and close enough to read expressions and speech bubbles.

## Tests

- Renderer unit tests for the HUD elements and for the tuned zoom limits from the fixture.
- Locator updates land in the same change where markup moves.
- While iterating, run the `three-branches` browser e2e group. Before handoff, run the bare full browser e2e suite.

## Done when

The fixture replays under the full HUD and can be explored close up, step 6's input UI is specified and approved, the bare full browser e2e suite passes, and the owner's sign-off is recorded in this file's status line.
