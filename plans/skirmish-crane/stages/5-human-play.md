# Step 5: Human Play

Status: planned.

Part of [the Skirmish at Crane Reach plan](../README.md). This is build-order step 5: a human plays Skirmish at Crane Reach in the browser and in local play, with fog of war, legal-by-construction order composition, and the move clock. The hands-on surface is controlling a seat's primary unit or the whole side, in the web app and through both local launchers with naive companions.

## Why this is its own seam

The input layer contains the riskiest renderer deliverable: a TypeScript legality computation. The [environment spec](../environment.md) requires the renderer to compute the acting controlled player's walkable paths and nameable targets from the overlay state. Keeping this logic in the renderer keeps production recordings and streams compact. Its safety net, the mask-agreement suite, is substantial work of its own, and this step is complete only when the browser's legality equals the environment's.

## What to build

### Legality from the overlay

A renderer-local module computes, for the acting controlled player, the walkable path set and the nameable target set from the overlay state alone. Its scope is step costs, occupancy, the always-permitted first step, the four-step limit, and the visibility sets the overlay already carries. It grows the step 4.2 reachability helper, which already computes destination sets for the movement-range displays, into full path enumeration. The full target set remains part of mask agreement for the agent contract. Human input always sends `target: 0` and uses the projected final tile to preview its automatic strike.

### Order composition

Legal-by-construction, per the [step 4.2 interaction design](4-2-hud.md):

- Click an adjacent highlighted hex to append a step, up to four; only legal continuations are ever highlighted. Undo or reselect on the board. An empty path is stay.
- Each endpoint change previews the automatic strike from the projected final tile. A unique nearest in-range enemy is shown, tied nearest candidates are all shown as uncertain, and no in-range enemy produces no preview. The preview is informational and never sends an action.
- The single `glyph-move.png` confirmation button sends `{path, target: 0}` through `sendAction`. It has no reset control.
- No auto-routing: click-to-destination pathfinding is deliberately absent, because pathfinding is the student's work in this course.

### Fog of war

Implement the perspective rule the [environment spec](../environment.md#rendering-and-human-input) states, driven by `controlledPlayers` and the recording header's seat map. Terrain is always drawn: the generated battlefield is standing knowledge in the ruleset.

### Control modes and the clock

The platform already supports assigning a whole side to one person. This step makes the Crane renderer filter perspective and input through `controlledPlayers`, for either the seat's primary player with companions or the whole side without them.

The host owns the authoritative move timer. `RendererContext` gains an optional, live, read-only move-clock source, such as `remainingMs` plus a subscription or an equivalently precise typed shape. The browser and local-play hosts supply it to Crane during a controlled human activation; replay and spectate omit it. The source stays correct across reconnect and pause and supports fake-clock tests. This step updates the shared renderer types and the contributor interaction and rendering documentation with that contract. Crane presents the remaining time as the confirm button's draining border. A timeout resolves to stand-still-and-strike through `default_action`, platform behavior that the UI displays rather than reimplements.

### Local play

Both local launchers must support whole-seat play through a `self` companion value. In both, selecting `self` makes every player in the human's seat externally controlled, while the seat's first declared human-capable player remains the chat sender. Other seats keep their existing assignments.

For `npm run play -- skirmish_crane human`, `scripts/play.py` resolves a seat through `--seat` and fills its other members through `--companion`. It must accept `self` alongside `naive`, accept a manifest path, offer `self` in the wide-seat requirement message, and bind every player in the seat as external.

For `python -m sandbox human`, the shared template launcher provides the same option for every environment. `--player` continues to index `possible_agents` flat. The launcher must:

- Resolve the selected player's seat through `resolve_layout`, which it already imports for `--vs`.
- Accept `--companion self` and bind every player in that seat as external.
- Emit `external_chat_player` in its local config.

Without `--companion self`, one player is external and the repository's own agent controls the rest of the seat. The student guide's local-play commands change with this launcher support.

## Tests

- The mask-agreement suite, the step's core deliverable: for the opening state and every actionable recorded state in both fixtures, the TypeScript-computed walkable path set and full nameable target set equal the test-only legality masks exactly, path ids included. A visible enemy outside strike range remains nameable even though human input sends `target: 0`.
- Interaction tests (vitest, jsdom): step-by-step composition builds the expected path id, board undo and reselect behave, confirmation through the single icon button sends `{path, target: 0}`, an empty confirmation sends stand-still-and-strike, illegal continuations are never offered, and nothing is clickable without `sendAction`.
- Preview tests cover a unique nearest in-range enemy, tied nearest candidates marked uncertain, no in-range enemy, endpoint changes, and reduced motion. Clock tests cover the confirmation button's full perimeter draining clockwise from the authoritative source, the ember threshold, reconnect, pause, and fake-clock progression.
- Fog tests cover human turns, companion turns, opponent turns, a controlled unit's death while companions remain, terminal states, reconnect mounting, and direct rendering. Terrain stays complete.
- Human-play tests cover primary-player companion control, whole-side browser control, chat-sender selection, and invalid whole-side requests. Both local launchers are covered, and the template launcher's wide-seat path is tested at the platform level, against an existing wide-seat environment as well as Skirmish at Crane Reach.
- The e2e journey gains its bounded human segment: compose a short move and a stay via canvas clicks, deliberately minimal to contain canvas-click brittleness.

## Done when

From the web app and local play, a person controls the seat's primary unit with a companion or controls the whole skirmish side: composes and revises a multi-step move with illegal continuations never offered, sees an informational automatic-strike preview, confirms a `{path, target: 0}` order through the single icon button, watches fog switch between perspectives, and sees a timeout land as stand-still-and-strike. The mask-agreement suite and all tests above are green.
