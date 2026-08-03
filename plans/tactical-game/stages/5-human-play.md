# Step 5: Human Play

Status: planned.

Part of [the tactical game plan](../README.md). This is build-order step 5: a human plays tactical in the browser and in local play, with fog of war, legal-by-construction order composition, and the move clock. The hands-on surface is controlling one unit or a whole side, in the web app and through `scripts/play.py` with naive companions.

## Why this is its own seam

The input layer contains the riskiest renderer deliverable: a TypeScript legality computation. The [environment spec](../environment.md) requires the renderer to compute the acting controlled player's walkable paths and nameable targets from the overlay state, which is a deliberate, bounded second implementation of movement cost, occupancy, range, and vision. Its safety net, the mask-agreement suite, is substantial work of its own, and it deserves a seam where its Done means exactly "the browser's legality provably equals the environment's".

## What to build

### Legality from the overlay

A renderer-local module computes, for the acting controlled player, the walkable path set and the nameable target set from the overlay state alone. Scope is bounded: step costs, occupancy, the always-permitted first step, the four-step limit, range bands, and the visibility sets the overlay already carries. Nothing else about the rules is reimplemented.

### Order composition

Legal-by-construction, per the step 4 interaction design:

- Click an adjacent highlighted hex to append a step, up to four; only legal continuations are ever highlighted. Undo steps. An empty path is stay.
- Optionally name a visible enemy as the target. The UI shows that the strike resolves automatically from the final tile even with no target named.
- Confirm sends the matching `{path, target}` action Dict through `sendAction`.
- No auto-routing: click-to-destination pathfinding is deliberately absent, because pathfinding is the student's work in this course.

### Fog of war

On a human turn the renderer displays only the units visible to the acting controlled player, per the step 4 fog design. Terrain is always drawn: the generated battlefield is standing knowledge in the ruleset. The view recomputes as activation passes among controlled players. Spectator and replay views stay complete.

### Control modes and the clock

Multi-control is platform capability, consumed here and never planned here: the renderer filters by `controlledPlayers` membership, and the two modes are one controlled player with a companion filling the seat, or the whole side with no companion. The move clock displays the 30 second `human_timeout_ms` on the acting controlled player's turn; a timeout resolves to stand-still-and-strike through `default_action`, platform behavior that the UI displays rather than reimplements.

### Local play

`python -m sandbox human` and `npm run play -- tactical_game human` gain the human mode: pick a seat, control a unit with naive filling the rest, or take the whole side.

## Tests

- The mask-agreement suite, the step's core deliverable: for every recorded state in both fixtures, the TypeScript-computed walkable path set and nameable target set equal the recorded mask bits exactly, path ids included.
- Interaction tests (vitest, jsdom): step-by-step composition builds the expected path id, undo and confirm behave, an empty confirm sends stay, target selection sends the right roster slot, illegal continuations are never offered, and nothing is clickable without `sendAction`.
- Fog tests: the drawn unit set equals the overlay's visibility set for the acting controlled player, terrain stays complete, and the view switches as activation moves between controlled players.
- The e2e journey gains its bounded human segment: compose a short move and a stay via canvas clicks, deliberately minimal to contain canvas-click brittleness.

## Done when

From the web app and local play, a person controls one unit or a whole skirmish side: composes a multi-step move with illegal continuations never offered, names a target or lets the automatic strike resolve, watches fog switch between their units, and sees a timeout land as stand-still-and-strike. The mask-agreement suite and all tests above are green.
