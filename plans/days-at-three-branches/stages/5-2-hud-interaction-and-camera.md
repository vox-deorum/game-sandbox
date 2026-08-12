# Step 5.2: HUD and interaction design

Status: planned.

Part of [the plan](../README.md). This second signed part of build-order step 5 turns [step 3](3-renderer-and-registration.md)'s provisional chrome into the village information layer, specifies [step 6](6-human-play.md)'s input UI, and tunes the step 3 camera under the final art. Review the pinned fixture under the full HUD at fitted and close views.

## Why this is its own seam

Step 6 implements only the owner-approved input design. The final art and fixed HUD set the camera's zoom limits.

## Ordered path

1. Author text mockups and control semantics for the information layer and step 6 controls.
2. Get owner approval before input implementation begins.
3. Implement or refine the viewer HUD from the approved mockups.
4. Tune and test the step 3 camera against the fixture and final art.
5. Record the approved step 6 input specification and the collision overlay's shipped default in this file.

The approved information layer refines or replaces step 3's tick, phase, and bell chrome. It adds character identification, speech bubbles, and a chat transcript. Its chat mockup shows a recipient selector with Broadcast and the currently permitted character-id addressees. Broadcasts and direct lines both require hearing range and an unblocked line. Watchers and replay viewers see every delivered line. The playing visitor sees broadcasts delivered to it and direct lines sent to or from it. [The environment speech contract](../environment.md#speech) is authoritative.

The approved layer also settles the collision overlay's shipped default for watch, replay, and play, which [step 3](3-renderer-and-registration.md) leaves on while the art is provisional. The toggle itself is permanent either way, and this part adds its keyboard access.

The approved step 6 specification covers locomotion affordances, the expression palette with nine emotes plus use, and an informational use-preview highlight. The preview applies the environment's reach-plus-unblocked-line selection rule.

The step 3 camera retains its visitor-focused reset below the fixed HUD. Pan, wheel zoom, and pinch suspend human follow. Reset recenters at the focus zoom and resumes follow only while `player_0` is controlled. Watch and replay reset to the current visitor without following it automatically. This step may tune the focus and zoom limits or add an explicit follow affordance, but must preserve that control-policy seam. The final limits must allow whole-village inspection and make expressions and speech bubbles readable at the focused view.

## Tests

- Renderer unit tests cover HUD elements, broadcast and direct recipient-selector states, visitor and viewer transcript visibility, the collision overlay's default and keyboard toggle, and tuned fixture zoom limits.
- Update locators whenever markup moves.
- Run the Three Branches browser e2e group while iterating. Before handoff, run the bare full browser e2e suite.

## Done when

The fixture replays under the full HUD and remains usable close up. Step 6's input UI is specified, approved, and recorded here, the bare full browser e2e suite passes, and this status line records the owner's sign-off.
