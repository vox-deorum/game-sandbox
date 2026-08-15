# Step 5.2: HUD and interaction design

Status: in progress. The owner fixed the design decisions below on 2026-08-14 and approved the mockups for implementation. The information layer, the display-name hook, and the unified camera have landed. The step 6 input specification is recorded here and builds in step 6. Owner sign-off on the rendered result remains.

Part of [the plan](../README.md). This second signed part of build-order step 5 turns [step 3](3-renderer-and-registration.md)'s provisional chrome into the village information layer, specifies [step 6](6-human-play.md)'s input UI, and may retune the art-driven camera ceiling established in [step 5.1](5-1-art-style.md) under the final HUD. Review the pinned fixture under the full HUD at fitted and close views.

## Why this is its own seam

Step 6 implements only the owner-approved input design. Step 5.1 sets a close-inspection ceiling from the Terrain source resolution. The fixed HUD may refine that ceiling and the focus zoom here.

## Ordered path

1. Author text mockups and control semantics for the information layer and step 6 controls.
2. Get owner approval before input implementation begins.
3. Implement or refine the viewer HUD from the approved mockups.
4. Retune and test the step 3 camera only where the fixed HUD changes close-view readability.
5. Record the approved step 6 input specification and the collision overlay's shipped default in this file.

## Information layer

