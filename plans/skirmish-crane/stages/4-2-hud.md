# Step 4.2: HUD

Status: planned. This file carries the first design draft; exit requires explicit owner sign-off on the HUD design, recorded here.

Part of [the Skirmish at Crane Reach plan](../README.md). This is build-order step 4.2: the information layer inside the canvas, styled over the [step 4.1](4-1-art-style.md) board: the round and score strip, rosters, the unit hover chip, the terminal banner, and the interaction UI design that step 5 wires up. Attack results and the current activation are not HUD text: the step 4.1 event animations and the gilt activation highlight carry them on the board, and this step removes the step 3 placeholder caption and activation lines. The hands-on surface is both fixture recordings replaying with the finished HUD, and hovering any unit showing its chip.

## Why this is its own seam

The HUD is information design: what a spectator needs at 40 units, in which typeface, at which weight. Splitting it from the board art lets layout be reviewed as text mockups before any drawing, and keeps the step 4.1 painterly review uncluttered by label churn. The step 5 interaction affordances are specified here because they are UI chrome (chips, seals, the clock) built from the step 4.1 vocabulary; the working input code stays in step 5.

## What to build

### Typography

Canvas typography adopts the host's families deliberately: EB Garamond (fallback Georgia, serif) for the terminal banner headline, Lato (fallback system-ui) for labels, ui-monospace for every number and identifier: round, scores, damage, the hover chip, the clock. The host pages already load the families; the renderer names them with fallbacks and never fetches fonts. Colors come from the step 4.1 palette: bone for primary text, faded ink for secondary.

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

Legend, used in every mockup below: `(R)` and `(B)` are painted seal dots in cinnabar and indigo, not letters. `[f]`, `[a]`, `[c]` are the footman, archer, and cavalry figure silhouettes, the near-zoom close-up set from the atlas, tinted the side color.

### Top strip (y 24 to 64)

- Left: `ROUND` in small Lato caps, faded ink, then the round number in 28 px bone mono.
- Right: the capture score as a cinnabar seal dot with Red's number, an indigo seal dot with Blue's number, then `/ 200` in faded ink. Without the capture variant the right side is empty.

```
  ROUND 47                                  (R) 128   (B)  96 / 200
```

### Bottom strip (y 760 to 844)

- Left: Red's roster as three figure-plus-count pairs, the close-up silhouettes at roughly 28 px tinted cinnabar, with mono counts; losses show through the counts. Right: Blue's mirrored in indigo.
- The strip carries no event or activation text. An attack and its damage play as the step 4.1 event animations, and the actor reads from the gilt activation highlight, so the HUD repeats neither. The center stays clear; on a human turn the step 5 order controls live there.

```
  [f]8 [a]5 [c]6                                   [f]7 [a]4 [c]5
```

### Movement range on the board

- The acting unit always shows its movement range during watch and replay: every tile it could reach this activation takes a soft gilt wash at alpha 0.10, with a thin gilt outline around the reachable set, extending the activation highlight.
- Hover takes priority: while any unit is hovered, its bone range display (below) replaces the acting unit's gilt one, and the hovered unit's temporary highlight ring marks why. Leaving the hover restores the acting unit's range.
- Reachability comes from a renderer-local helper over the overlay state: step costs, occupancy, the always-permitted first step, the four-step limit. Step 5 grows this helper into the full legality module and proves it against the environment's masks.

### The unit hover chip

Hovering a unit (or pressing it on touch) inspects it:

- A parchment chip appears beside the unit: the unit id, hit points, attack, and range in mono on a parchment fill with a dilute-ink border. It completes the step 4.1 rim gauge, which shows state but not numerals.
- The hovered unit wears a temporary bone highlight ring for as long as the hover lasts.
- Its movement range appears on the board: reachable tiles take a bone wash at alpha 0.18 inside a dashed dilute-ink outline around the set.

```
   +--------------+
   | red_archer_2 |
   | hp  4 / 6    |
   | atk 2  rng 6 |
   +--------------+
```

The chip is view-only and never blocks the board.

### Terminal banner

At match end the bottom strip is replaced by a centered parchment card, 560 x 72: parchment fill, the crane glyph at the left edge, `Battle complete` in EB Garamond, the outcome in mono. The card's border and headline tint toward the winner, cinnabar or indigo, and stay dilute ink on a draw.

```
        +--------------------------------------------------+
        |  {crane}   Battle complete                        |
        |            red wins 84 - 16                       |
        +--------------------------------------------------+
```

`{crane}` is the crane glyph from the atlas. The example border reads cinnabar because Red won.

### Interaction UI for step 5 (design only; the working input code is step 5)

On a human-controlled activation the order controls occupy the bottom strip's clear center, and the board affordances use the step 4.1 gilt and ember vocabulary. Hover inspection stays available, but the gilt composition marks always draw above hover washes and are never suppressed by them:

- Choose a step: the activated unit wears the gilt seal-ring. Every legal continuation hex takes a gilt wash at alpha 0.25 with a small ink dot at center; nothing else is clickable. Remaining movement shows as gilt pips beside the unit.
- The composed path: chosen tiles connect with a wet-ink gilt stroke, each carrying its step number in small mono. The final tile shows the unit ghosted at alpha 0.5. Continuations stay highlighted until four steps are placed or none remain legal.
- Undo: clicking the last path tile removes that step; clicking the activated unit clears the path. The reverted tile's highlight pulses once.
- Name a target: every nameable enemy (every visible living enemy) wears the seal-ring tinted ember with a thin bone inner ring, filled when the final tile puts it in strike range, hollow when naming it would fall to the automatic draw. Clicking names it; the named seal thickens and a hairline ink thread connects the final tile to it.
- Confirm: a parchment chip bottom-center reads `Confirm order`, or `Stand fast` with an empty path, bone text with a gilt border, and a ghost `Reset` chip beside it.
- The move clock: the 30 second clock drains as a gilt arc around the activation ring, with a mono countdown under the chips. Under 10 seconds the arc and countdown turn ember. A timeout resolves as stand-still-and-strike, playing as the usual event animation.

```
  [f]8 [a]5 [c]6         ( Confirm order )  ( Reset )         [f]7 [a]4 [c]5
                                  0:23
```

## Tests

- Scene tests assert the HUD content: round text, both capture readouts and their absence without the variant, roster counts falling as units die, the winner-tinted terminal banner (cinnabar, indigo, and draw cases), and that no caption or activation text remains.
- The hover has a jsdom pointer test: the chip shows the id, hit points, attack, and range, the highlight ring appears, the hovered unit's range wash replaces the acting unit's, leaving restores both, and nothing sends actions in a draw-only mount.
- The reachability helper is covered on hand-built boards (terrain costs, occupancy, the always-permitted first step, the four-step limit) and, for acting units, against the destination sets implied by the fixture legality files.
- The step 4.1 perf smoke stays green with the styled HUD and the acting unit's range wash on the army fixture.
- The e2e spectate journey stays green (it asserts on behavior, not pixels).

## Done when

Both fixtures replay with the strips, rosters, and terminal banner styled as mocked above, the acting unit's movement range shows on the board, hovering any unit shows its chip, highlight ring, and range with priority over the acting unit's, the interaction design is ready for step 5 to implement against, the art direction note gains its HUD section, the tests above are green, and the owner's sign-off is recorded in the Status line.

## Open items for the review round

1. The hover chip on touch devices: press-and-hold duration and dismissal.
2. Roster pairs at skirmish scale: whether three one-count pairs per side earn their space, or the skirmish plan shows unit ids instead.
3. Whether the acting unit's always-on range wash stays calm at army scale, or should show only while its activation resolves.
