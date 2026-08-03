# Step 4: Art Style and UI

Status: planned. Exit requires explicit owner sign-off on the art direction, recorded here.

Part of [the Skirmish at Crane Reach plan](../README.md). This is build-order step 4: the crane-reach-field visual identity, designed and iterated on the live step 3 renderer and approved by the owner. The hands-on surface is both fixture recordings replaying in the final style.

## Why this is its own seam

A renderer owns its game's visual identity, but a new visual pattern needs owner confirmation, and design decisions are the owner's to make ([design system](../../../docs/contributors/frontend/design-system.md)). Skirmish at Crane Reach is the first battlefield renderer, so its identity is entirely new. Concentrating the design work in one step, on a working renderer, means candidate styles are judged on real frames (a live army match, a replay seek, the 150 ms cadence) and iteration happens here rather than leaking into later code review. Step 3 built the scene layer style-swappable for exactly this reason.

## What to build

### The visual identity, applied

The final art lands in renderer code, replacing the placeholder styling layer:

- Palette and pointy-top hex tile art for grass, hill, water, forest, marsh, and the void surround.
- Both sides' three unit types, readable at army scale where a hex is roughly 25 px, with hit-point display.
- Seven-tile capture zones, the activation highlight, and the walk-then-strike event animations (move, attack, damage, death, capture-score changes).
- HUD styling: round, capture scores, rosters, current activation.
- The fog treatment design for step 5 (how hidden units and the visible set read on a human turn), specified visually here, wired there.
- The final `renderer/thumbnail.svg`.

Renderer modules are exempt from the tokens.css rule, but the note below records how the style coexists with the host chrome without clashing.

### The art direction note

A short written record of the choices: palette, hex geometry and scale, unit iconography, typography, animation vocabulary, and the host-chrome relationship. It lives beside the renderer so future changes have a reference.

### Interaction design for step 5

Path composition affordances (highlighted continuations, undo, confirm) and target selection, specified as annotated frames or stills from the renderer. Design only; the working input code is step 5.

### Review workflow

Candidate styles render over the two step 3 fixtures and are reviewed in the browser via replay and `npm run play`. Iteration continues until the owner signs off; the sign-off is recorded in this file's Status line.

## Tests

- Scene tests updated where they assert on style-bearing output; geometry and content assertions from step 3 stay unchanged.
- The step 3 perf smoke stays green with the real art on the army fixture.
- The e2e spectate journey stays green (it asserts on behavior, not pixels).

## Done when

Both fixtures replay in the final style, a live match and `npm run play` show the same identity, the thumbnail is final, the perf smoke and scene tests are green, and the owner has signed off on the art direction.
