# Step 5.2: HUD and interaction design

Status: in progress. Existing HUD and input design are complete; character-expression art and final owner review remain.

Part of [the plan](../README.md). This second signed part of build-order step 5 turns [step 3](3-renderer-and-registration.md)'s provisional chrome into the village information layer, specifies [step 6](6-human-play.md)'s input UI, and may retune the art-driven camera ceiling established in [step 5.1](5-1-art-style.md) under the final HUD. Review the pinned fixture under the full HUD at fitted and close views.

## Why this is its own seam

Step 6 implements only the owner-approved input design. Step 5.1 sets a close-inspection ceiling from the Terrain source resolution. The fixed HUD may refine that ceiling and the focus zoom here.

## Ordered path

1. Author text mockups and control semantics for the information layer and step 6 controls.
2. Get owner approval before input implementation begins.
3. Implement or refine the viewer HUD from the approved mockups.
4. Add the recorded-expression marks below and get owner approval across the full cast and zoom range.
5. Retune and test the step 3 camera only where the fixed HUD changes close-view readability.
6. Record the approved step 6 input specification and the collision overlay's shipped default in this file.
7. After every required step 5.1 and 5.2 unit is signed off, run the optional embodied-arm study and record whether its result replaces or leaves the required mark treatment.

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
- A Recenter button with the double-click reset behavior: recenter on the current visitor at the current zoom and resume follow.

### Nameplates

```text
                .--------------------.
                | Fine morning, no?  |
                | (to player_3)      |
                '---.----------------'
                     v
                 [player_0]
                     o           o [player_3]
```

Each character carries a nameplate pill with its raw player id above its sprite: a cinnabar accent for `player_0`, the visitor, and ink for NPCs. Plates fade in near the focus zoom and hide at far zooms, sharing one readability threshold with step 5.1's far-zoom character marks. A plate and a bubble hold one size on screen at every zoom, so they counter-scale against the camera and their text needs no zoom-dependent resolution.

### Character expressions

Every target scene expression other than `none` draws a compact parchment chip above its character. The chip combines a tintable Hearthside Ink pictogram with the same title-cased text used by the expression palette. It stays upright, counter-scales with the camera, and lives in the ungraded annotation layer. The vertical stack is character, nameplate, expression chip, then speech bubble; the bubble moves above an active chip instead of overlapping it.

| Expression   | Text       | Pictogram direction                           |
| ------------ | ---------- | --------------------------------------------- |
| `wave`       | Wave       | Raised hand with two greeting strokes         |
| `nod`        | Nod        | Head mark with a short vertical motion stroke |
| `shake_head` | Shake Head | Head mark with paired side strokes            |
| `point`      | Point      | Hand and one clear outward direction stroke   |
| `laugh`      | Laugh      | Open smile with two light radiating marks     |
| `shrug`      | Shrug      | Paired raised hands and shoulder arc          |
| `startle`    | Startle    | Compact burst around an upright figure mark   |
| `sleep`      | Sleep      | Closed eye with one rising rest mark          |
| `sweep`      | Sweep      | Small broom and curved floor stroke           |
| `use`        | Use        | Hand meeting a simple object square           |

The chip reflects only the expression in the target recorded scene. `none` removes it immediately. Repeating one token keeps the same chip without a restart, hold timer, or release fade. Its subtle accent phase is a pure function of player id, expression type, and absolute fractional presentation tick, so a live transition, repeated state, replay, and direct seek draw the same result. The icon and text remain steady while only the restrained accent changes, avoiding a blinking label. Expression drawing never replaces walking, position interpolation, or recorded heading, because locomotion and expression may occur together.

The expression chip is visible only when the existing nameplate zoom function is fully opaque, the same exact threshold at which step 5.1 hides the far-view character mark. It stays hidden throughout the nameplate fade band and fitted far view, so an expression never appears beside the simplified character mark. Speech bubbles retain their independent delivery, hold, fade, and seek rules.

The required art adds ten grayscale-alpha pictograms and two shared accent frames to the effects page. The page grows from a 7 by 4 grid at 1344 by 512 pixels to a 10 by 4 grid at 1920 by 512 pixels, retaining 192 by 128 pixel runtime frames. Its 384 by 256 source cells live on a 3840 by 1024 source page. Landing it updates step 5.0's effects row from 28 to 40 and its non-props loose-frame total from 128 to 140. `presentation.json` owns the ten frame mappings, ink treatment, accent frames, and a positive fractional-tick frame ratio. Ruleset tokens and the existing title-casing helper remain authoritative for text.

Extend the retained annotation node with the expression chip and install its sliced effects textures after artwork loads. Reconciliation creates the parchment plate and text before artwork is available; a failed or pending art load therefore leaves a readable text-only chip rather than dropping the expression. Installing art adds the retained pictogram and accent children without replacing the node. Selection and accent-phase math stay pure and separately testable.

The `use` chip names the target prop's catalog activity rather than the token: Sitting, Working Pump, Ringing Bell, Tending Shrine, or Reading Board, falling back to `Use` only when the recorded target is absent from the scene. The ten pictograms and two accent frames ship as fully transparent placeholder PNGs; the real art lands later as a pure repaint of those twelve effects-page frames, with no renderer change. The status below stays open until the real art and the owner review land.

#### Final embodied-arm study

