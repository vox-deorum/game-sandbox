# Step 5.2: HUD and interaction design

Status: planned.

Part of [the plan](../README.md). This second signed part of build-order step 5 turns [step 3](3-renderer-and-registration.md)'s provisional chrome into the village information layer, specifies [step 6](6-human-play.md)'s input UI, and tunes the step 3 camera under the final art. Review the pinned fixture under the full HUD at fitted and close views.

## Why this is its own seam

Step 6 implements only the owner-approved input design. Final art and the fixed HUD determine the camera's zoom limits.

## Ordered path

1. Author text mockups and control semantics for the information layer and step 6 controls.
2. Get owner approval before input implementation begins.
3. Implement or refine the viewer HUD from the approved mockups.
4. Tune and test the step 3 camera against the fixture and final art.
5. Record the approved step 6 input specification in this file.

The approved information layer refines or replaces step 3's tick, phase, and bell chrome, adds character identification, speech bubbles, and a chat transcript. Its chat mockup shows a recipient selector with Broadcast and the currently permitted character-id addressees. A broadcast and a direct line both require hearing range and an unblocked line. Watchers and replay viewers see every delivered line. The playing visitor sees broadcasts delivered to it and direct lines sent to or from it. [The environment speech contract](../environment.md#speech) is authoritative.

The approved step 6 specification covers locomotion affordances, the expression palette with nine emotes plus use, and an informational use-preview highlight. The preview applies the environment's reach-plus-unblocked-line selection rule.

The step 3 camera retains a fitted reset below the fixed HUD. Its final zoom limits must show the whole village and still make expressions and speech bubbles readable.

## Tests

- Renderer unit tests cover HUD elements, broadcast and direct recipient-selector states, visitor and viewer transcript visibility, and tuned fixture zoom limits.
- Update locators whenever markup moves.
- Run the Three Branches browser e2e group while iterating. Before handoff, run the bare full browser e2e suite.

## Done when

The fixture replays under the full HUD and remains usable close up. Step 6's input UI is specified, approved, and recorded here, the bare full browser e2e suite passes, and this status line records the owner's sign-off.
