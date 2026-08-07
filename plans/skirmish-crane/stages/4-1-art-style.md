# Step 4.1: Art Style

Status: complete. The owner approved the Estuary Ink art direction on 2026-08-04, with more salient terrain marks, muted unmarked grassland, and Sengoku unit iconography. Implementation and verification finished on 2026-08-04.

Part of [the Skirmish at Crane Reach plan](../README.md). This is build-order step 4.1: the crane-reach-field visual identity, named Estuary Ink, replacing the step 3 placeholder styling on the live renderer. The information layer over the board is [step 4.2](4-2-hud.md). Review replays both fixture recordings in the final style.

## Why this is its own seam

A renderer owns its game's visual identity, but a new visual pattern needs owner confirmation, and design decisions are the owner's to make ([design system](../../../docs/contributors/frontend/design-system.md)). Skirmish at Crane Reach is the first battlefield renderer, so its identity is entirely new. Concentrating the board art in one step, on a working renderer, means candidate styles are judged on real frames: a live army match, a replay seek, the 1000 ms watch cadence. Step 3 built the scene layer style-swappable for exactly this reason. The HUD is its own step (4.2) because it is information design over the finished board, reviewed as text mockups rather than painted frames.

## The design: Estuary Ink

Crane Reach is painted, not rendered. The battlefield is a sheet of aged parchment washed with dilute pigment, set against a dark estuary surround. Terrain is brushwork, units use lacquered tokens or ink figures at the available display size, and capture zones use quiet printed marks. Red is cinnabar, Blue is indigo, attention is gilt. Motion is limited to state transitions.

### The palette

The exported style const becomes `CRANE_STYLE`, keeping the swappable-layer shape from step 3. Alpha is listed where a color only appears translucently. The parchment-and-ink text colors are shared with the step 4.2 HUD; the const stays single.

Ink surround. The world outside the parchment, greener and warmer than the host's blue ink so the canvas reads as a window onto different material:

| Key | Value | Name | Use |
| --- | --- | --- | --- |
| backdrop | #101816 | night ink | canvas fill behind everything |
| void | #131c19 | deep mist | outside the hexagon, merged into the surround |
| mist | #a9b4ab | river mist | mist bands, alpha 0.10 to 0.25 |
| shadow | #14201b | pooled ink | unit shadows, alpha 0.35 |
| fog | #101816 | fog glaze | step 5 hidden-tile glaze, alpha 0.45 |

Parchment and ink. The board and all writing, warm whites and browned ink, clearly apart from the host's cool slate text:

| Key | Value | Name | Use |
| --- | --- | --- | --- |
| board | #cfc5a9 | parchment | the field's base wash |
| grid | #6f6757 | dilute ink | tile edges (width 1.5, alpha 0.55), move trails |
| text | #efe7d3 | bone | primary canvas text, glyphs, healthy rim gauge |
| mutedText | #b3ab99 | faded ink | secondary HUD text |
| event | #e8dfc7 | pale bone | arrow streaks, event accents |

Terrain washes. Muted estuary pigments, paired with drawn terrain marks so the board does not rely on color alone:

| Key            | Value   | Name        |
| -------------- | ------- | ----------- |
| terrain.grass  | #a9ae8a | reed        |
| terrain.hill   | #bfa072 | silt        |
| terrain.water  | #5a7680 | slack water |
| terrain.void   | #131c19 | deep mist   |
| feature.forest | #4f6a4b | pine        |
| feature.marsh  | #7f8261 | sedge       |
| feature.waste  | #6b5d72 | ash violet  |

Sides. Traditional pigments, deep and saturated, well away from the host's coral #ff7a76 and sky #6ab8ff:

| Key | Value | Name | Use |
| --- | --- | --- | --- |
| red | #b0402e | cinnabar | Red fills |
| redDeep | #7e2a1e | lacquer | Red silhouettes, depleted rim, token inner ring |
| blue | #3a5f8f | indigo | Blue fills |
| blueDeep | #27436b | night indigo | Blue silhouettes, depleted rim, token inner ring |

Accents. Warmth escalates: gilt, amber, ember. The host's mint and sky never appear inside the canvas, and gilt never shares a surface with the host's medal gold:

| Key | Value | Name | Use |
| --- | --- | --- | --- |
| activation | #d9a441 | gilt | activation ring, path composition, move clock |
| zone | #7d5a7e | mulberry | capture zone wash, pennant |
| zoneGlow | #b98cc0 | pale orchid | zone center emphasis, boundary brushwork |
| hpLow | #e6b054 | amber ink | rim gauge at or below half |
| danger | #ffb08e | pale ember | rim gauge at or below a quarter, damage numerals, target seal, clock under 10 s |

### Terrain and the board

