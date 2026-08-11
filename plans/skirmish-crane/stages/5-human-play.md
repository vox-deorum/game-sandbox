# Step 5: Human Play

Status: complete.

Part of [the Skirmish at Crane Reach plan](../README.md). This is build-order step 5: a human plays Skirmish at Crane Reach in the browser and in local play, with fog of war, legal-by-construction order composition, and the move clock. The hands-on surface is controlling a seat's primary unit or the whole side, in the web app and through both local launchers with naive companions.

## Why this is its own seam

The input layer contains the riskiest renderer deliverable: a TypeScript legality computation. The [environment spec](../environment.md) requires the renderer to compute the acting controlled player's walkable paths and nameable targets from the overlay state. Keeping this logic in the renderer keeps production recordings and streams compact. Its safety net, the mask-agreement suite, is substantial work of its own, and this step is complete only when the browser's legality equals the environment's.

## What to build

### Legality from the overlay

A renderer-local module computes, for the acting controlled player, the walkable path set and the nameable target set from the overlay state alone. Its scope is step costs, occupancy, the always-permitted first step, the four-step limit, and the visibility sets the overlay already carries. It grows the step 4.2 reachability helper, which already computes destination sets for the movement-range displays, into full path enumeration. The full target set remains part of mask agreement for the agent contract. Human input always sends `target: 0` and uses the projected final tile to preview its automatic strike.

Costs and passability are read from the `tile_types.json` the rules engine reads, so those cannot drift. Occupancy counts every living unit, including units the perspective is hiding, because that is what the environment's own mask counts; a person is never offered a step the environment would reject. Nameability is visibility alone, taken from the overlay's per-player visibility masks, so an enemy well outside strike range stays nameable.

### Order composition

Legal-by-construction, per the [step 4.2 interaction design](4-2-hud.md):

- Click an adjacent highlighted hex to append a step, up to four; only legal continuations are ever highlighted. Undo, reselect, or reset the path. An empty path is stay.
- Each endpoint change previews the automatic strike from the projected final tile as a dashed ink thread to the nearest in-range enemy, one thread per candidate when several tie, and nothing at all when none is in range. The preview reads only the enemies the person can see, so it never reveals a unit the fog is hiding and may be wrong about an unseen one. It carries no text, is informational, and never sends an action.
- A centered two-button pair occupies the lower strip: Reset on the left and Confirm on the right. Reset uses `glyph-reset.png`, is always drawn but muted and inactive with an empty path, and has accessible name and tooltip `Reset movement`. After at least one selected step, Reset clears only the selected path, restores the full movement allowance, and recomputes the automatic-strike preview from the origin. It submits nothing and does not restart the move clock. Confirm uses `glyph-move.png`, has accessible name and tooltip `Confirm order`, and sends `{path, target: 0}` through `sendAction`.
- No auto-routing: click-to-destination pathfinding is deliberately absent, because pathfinding is the student's work in this course.

The composed path's own tiles remain revision controls: the current endpoint takes that step back, and the unit's own tile clears the path. Clearing wins on the unit's tile even when the path could legally walk back onto it.

The offered continuations are the unit's movement range while it is being ordered, so no range wash is drawn under them and hovering it opens its card alone. The activated unit's seal fades from full opacity to 0.35 and back over 1.6 seconds during open human composition only. Reduced motion keeps it steady, as do spectate, replay, and event seals. Movement pips do not appear beside the activated unit. Chosen tiles carry mono step numerals baked at host scale times camera zoom so they remain sharp while zooming. `CRANE_TIMING` owns the settled-frame holds: a locally controlled order holds for 300 ms and every other visible watched event holds for 200 ms. Snap and invisible updates do not hold. Human mode therefore uses the longer hold for the viewer's own orders and the watched-event hold for companion and opponent events, while spectate and replay use the watched-event hold. The view then centres every new activation the perspective can see, your own units and visible enemies alike, so the turn coming back to you is never off screen. A unit the perspective cannot see is never followed, a viewer who controls nobody is never moved, and the fitted zoom already shows the whole board, so it moves nothing.

### Fog of war

