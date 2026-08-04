# Step 5: Human Play

Status: planned.

Part of [the Skirmish at Crane Reach plan](../README.md). This is build-order step 5: a human plays Skirmish at Crane Reach in the browser and in local play, with fog of war, legal-by-construction order composition, and the move clock. The hands-on surface is controlling a seat's primary unit or the whole side, in the web app and through both local launchers with naive companions.

## Why this is its own seam

The input layer contains the riskiest renderer deliverable: a TypeScript legality computation. The [environment spec](../environment.md) requires the renderer to compute the acting controlled player's walkable paths and nameable targets from the overlay state. Keeping this logic in the renderer keeps production recordings and streams compact. Its safety net, the mask-agreement suite, is substantial work of its own, and this step is complete only when the browser's legality equals the environment's.

## What to build

### Legality from the overlay

A renderer-local module computes, for the acting controlled player, the walkable path set and the nameable target set from the overlay state alone. Its scope is step costs, occupancy, the always-permitted first step, the four-step limit, and the visibility sets the overlay already carries. Range bands explain likely strike results but do not filter nameable targets: every living visible enemy is nameable.

### Order composition

Legal-by-construction, per the [step 4.2 interaction design](4-2-hud.md):

- Click an adjacent highlighted hex to append a step, up to four; only legal continuations are ever highlighted. Undo steps. An empty path is stay.
- Optionally name a visible enemy as the target. The UI shows that the strike resolves automatically from the final tile even with no target named.
- Confirm sends the matching `{path, target}` action Dict through `sendAction`.
- No auto-routing: click-to-destination pathfinding is deliberately absent, because pathfinding is the student's work in this course.

### Fog of war

Implement the perspective rule the [environment spec](../environment.md#rendering-and-human-input) states, driven by `controlledPlayers` and the recording header's seat map. Terrain is always drawn: the generated battlefield is standing knowledge in the ruleset.

### Control modes and the clock

Browser whole-side control already exists and has coverage. The renderer filters by `controlledPlayers` membership, and the two modes are the seat's primary player with a companion filling the rest, or the whole side with no companion. The move clock displays the 30 second `human_timeout_ms` on the acting controlled player's turn; a timeout resolves to stand-still-and-strike through `default_action`, platform behavior that the UI displays rather than reimplements.

### Local play

Neither launcher can play a whole seat today, so this step closes that gap. In both, `self` joins the companion values: every player in the human's seat becomes externally controlled, and the seat's first declared human-capable player stays the chat sender. Other seats keep their existing assignments.

`npm run play -- skirmish_crane human` is the smaller half. `scripts/play.py` already resolves a seat through `--seat` and fills its other members through `--companion`, so it needs `self` accepted alongside `naive` and a manifest path, the wide-seat requirement message updated to offer it, and the seat's players bound external instead of one.

`python -m sandbox human` is platform work in the shared template launcher, and it lands for every environment. Today it has no seat concept at all: `--player` indexes `possible_agents` flat, and every other player, same-seat teammates included, runs the repository's own agent. It gains three things:

- The selected player's seat, resolved through `resolve_layout`, which the launcher already imports for `--vs`.
- A `--companion self` flag that binds every player of that seat external.
- An `external_chat_player` in its local config, which it does not emit today because one external player needed no designation.

Without the flag its current behavior stands: one external player, the repository's own agent on the rest of the seat. The student guide's local-play commands change with it.

## Tests

- The mask-agreement suite, the step's core deliverable: for the opening state and every actionable recorded state in both fixtures, the TypeScript-computed walkable path set and nameable target set equal the test-only legality masks exactly, path ids included. A visible enemy outside strike range remains nameable.
- Interaction tests (vitest, jsdom): step-by-step composition builds the expected path id, undo and confirm behave, an empty confirm sends stay, target selection sends the right roster slot, illegal continuations are never offered, and nothing is clickable without `sendAction`.
- Fog tests cover human turns, companion turns, opponent turns, a controlled unit's death while companions remain, terminal states, reconnect mounting, and direct rendering. Terrain stays complete.
- Human-play tests cover primary-player companion control, whole-side browser control, chat-sender selection, and invalid whole-side requests. Both local launchers are covered, and the template launcher's wide-seat path is tested at the platform level, against an existing wide-seat environment as well as Skirmish at Crane Reach.
- The e2e journey gains its bounded human segment: compose a short move and a stay via canvas clicks, deliberately minimal to contain canvas-click brittleness.

## Done when

From the web app and local play, a person controls the seat's primary unit with a companion or controls the whole skirmish side: composes a multi-step move with illegal continuations never offered, names a target or lets the automatic strike resolve, watches fog switch between perspectives, and sees a timeout land as stand-still-and-strike. The mask-agreement suite and all tests above are green.