The battlefield layer still builds once per episode; everything here is placed at build time.

- The sheet: one parchment polygon covers the field's outer hexagon, bleeding 4 to 6 px past the outer tile edges, with the paper-grain texture multiplied over it once. The boundary gets a dry-brush ink stroke with deliberate gaps, the way a loaded brush skips.
- Tiles: a flat terrain fill plus one `wash-hex` sprite tinted the same color at alpha 0.5, variant and rotation picked by a hash of the tile key, so pigment pools differently tile to tile and rebuilds are deterministic. Grid strokes are dilute ink, so the hexes read as penciled construction lines under the paint, not as a game grid.
- Grass is the quietest terrain: a muted bare reed wash with no tuft mark. Hill adds a bold `contour` sprite (two curved strokes tinted #8f7550), water adds a clear `ripple` sprite, forest adds a `canopy` sprite at 0.75 tile width, marsh adds one or two `sedge` tufts, and wasteland adds a `feature-waste` sprite tinted ash violet. A tile draws its terrain mark first and its feature mark over it, so a hill carrying a feature shows both. The marks carry enough contrast and stroke weight to identify terrain at token size.
- Void and mist: void tiles are never drawn. The night-ink backdrop shows through, and four to six static `mist-band` sprites lie along the parchment boundary, overlapping the sheet's edge by half a tile. They give the sheet an irregular boundary without decorative ambient motion.

### Asset manifest

One hand-drawn set, all original art, ships as individually bundled renderer-local PNG assets. All 31 runtime assets are grayscale-alpha PNG masks that tint at draw. The exact high-resolution generated originals, including superseded variants, are preserved under `renderer/source-art/`. A manifest names every runtime source file, its intended dimensions, and its consumer. It is the one loading contract, with no generated spritesheet or atlas metadata. The pennant, crane, move and reset glyphs, and stat icons also serve the step 4.2 HUD.

| Asset | Size | For |
| --- | --- | --- |
| paper-field.png | 1024 x 1024 | paper tooth over the sheet |
| wash-hex-a/b/c.png | 128 x 128 each | per-tile pigment pooling, 3 variants |
| edge-stroke.png | 256 x 64 | dry-brush boundary, tiled along edges |
| mist-band-a/b.png | 512 x 192 each | static void mist |
| canopy.png | 96 x 96 | forest |
| feature-waste.png | 96 x 96 | wasteland feature mark, magic-polluted ground |
| sedge-a/b.png | 96 x 48 each | marsh tufts |
| ripple.png | 96 x 32 | water |
| contour.png | 96 x 96 | hill strokes |
| shadow-oval.png | 64 x 64 | unit shadows |
| seal-ring.png | 96 x 96 | brushy circle: activation ring, target seal |
| zone-dash.png | 96 x 24 | static zone border segments |
| glyph-sword.png, glyph-bow.png, glyph-horse.png, glyph-move.png, glyph-reset.png | 64 x 64 each | token, roster, move, and reset marks |
| fig-footman.png, fig-archer.png, fig-cavalry.png | 128 x 128 each | figure-level silhouettes, roster marks |
| pennant.png | 48 x 64 | capture zone standard |
| crane.png | 192 x 96 | thumbnail motif |
| icon-hp.png, icon-move.png, icon-attack.png, icon-range.png, icon-vision.png | 32 x 32 each | step 4.2 unit and order information |

Thirty-one runtime source files are grayscale-alpha PNGs. `glyph-reset.png` has a high-resolution source original alongside the other source art. Everything is tintable where the treatment calls for it, and nothing is borrowed.

### Units and presentation level

The scene retains logical geometry only. During reconciliation, Crane multiplies the display scale the base renderer tracks (the canvas width in CSS pixels over the internal scene width, refreshed on every resize) by the [step 4.3 camera](4-3-camera.md) zoom and passes the result to the pure `presentationFor(hexRadius, effectiveScale)` helper. A resize or camera change redraws the retained frame, so the artwork responds to its effective CSS hex radius while `computeScene` remains independent of the viewport. The helper selects a presentation level from that radius:

- Figure: 28 CSS px or more.
- Token: 12 CSS px through less than 28 CSS px.
- Compact: below 12 CSS px.

Each level identifies unit type differently:

- Token uses a lacquered round token at 0.62 hexRadius: a side-color disc with a bold bone mon showing a curved katana, an asymmetric yumi with nocked arrow, or a warhorse head. Each mon is one texture with a heavier white stroke, few interior details, and the original-width black contour.
- Figure uses three Sengoku silhouettes: an ashigaru in jingasa with a long yari and restrained tate shield, a kneeling armored archer at full draw with an asymmetric yumi, and a mounted samurai in kabuto and lamellar armor carrying a yari. Each is tinted the side's deep shade with a thin bone edge light and stands above a side-color oval base plate placed near its feet. One `FIGURE_BASE_Y_FACTOR` parameter positions the base plate, its HP ellipse, and its shadow together.
- Compact uses three shape-coded ink markers: a square shield for footman, a chevron for archer, and a diamond hoof mark for cavalry. The shapes identify type when a detailed glyph is too small.
- Hit points are the border: the token outer rim, figure base edge, or compact marker edge is a gauge arc. The lit portion spans hit points over the type maximum, starting at the top and sweeping clockwise; the depleted remainder is the side's deep shade. The lit arc is bone at healthy, amber ink at or below half, and pale ember at or below a quarter. A critical unit also gets a doubled, broken outer rim, so critical state has a non-color cue. The exact numeral appears on hover in the step 4.2 chip.
- Shadow: every unit stands on a `shadow-oval` tinted pooled ink at alpha 0.35, 1.4 x 0.5 of the token radius. It is the strongest depth cue at token level.
- Death: the unit desaturates to dilute ink, tips slightly, and dissolves upward as a short wisp, then is simply absent. No persistent stains: the scene stays a pure function of the recorded state.

### Zones, activation, and events

- Capture zones use a strong static mark. All seven tiles take a mulberry wash at alpha 0.20 with a pale-orchid center emphasis at alpha 0.50. The zone's outer boundary is a union outline, not per-tile rings, drawn in heavy `zone-dash` segments tinted pale orchid. The center tile carries a large `pennant` sprite at figure level and a mulberry seal-ring at token and compact levels.
- Activation: the acting unit wears the `seal-ring` tinted gilt at 0.9 hexRadius, plus a soft gilt under-glow on its tile at alpha 0.12. The highlight is the only actor signal; no HUD text names the actor. During open human composition only, the seal fades from full opacity to 0.35 and back over 1.6 seconds. Reduced motion keeps it steady, as do spectate, replay, and event seals. Step 4.2 extends it with the acting unit's movement-range wash.
- Events run on absolute phase windows rather than a normalized budget. At scale 1: activation is 200 ms, movement is 200 ms per tile, an attack is 400 ms, and a reaction is 700 ms, starting 100 ms into the attack when there is a target or the instant movement ends for a capture-only reaction. `timeline.ts` holds these constants as `CRANE_TIMING` and lays out each event's windows in `eventWindows`; it also owns the wall-clock settled-frame holds: 300 ms for an event ordered by a player controlled at this screen and 200 ms for every other visible watched event. Snap and invisible updates do not hold. A paced host's cadence, relative to one second, scales the event schedule (`transitionScale`), and the event's total duration is whichever included window ends last, so a four-tile charge into a kill genuinely takes longer to play than a step-and-stab. Movement eases per tile with the host curve, cubic-bezier(0.2, 0, 0, 1); attack and reaction progress linearly, so the ranged arc and the reaction fades hold their brightness through the beat instead of vanishing at its start.

| Event | Shape | Color | Timing (scale 1) |
| --- | --- | --- | --- |
| activation | the acting unit holds under its gilt seal before moving | gilt | 0 to 200 ms |
| move | the unit follows every tile in its executed route, leaving a dilute-ink trail (width 3, alpha 0.5) that fades as it settles | dilute ink | 200 ms, plus 200 ms per tile: ends at 400, 600, 800, or 1000 ms for one through four tiles |
| melee attack (distance 1) | actor lunges 20 percent toward the target and returns | side color | starts when movement ends, runs 400 ms |
| ranged attack | a thin pale-bone streak arcs actor to target, vanishing on arrival | pale bone | starts when movement ends, runs 400 ms |
| damage | a pale-ember tint over the target fades across the reaction, and mono `-3` with an opaque two-CSS-pixel black outline holds still at full strength while it is read, then rises 12 px and fades over the tail of the reaction, minimum 12 px text | pale ember | starts 100 ms into the attack (movement's end for a capture-only event), runs 700 ms |
| death | the ink-dissolve treatment, starting with the reaction | dilute ink | same window as damage |
| capture score | the zone's center emphasis briefly blooms and a `+1` in the scoring side's color rises from the standard | side color, pale orchid | same window as damage; starts immediately at movement's end for a capture-only event |

The attack and reaction windows overlap by design: a targeted reaction begins 100 ms into the 400 ms attack, so the ranged arc is still fading as the damage numeral and the death wisp appear.

- A fresh, unsnapped forward transition keeps the preceding pure scene on screen while the event plays. Its units and HUD stay visible, the acting-unit seal follows the actor, and the acting range stays visible through activation and movement, then clears the moment the attack or a capture reaction starts. A different inspected unit's bone range remains visible through every phase and is never replaced by the actor's range. A defeated target remains intact until the reaction begins. A render that supersedes an in-flight event completes the retained scene and installs the new state directly, with no held intermediary frame and no deferred-event handoff state machine. Any seek, repeated render of the same tick, resize, or mount renders the final frame instantly.

### Fog treatment for step 5 (visual spec only; step 5 wires it)

Terrain is standing knowledge, so the painted battlefield never dims structurally. Fog is a glaze on top.

- Hidden tiles take a fog-glaze fill (night ink at alpha 0.45) shaped by the tile's `wash-hex` mask, so the glaze's edges stay soft and painterly rather than hard hex cuts. Glazed terrain remains identifiable through its fill and terrain marks.
- The visible set carries no glaze; the glaze edge is the boundary, so no outline is needed.
- Units outside vision are absent. Not ghosted, not remembered: the past lives in a unit's own code, and the picture mirrors that honesty.
- Perspective switches crossfade the glaze layer over 200 ms with the host ease; reduced motion snaps it.

### The thumbnail

`thumbnail.png`, 320 x 180, is generated artwork in the approved Estuary Ink style. Night ink fills the frame. A parchment band with torn, brush-broken edges crosses the lower two thirds at a slight tilt, carrying muted unmarked reed flats, a salient slack-water passage, and one salient silt rise. A cinnabar Sengoku token stands left of the water; an indigo token faces it. Mist wisps cross the parchment's upper edge, and a bone crane flies above the battlefield.

### Living inside the host chrome

The host owns the calm frame: the true-black stage, the 8 px corner rounding (the host clips, the renderer paints to the edges), the transport, the chat, and the result card. The renderer draws none of those. Inside the canvas, night ink is greener than the host's blue-charcoal, so the stage reads as a lit window rather than another app panel. No game meaning uses the host's mint or sky, gilt never shares a surface with the host's medal gold, and cinnabar and indigo sit clearly apart from the host's coral and sky.

### The art direction note

A short written record of the choices distilled from this file: palette, logical geometry and presentation thresholds, unit iconography, animation vocabulary, and the host-chrome relationship. It lives beside the renderer so future changes have a reference. Step 4.2 extends it with the HUD typography and layout.

### Review workflow

Candidate styles render over the two step 3 fixtures and are reviewed in the browser via replay and `npm run play` at 390 px, 640 px, and the maximum host width. Iteration continues until the owner signs off; the sign-off is recorded in this file's Status line. The placeholder HUD text remains through this step. Step 4.1 shares its palette and move/stat assets with step 4.2 but does not implement the HUD typography, strips, roster, or chips.

## Tests

- Scene tests updated where they assert on style-bearing output; geometry and content assertions from step 3 stay unchanged. They cover each unit's gauge state, including the half and quarter boundaries and the critical broken-rim cue.
- Presentation-helper tests cover 28 CSS px, 12 CSS px, and values on both sides of each threshold. Browser resize coverage includes 390 px, 640 px, intermediate desktop widths, and the maximum viewport. It confirms that fitted views stay compact or token-sized and that camera zoom promotes tokens to figures without changing logical scene geometry.
- A renderer-local asset manifest lists all 31 bundled source assets and their intended sizes. Tests assert the files exist and match the manifest, including the 64 x 64 grayscale-alpha reset glyph and its high-resolution source original.
- A directly tested injectable asset loader resolves manifest entries through a stub without image decoding. Browser and perf smoke coverage load the real assets; jsdom mount is not evidence of browser decoding because the Pixi base skips WebGL setup there.
- Transition and inspection tests cover `transitionScale` timing, the `CRANE_TIMING` activation, movement, attack, reaction, and settled-frame holds, tile-route timing for one through four tiles, the attack-reaction overlap, a capture-only reaction with no target, the 300 ms controlled-order and 200 ms watched-event holds, snap and invisible updates without holds, inspected-range ownership throughout another unit's event, prior-scene retention through a fresh forward death, and final-frame rendering for mount, seek, resize, and repeated ticks.
- The step 3 perf smoke stays green with the real assets on the army fixture, and asserts the battlefield layer builds once per episode with textures in place.
- The e2e spectate journey stays green (it asserts on behavior, not pixels).

## Done when

Both fixtures replay in the Estuary Ink style at figure, token, or compact presentation levels appropriate to 390 px, 640 px, and the maximum host width. A live match and `npm run play` show the same identity. All 31 source assets are original art and load in the production build, including the reset glyph and its source original, the thumbnail is final, the art direction note sits beside the renderer, the perf smoke and scene tests are green, the forward-death and final-frame paths behave as specified, and the owner's sign-off is recorded in the Status line.