The information layer serves watch, replay, and play, and is never colour-graded. [The environment speech contract](../environment.md#speech) is authoritative for delivery and visibility: watchers and replay viewers see every delivered line, and the playing visitor sees broadcasts delivered to it and direct lines sent to or from it. The renderer draws only server-admitted lines and never filters them itself.

### Chrome strip

```text
+------------------------------------------------------------------+
| Morning · Tick 412         (bell) rings    [Collision] [Recenter] |
+------------------------------------------------------------------+
```

The 54-unit strip keeps its step 3 layout seam and adopts a thematic Hearthside look in place of the diagnostic palette: a parchment field with subtle texture, ink text, and timber button plates. From left to right:

- Phase and tick. The opening state reads `Opening · Tick 1`, and the terminal frame appends `Complete`.
- A bell indicator: a small drawn bell icon before its state word, toggling between `rings` and `silent`. The icon takes a gilt accent while ringing. A village without a bell omits the indicator.
- The collision toggle button, off by default. The C key is its keyboard access. Toggling never resets the camera.
- A Recenter button with the double-click reset behavior: recenter on the current visitor at the focus zoom and resume follow.

### Nameplates

```text
                .--------------------.
                | Fine morning, no?  |
                | (to npc_2)         |
                '---.----------------'
                     v
                 [visitor]
                     o           o [npc_2]
```

Each character carries a nameplate pill with its character id above its sprite: a cinnabar accent for the visitor, ink for NPCs. Plates fade in near the focus zoom and hide at far zooms, sharing one readability threshold with step 5.1's far-zoom character marks. A plate and a bubble hold one size on screen at every zoom, so they counter-scale against the camera and their text needs no zoom-dependent resolution.

### Speech bubbles

A delivered line draws a parchment bubble with ink text and a tail to its speaker. A direct line carries a small `to npc_2` style tag; a broadcast is untagged. A bubble wraps to at most four lines and elides the rest; the transcript always carries the full line. A bubble holds for about four seconds and fades, and a character's newer line replaces its older bubble. Live sessions accumulate bubbles as states arrive. A replay seek clears them and shows only the landed tick's lines, preserving step 3's seek determinism.

### Chat transcript

```text
visitor    Fine morning, no?     to npc_2
npc_0      The pump sticks.      broadcast
Recipient: [ Everyone | npc_0 | npc_2 ]   [ Send ]
```

The shared host chat panel is the transcript on the session and replay pages. The hook is minimal and string-level: a renderer definition may supply a per-player display-name map, and the pages thread it into the panels, which apply it exactly where `formatPlayer` renders a player id today, the entry's player string, the `to` badge, and the recipient options. Markup, slots, styling, and the attribution label beside the name do not change. Three Branches maps `player_0` to `visitor` and `player_i` to `npc_(i-1)`, the order `overlay.ts` already derives. The selector offers Everyone for broadcast plus the currently permitted character-id addressees from `chat_options`. The hook is recorded in [docs/specs/interaction.md](../../../docs/specs/interaction.md).

### Camera

One policy serves watch, replay, and play. The camera opens on the visitor at the focus zoom and follows its movement. Pan, wheel zoom, or pinch suspends following for inspection. The Recenter button, double-click, or double-tap recenters on the current visitor at the focus zoom and resumes following. Following does not depend on who controls the visitor; step 6 reads `ctx.controlledPlayers` for input ownership only.

Zoom limits keep the fitted whole-village view and step 5.1's sixteen-times close ceiling. The focus zoom may rise if bubble and nameplate readability at the focused view requires it, judged over the pinned fixture under the full HUD.

## Step 6 input specification

Step 6 implements this specification without further design work. Controls appear only while `player_0` is human-controlled. Spectators and replay viewers have no input.

### Locomotion

```text
+--------------------------------------------+
| chrome strip                               |
+--------------------------------------------+
|                world                       |
| .------.                                   |
| (  (o)   )     fixed movement pad          |
| '------'                                   |
+--------------------------------------------+
```

- A permanent virtual joystick sits in the bottom-left of the content area for pointer and touch. A primary press inside its ring engages the fixed pad. Dragging sets heading from the drag angle and relative speed from the drag distance, with a 15 percent dead zone and full speed at the pad ring. Release stops the visitor and returns the knob to the center. Presses outside the pad and expression palette keep the camera gestures, including the double-click or double-tap that resumes visitor follow.
- Keyboard locomotion uses WASD and the arrow keys for eight-way headings at full speed. Holding Shift halves the speed. Opposing keys cancel on their axis, and cancelling on both axes yields no keyboard heading.
- Input composes once per 250 millisecond window: an engaged joystick wins, held keys apply otherwise, and neither yields speed 0 with the current heading, the environment default.

### Expression palette

```text
+---------+---------+---------+
| Wave    | Nod     | Shake   |   1 2 3
+---------+---------+---------+
| Point   | Laugh   | Shrug   |   4 5 6
+---------+---------+---------+
| Startle | Sleep   | Sweep   |   7 8 9
+---------+---------+---------+
          +---------+
          |   Use   |   0
          +---------+
```

- A 3 by 3 emote grid sits in the lower right of the content area, in ruleset order, with hotkeys 1 through 9.
- Use is a separate button beside the grid with hotkey 0.
- Hovering Use highlights the prop a use would select under the environment's reach-plus-unblocked-line rule. The palette is drawn on the canvas, so pointer hover is the preview affordance and hotkey 0 is the keyboard access to use itself. The preview is informational and never sends.
- A pressed control sets the expression on the next composed action window. The last press in a window wins, and the window sends no expression when nothing was pressed.

### Chat input

The shared panel's composer sends broadcasts and direct lines through the recipient selector above. The 200 code point cap and the speech contract govern sending and delivery.

## Tests

- Renderer unit tests cover the chrome elements and their states, the collision overlay's off default and C toggle, nameplate zoom gating, bubble tagging, wrapping, replacement, and seek clearing, unified camera follow, suspension, and reset, and tuned fixture zoom limits.
- Shared panel tests cover the display-name hook in chat rows, badges, and the recipient selector on the session and replay pages.
- The Three Branches browser journeys cover the off collision default, the button, the C key, Recenter, the permanent joystick, and visitor camera follow during live play.
- Update locators whenever markup moves.
- Run the Three Branches browser e2e group while iterating. Before handoff, run the bare full browser e2e suite.

## Done when

The fixture replays under the full HUD and remains usable close up. The information layer above is implemented, the step 6 input specification is approved and recorded here, the bare full browser e2e suite passes, and this status line records the owner's sign-off.