The pictogram-and-text treatment above is the required delivery. Only after every required step 5.1 and 5.2 unit has owner sign-off, author one arm-mask pose each for `wave`, `point`, `shrug`, and `sweep`. The chip remains present for all ten expressions. During these four expressions, the trial pose replaces only the arms mask; body and clothing keep their rest or walk frame, details stay fixed, and the complete character keeps its recorded rotation.

The trial temporarily expands the arms page from four frames in a 4 by 1 grid at 768 by 192 pixels to eight frames in a 4 by 2 grid at 768 by 384 pixels. Update the manifest, source-art original and metadata, loose files, compiled page, and atlas tests together. Review the four poses at rest, moving, and turning. If the owner accepts them, retain them, update the step 5.0 character-page table to record eight arms frames and its non-props total from 140 to 144, amend the step 5.1 character contract, and repeat its narrow character sign-off. If the owner rejects them, delete the trial loose frames and code, restore the four-frame manifest, compiled page, source-art original and metadata, restore step 5.0's character-page table to four frames per layer and its total to 140, restore the step 5.1 character contract and its pre-trial sign-off state, and record the required pictogram-and-text treatment as final.

### Speech bubbles

A delivered line draws a parchment bubble with ink text and a tail to its speaker. A direct line carries a small `to player_3` style tag; a broadcast is untagged. A bubble wraps to at most four lines and elides the rest; the transcript always carries the full line. A bubble holds for about four seconds and fades, and a character's newer line replaces its older bubble. Live sessions accumulate bubbles as states arrive. A replay seek clears them and shows only the landed tick's lines, preserving step 3's seek determinism.

### Chat transcript

```text
P0         Fine morning, no?     to P3
P1         The pump sticks.      broadcast
Recipient: [ Everyone | P1 | P3 ]   [ Send ]
```

The shared host chat panel is the transcript on the session and replay pages. It uses the platform's standard compact `P0`, `P1`, and similar formatting for canonical player ids. Renderer definitions provide no environment-specific name map. The selector offers Everyone for broadcast plus the currently permitted player-id addressees from `chat_options`. Canvas nameplates and bubbles keep the raw `player_i` values carried by the recording.

### Camera

The camera opens on the visitor at the focus zoom and follows its movement. Pan, wheel zoom, or pinch suspends following for inspection. Watch and replay hold the inspected view until Recenter. In live visitor play, releasing manual camera control while the visitor is moving starts a gradual return to the visitor. Further manual input cancels the return. The Recenter button, double-click, or double-tap centers on the current visitor immediately and resumes following. Return and Recenter preserve the current zoom.

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
- Input composes and sends once per landed frame, the environment's 250 millisecond tick cadence: an engaged joystick wins, held keys apply otherwise, and neither yields speed 0 with the current heading, the environment default.

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
- Hovering Use highlights the prop a use would select under the environment's reach-plus-unblocked-line rule. The palette is drawn on the canvas, so pointer hover is the preview affordance and hotkey 0 is the keyboard access to use itself. The preview is informational and never sends. The highlight owns its own layer above the emissives and outside both [step 5.1](5-1-art-style.md#day-phase) world grades, so hovering a prop never shifts its colour.
- A pressed control sets the expression on the next composed action frame. The last press in a frame wins, and the frame sends no expression when nothing was pressed.
- Use is a latch, not a one-window press: while latched and standing still, every landed frame composes use again until the visitor presses Use or hotkey 0 again, presses any emote, begins moving, or the landing pose drops the selected prop out of reach. A target whose catalog transition is `toggle` or `none` releases itself after its first send, because one flip is the whole interaction; only `occupancy` and `timed` props keep the latch. While the visitor is moving, the Use plate paints dim and ignores presses and hotkey 0. Composing on landed frames instead of a free-running timer guarantees exactly one action per tick, so a missed or doubled window can no longer swallow an emote or skip a held prop for a tick.

### Chat input

The shared panel's composer sends broadcasts and direct lines through the recipient selector above. The 200 code point cap and the speech contract govern sending and delivery.

## Tests

- Renderer unit tests cover the chrome elements and their states, the collision overlay's off default and C toggle, nameplate zoom gating, bubble tagging, wrapping, replacement, and seek clearing, camera follow, inspection suspension, gradual live return, zoom-preserving Recenter, and tuned fixture zoom limits.
- Expression tests cover all nine ruleset emotes plus `use`, `none`, title text, exact target-state selection, movement alongside an expression, equal-frame seek and repeat determinism, retained-node lifecycle, bubble stacking, text-only loading fallback, effects-frame completeness, and hiding throughout the nameplate fade band and far zoom. If the arm study is accepted, its four-token override matrix and unchanged walk body and clothing frames gain focused coverage.
- Shared panel tests cover the display-name hook in chat rows, badges, and the recipient selector on the session and replay pages.
- The Three Branches browser journeys cover the off collision default, the button, the C key, zoom-preserving Recenter, the permanent joystick, and the visitor camera's gradual return during live play.
- Update locators whenever markup moves.
- Run the Three Branches browser e2e group while iterating. Before handoff, run the bare full browser e2e suite.

## Done when

The fixture replays under the full HUD and remains usable close up. The information layer above is implemented, every expression is readable at rest, moving, and turning at close and mid views, expressions are absent at far zoom, the required mark treatment has owner sign-off, and the final arm study records an accepted or rejected result. The step 6 input specification is approved and recorded here, the bare full browser e2e suite passes, and this status line records the owner's final sign-off.
