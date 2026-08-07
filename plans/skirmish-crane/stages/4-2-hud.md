# Step 4.2: HUD

Status: complete. The owner approved the HUD design and removed the in-canvas terminal banner on 2026-08-04. Implementation and verification finished on 2026-08-04.

Part of [the Skirmish at Crane Reach plan](../README.md). This is build-order step 4.2: the information layer inside the canvas, styled over the [step 4.1](4-1-art-style.md) board: the round and score strip, rosters, the unit hover chip, and the interaction UI design that step 5 wires up. Attack results and the current activation are not HUD text: the step 4.1 event animations and the gilt activation highlight carry them on the board, and this step removes the step 3 placeholder caption and activation lines. Review replays both fixture recordings with the finished HUD and confirms that hovering a unit shows its chip.

## Why this is its own seam

The HUD is information design: what a spectator needs at 40 units, in which typeface, at which weight. Splitting it from the board art lets layout be reviewed as text mockups before any drawing, and keeps the step 4.1 painterly review uncluttered by label churn. The step 5 interaction affordances are specified here because they are UI chrome (chips, seals, the clock) built from the step 4.1 vocabulary; the working input code stays in step 5.

## What to build

### Typography

Canvas typography adopts the host's families deliberately: Lato (fallback system-ui) for labels and ui-monospace for every number and identifier, including round, scores, damage, and the hover chip. The host pages already load the families; the renderer names them with fallbacks and never fetches fonts. Colors come from the step 4.1 palette: bone for primary text, faded ink for secondary. Every icon-and-text row uses one shared centerline layout in both reading directions. HUD labels use the larger 16 to 30 px scale, and inspection-card labels use 17 px type.

### Canvas layout

The scene stays 1200 x 860 with the board between y 90 and 746. The HUD occupies the strips above and below.

```
+--------------------------------------------------------------------+
|  ROUND 47                                 (R) 128   (B)  96 / 200  |
|                                                                    |
|                                                                    |
|                      the painted battlefield                       |
|                                                                    |
|                                                                    |
|                                                                    |
|  [f]8 [a]5 [c]6                                   [f]7 [a]4 [c]5   |
+--------------------------------------------------------------------+
```

Legend, used in every mockup below: `(R)` and `(B)` are painted seal dots in cinnabar and indigo, not letters. `[f]`, `[a]`, `[c]` are the footman sword, archer bow, and cavalry horse glyphs from the asset manifest, tinted the side color.

### Top strip (y 24 to 64)

The top and bottom strips are screen-fixed above the [step 4.3 camera](4-3-camera.md) world view. At the default fit, the full board remains visible and may extend below the sparse strips near the field edges.

- Left: `ROUND` in 16 px Lato caps, faded ink, then the round number in 30 px bone mono.
- Right: the capture score as a cinnabar seal dot with Red's number, an indigo seal dot with Blue's number, then `/ 200` in faded ink. Without the capture variant the right side is empty.
- Each populated corner group has a rounded rectangular, semi-translucent night-ink field behind it. The field uses the scene backdrop color and remains fixed above the moving board.

```
  ROUND 47                                  (R) 128   (B)  96 / 200
```

### Bottom strip (y 760 to 844)

- Left: Red's roster as three glyph-plus-count pairs, using the weapon and horse glyphs at roughly 30 px tinted cinnabar, with 26 px mono counts; losses show through the counts. Right: Blue's mirrored in indigo. Hovering a pair opens its type card. On touch, tap a pair to open its card; tapping elsewhere dismisses it and tapping another pair replaces it.
- A type card has the type name and maximum hit points, movement, damage, attack range, and vision fields. Every field pairs its icon with its short text label and value: `HP`, `MOV`, `ATK`, `RNG`, and `VIS`. When `unit_abilities` is on, the footman card adds `{skill} shield_wall` and the cavalry card adds `{skill} charge` on a separate line; the archer has no skill line. Cards show no skill text when the variant is off.
- The strip carries no event or activation text. An attack and its damage play as the step 4.1 event animations, and the actor reads from the gilt activation highlight, so the HUD repeats neither. The center stays clear; on a human turn the step 5 order controls live there.

```
  [f]8 [a]5 [c]6                                   [f]7 [a]4 [c]5
```

```
   +-----------------------------+
   | FOOTMAN                     |
   | {hp} HP 12       {move} MOV 2   |
   | {attack} ATK 3   {range} RNG 1  |
   | {vision} VIS 4                  |
   | {skill} shield_wall         |
   +-----------------------------+
```

### Movement range on the board

- The acting unit shows its movement range through activation and movement during watch and replay. It clears the moment the attack or a capture reaction starts, before the next actor's range appears. Every tile it could reach this activation takes a soft gilt wash at alpha 0.10, with a thin gilt outline around the reachable set, extending the activation highlight.
- While any unit is hovered, its bone range wash and dashed outline replace only the acting unit's soft gilt reachability wash and outline. Non-bubbling unit enter and leave events keep this range stable while the pointer crosses the figure's child artwork. The inspected range retains ownership through another unit's activation, movement, attack, and reaction, so the actor's range never replaces or clears it. The activation seal-ring remains visible. On a human turn, continuation, path, and endpoint composition marks stay above the hover display. Leaving the unit restores the acting unit's soft reachability display when event timing permits it.
- Reachability comes from a renderer-local helper over the overlay state: step costs, occupancy, the always-permitted first step, the four-step limit. Step 5 grows this helper into the full legality module and proves it against the environment's masks.

### The unit hover chip

Hovering a unit inspects it. On touch, tap a unit to open its chip; tapping elsewhere or a different unit dismisses or replaces it:

- A parchment chip appears beside the unit: the unit id, current and maximum hit points, movement, damage, attack range, and vision in icon, label, and value fields on a parchment fill with a dilute-ink border. When `terrain` is on, a board-unit card adds `{terrain} terrain {feature} feature` for its current tile. When `unit_abilities` is on, the following line adds `{skill} shield_wall` for footmen or `{skill} charge` for cavalry. Roster cards have no current tile and omit terrain context. The chip completes the step 4.1 rim gauge, which shows state but not numerals.
- The hovered unit wears a temporary bone highlight ring for as long as the hover lasts.
- Its movement range appears on the board: reachable tiles take a bone wash at alpha 0.18 inside a dashed dilute-ink outline around the set.

```
   +-----------------------------+
   | red_archer_2               |
   | {hp} HP 4/6     {move} MOV 2   |
   | {attack} ATK 2  {range} RNG 6  |
   | {vision} VIS 6                 |
   | {terrain} hill {feature} forest|
   +-----------------------------+
```

The chip is view-only and never blocks the board.

### Match end

The canvas keeps the normal round, capture, and roster strips at match end. The host owns the game-over result and presents it outside the renderer. Terminal state still suppresses movement range and inspection cards.

### Interaction UI for step 5 (design only; the working input code is step 5)

On a human-controlled activation the order controls occupy the bottom strip's clear center, and the board affordances use the step 4.1 gilt and ember vocabulary. Hover inspection stays available, but the gilt composition marks always draw above hover washes and are never suppressed by them:

- Choose a step: the activated unit wears the gilt seal-ring. During open human composition only, it fades from full opacity to 0.35 and back over 1.6 seconds. Reduced motion keeps it steady. Every legal continuation hex takes a gilt wash at alpha 0.25 with a small ink dot at center; nothing else is clickable. Those continuations are the unit's movement range while it is being ordered, so neither its own range wash nor a hover wash is drawn under them, and hovering it opens its card alone. Selecting an adjacent continuation extends the path, and its tile becomes the current endpoint. No movement pips appear beside the unit.
- The composed path: chosen tiles connect with a wet-ink gilt stroke, each carrying its step number in small mono text baked at host scale times camera zoom, so it stays sharp while zooming. The final tile shows the unit ghosted at alpha 0.5. Continuations stay highlighted until four steps are placed or none remain legal.
- Reset, reselect, or undo: a centered two-button pair occupies the lower strip, with Reset on the left and Confirm on the right. Reset uses `glyph-reset.png`, is always drawn, and is muted and inactive until at least one step is selected. Its accessible name and tooltip are `Reset movement`. When active, it clears the full selected path, restores full movement allowance, and recomputes the automatic-strike preview from the origin without submitting an action or restarting the move clock. Clicking the last path tile still removes that step, clicking the activated unit still clears the path, and the reverted tile's highlight pulses once.
- Automatic-strike preview: every endpoint change shows an informational ink thread from the projected final tile to the nearest in-range enemy, at the ranged arc's weight and dashed on a fixed rhythm so an adjacent strike reads the same as a distant one. Candidates tied for nearest each get their own thread, which is what says the strike is a draw between them; there is no caption. When no enemy is in range, there is no preview. The preview reads the enemies the person can see, sends nothing, and never advances the match. Under reduced motion it snaps to the final highlight.
- Confirm: the right icon button uses `glyph-move.png`, with accessible name and tooltip `Confirm order`. It sends the selected path with `target: 0`; with an empty path it sends the usual stand-still-and-strike order.
- The move clock: the confirm button's full gilt perimeter is the authoritative move-clock fill. It drains clockwise to empty and turns ember under 10 seconds. There is no separate countdown. A timeout resolves as stand-still-and-strike, playing as the usual event animation.

```
  [f]8 [a]5 [c]6           ( {reset} ) ( {move} )           [f]7 [a]4 [c]5
```

## Tests

- Scene tests assert the HUD content: round text, both capture readouts and their absence without the variant, roster counts falling as units die, icon-led stat fields, board-only terrain context, typed skill lines only for enabled abilities, terminal range and inspection suppression, and that no caption or activation text remains.
- Hover and touch jsdom tests cover board-unit and roster-pair chips: their stat fields, ability variants, opening, replacement, dismissal behavior, stable board-unit highlight, inspected-range precedence through another unit's event, and that nothing sends actions in a draw-only mount.
- The reachability helper is covered on hand-built boards (terrain costs, occupancy, the always-permitted first step, the four-step limit) and, for acting units, against the destination sets implied by the fixture legality files.
- The step 4.1 perf smoke stays green with the styled HUD and the acting unit's range wash on the army fixture.
- The e2e spectate journey keeps one non-acting unit hovered across an event and asserts that every observed range owner remains that unit.
- Human-control coverage verifies the faded activation seal only during open composition, steady seals under reduced motion and outside human composition, absent movement pips, reset activation after a selected step, reset restoration of the empty path and movement allowance without an action or clock restart, and sharp step-number resolution after zooming.
- Event timing coverage verifies the centralized `CRANE_TIMING` settled-frame holds: 300 ms for a locally controlled order, 200 ms for every other visible watched event, and none for snap or invisible updates.

## Done when

Both fixtures replay with the strips and rosters styled as mocked above, including terminal frames, every board unit and roster pair opens its complete icon-led chip, the acting unit's movement range shows on the board, board-unit inspection has priority over the acting unit's range, and the two-button human interaction design is ready for step 5. The art direction note gains its HUD section, the tests above are green, and the owner's sign-off is recorded in the Status line.