Implement the perspective rule the [environment spec](../environment.md#rendering-and-human-input) states, driven by `controlledPlayers` and the recording header's seat map: the acting unit's own vision whenever the unit acting belongs to the human's seat, whether the person or a companion is deciding for it, and the union of that seat's living units on an opponent's turn. Terrain is always drawn under the [step 4.1](4-1-art-style.md) glaze: the generated battlefield is standing knowledge in the ruleset.

A living-unit count is not. An agent is told both starting rosters and sees only what is within vision, so it never learns that an ally or an enemy out of sight has died. Under fog both roster strips therefore go, leaving the bottom strip to the order controls; a spectator and a replay viewer keep them. An activation resolved out of sight installs its result without animating, and an actor the perspective cannot see gets neither an activation seal nor a movement-range wash.

### Control modes and the clock

The platform already supports assigning a whole side to one person. This step makes the Crane renderer filter perspective and input through `controlledPlayers`, for either the seat's primary player with companions or the whole side without them. Under whole-side control every activation is a controlled one, so the picture follows the acting unit's own vision from activation to activation.

The harness owns the move budget and substitutes `default_action` once a person has held the controls longer than it, which is platform behavior the UI displays rather than reimplements. The container spends that budget only while the browser reports the controls held, through the `clock` command `RendererContext.setControlHeld` sends. A shared move-clock module under `renderers/base/` is the browser's picture of it: it counts the session's `human_timeout_ms` down from the state that puts a controlled player on the clock, and Crane calls `setControlHeld` with that player in the same place, so the harness and the picture start together. It takes an injectable `now`, so tests drive it from a fake clock. `setPaused` freezes the picture for a playback pause, and Crane releases the controls there, so the real budget holds with it. A page that reconnects mid-turn opens the clock again at the full budget, reading high rather than low, while the harness keeps what it already spent. The cards renderers share the module, so Hearts and Spades count down instead of showing a fixed budget. Crane presents the remaining time as the confirm button's draining border, ember inside the closing ten seconds.

### Local play

Both local launchers support whole-seat play through a `self` companion value. Selecting `self` makes every player in a fully human-capable selected seat externally controlled, while the seat's first declared human-capable player remains the chat sender. Other seats keep their existing assignments.

For `npm run play -- skirmish_crane human`, `scripts/play.py` resolves a seat through `--seat` and defaults a wide human seat's other members to the built-in naive companion. `--companion` continues to accept `self`, `naive`, or a manifest path, and `self` binds every player in the seat as external.

For `python -m sandbox human`, the shared template launcher selects a resolved seat through `--seat`. It defaults to the platform-preferred human-capable seat, choosing a restricted seat first when one exists. The launcher:

- Treats omitted `--companion` and `--companion self` as whole-seat control when every member is human-capable.
- Accepts a declared builtin name or manifest path as a companion. The first human-capable member remains external and the companion controls the rest.
- Derives the designated builtin for a restricted human seat and rejects an explicit companion there.
- Emits `external_chat_player` in its local config.

A mixed-capability wide seat requires an explicit companion because a person cannot control its non-human-capable members. The student guide's local-play commands use seat indices throughout.

## Tests

- The mask-agreement suite, the step's core deliverable: for the opening state and every actionable recorded state in both fixtures, the TypeScript-computed walkable path set and full nameable target set equal the test-only legality masks exactly, path ids included. A visible enemy outside strike range remains nameable even though human input sends `target: 0`.
- Interaction tests (vitest, jsdom): step-by-step composition builds the expected path id, board undo and reselect behave, Reset is inactive with an empty path and active after a selected step, Reset clears the full path and restores movement allowance without an action or clock restart, confirmation through the Confirm icon button sends `{path, target: 0}`, an empty confirmation sends stand-still-and-strike, illegal continuations are never offered, and nothing is clickable without `sendAction`.
- Preview tests cover a unique nearest in-range enemy, tied nearest candidates marked uncertain, no in-range enemy, endpoint changes, reset to the origin, and reduced motion. Activation-seal tests cover the 1.6-second human-composition fade, its reduced-motion steady state, and steady spectate, replay, and event seals. Step-number tests verify mono text is baked at host scale times camera zoom. Event timing tests cover the `CRANE_TIMING` 300 ms controlled-order hold, 200 ms watched-event hold, and no hold for snap or invisible updates. An activation resolved out of sight is proved to install without animating, and one the perspective could see is proved to play out before the fog follows the next unit. Clock tests cover the Confirm button's full perimeter draining clockwise, the ember threshold, a reconnect landing mid-turn, freezing under a playback pause, and fake-clock progression.
- Fog tests cover human turns, companion turns, opponent turns, a controlled unit's death while companions remain, terminal states, reconnect mounting, and direct rendering. Terrain stays complete.
- Human-play tests cover primary-player companion control, whole-side browser control, chat-sender selection, and invalid whole-side requests. Both local launchers are covered, and the template launcher's wide-seat path is tested at the platform level, against an existing wide-seat environment as well as Skirmish at Crane Reach.
- The e2e journey gains its bounded human segment: verify Reset begins inactive, compose a short move, reset it to the empty path without closing Confirm, zoom while a step numeral is visible and verify its baked resolution increases, reread projected coordinates, compose again, and confirm both a move and a stay via canvas clicks.

## Done when

From the web app and local play, a person controls the seat's primary unit with a companion or controls the whole skirmish side: composes, resets, and revises a multi-step move with illegal continuations never offered, sees an informational automatic-strike preview, confirms a `{path, target: 0}` order through the centered Confirm button, sees sharp step numerals while zooming, watches fog switch between perspectives, and sees a timeout land as stand-still-and-strike. The mask-agreement suite and all tests above are green.
