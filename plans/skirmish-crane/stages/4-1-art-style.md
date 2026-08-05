# Step 4.1: Art Style

Status: complete. The owner approved the Estuary Ink art direction on 2026-08-04, with more salient terrain marks, muted unmarked grassland, and Sengoku unit iconography. Implementation and verification finished on 2026-08-04.

Part of [the Skirmish at Crane Reach plan](../README.md). This is build-order step 4.1: the crane-reach-field visual identity, named Estuary Ink, replacing the step 3 placeholder styling on the live renderer. The information layer over the board is [step 4.2](4-2-hud.md). Review replays both fixture recordings in the final style.

## Why this is its own seam

A renderer owns its game's visual identity, but a new visual pattern needs owner confirmation, and design decisions are the owner's to make ([design system](../../../docs/contributors/frontend/design-system.md)). Skirmish at Crane Reach is the first battlefield renderer, so its identity is entirely new. Concentrating the board art in one step, on a working renderer, means candidate styles are judged on real frames: a live army match, a replay seek, the 750 ms watch cadence. Step 3 built the scene layer style-swappable for exactly this reason. The HUD is its own step (4.2) because it is information design over the finished board, reviewed as text mockups rather than painted frames.

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

One hand-drawn set, all original art, ships as individually bundled renderer-local PNG assets. All 30 runtime assets are grayscale-alpha PNG masks that tint at draw. The exact high-resolution generated originals, including superseded variants, are preserved under `renderer/source-art/`. A manifest names every runtime source file, its intended dimensions, and its consumer. It is the one loading contract, with no generated spritesheet or atlas metadata. The pennant, crane, move glyph, and stat icons also serve the step 4.2 HUD.

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
| glyph-sword.png, glyph-bow.png, glyph-horse.png, glyph-move.png | 64 x 64 each | token, roster, and move marks |
| fig-footman.png, fig-archer.png, fig-cavalry.png | 128 x 128 each | figure-level silhouettes, roster marks |
| pennant.png | 48 x 64 | capture zone standard |
| crane.png | 192 x 96 | terminal banner and thumbnail motif |
| icon-hp.png, icon-move.png, icon-attack.png, icon-range.png, icon-vision.png | 32 x 32 each | step 4.2 unit and order information |

Thirty runtime source files are grayscale-alpha PNGs. Everything is tintable where the treatment calls for it, and nothing is borrowed.

### Units and presentation level

The scene retains logical geometry only. During reconciliation, Crane derives `displayScale` as `ctx.container.getBoundingClientRect().width / SCENE_WIDTH` and passes it to the pure `presentationFor(hexRadius, displayScale)` helper. Resize reruns `update`, so the artwork responds to its actual display size while `computeScene` remains independent of the viewport. The helper selects a presentation level from the effective CSS hex radius:

- Figure: 18 CSS px or more.
- Token: 12 CSS px through less than 18 CSS px.
- Compact: below 12 CSS px.

Each level identifies unit type differently:

- Token uses a lacquered round token at 0.62 hexRadius: a side-color disc with a bold bone mon showing a curved katana, an asymmetric yumi with nocked arrow, or a warhorse head. The glyphs use heavy strokes and few interior details so they remain clear at token size.
- Figure uses three Sengoku silhouettes: an ashigaru in jingasa with a long yari and restrained tate shield, a kneeling armored archer at full draw with an asymmetric yumi, and a mounted samurai in kabuto and lamellar armor carrying a yari. Each is tinted the side's deep shade with a thin bone edge light and stands on the accepted side-color oval base plate.
- Compact uses three shape-coded ink markers: a square shield for footman, a chevron for archer, and a diamond hoof mark for cavalry. The shapes identify type when a detailed glyph is too small.
- Hit points are the border: the token outer rim, figure base edge, or compact marker edge is a gauge arc. The lit portion spans hit points over the type maximum, starting at the top and sweeping clockwise; the depleted remainder is the side's deep shade. The lit arc is bone at healthy, amber ink at or below half, and pale ember at or below a quarter. A critical unit also gets a doubled, broken outer rim, so critical state has a non-color cue. The exact numeral appears on hover in the step 4.2 chip.
- Shadow: every unit stands on a `shadow-oval` tinted pooled ink at alpha 0.35, 1.4 x 0.5 of the token radius. It is the strongest depth cue at token level.
- Death: the unit desaturates to dilute ink, tips slightly, and dissolves upward as a short wisp, then is simply absent. No persistent stains: the scene stays a pure function of the recorded state.

### Zones, activation, and events

- Capture zones use a restrained static mark. All seven tiles take a mulberry wash at alpha 0.16 with a pale-orchid center emphasis. The zone's outer boundary is a union outline, not per-tile rings, drawn in static `zone-dash` segments tinted pale orchid. The center tile carries the `pennant` sprite at figure level and a mulberry seal-ring at token and compact levels. At smaller levels the wash and border stay quiet so the army board remains readable.
- Activation: the acting unit wears the `seal-ring` tinted gilt at 0.9 hexRadius, plus a soft gilt under-glow on its tile at alpha 0.12. The highlight is the only actor signal; no HUD text names the actor. Step 4.2 extends it with the acting unit's movement-range wash.
- Events use one budget, `B = 0.9 * (transitionMs ?? 500)`. Every transition completes inside B, including 675 ms at the 750 ms watch cadence, and scales with slower replay speeds. The timeline is strictly sequential: a visible activation hold, movement, an attack only when the event names a target, then reaction for a target or capture change. All easing uses the host curve, cubic-bezier(0.2, 0, 0, 1).

| Event | Shape | Color | Timing within budget |
| --- | --- | --- | --- |
| activation | the acting unit holds under its gilt seal before moving | gilt | first 20 percent of B, or 25 percent for movement without a reaction |
| move | the unit glides origin to final tile, leaving a dilute-ink trail (width 3, alpha 0.5) that fades as it settles | dilute ink | after activation, ending at 58 percent with an attack, 75 percent with capture only, or 100 percent with movement only |
| melee attack (distance 1) | actor lunges 20 percent toward the target and returns | side color | 58 to 74 percent of B |
| ranged attack | a thin pale-bone streak arcs actor to target, vanishing on arrival | pale bone | 58 to 74 percent of B |
| damage | target flashes bone, then a pale-ember tint and mono `-3` rise 12 px and fade, minimum 12 px text | pale ember | 74 to 100 percent of B |
| death | the ink-dissolve treatment, starting with the reaction | dilute ink | 74 to 100 percent of B |
| capture score | the zone's center emphasis briefly blooms and a `+1` in the scoring side's color rises from the standard | side color, pale orchid | the final reaction phase |

- A fresh nonsnap forward transition retains the preceding pure scene until its timeline completes. Its units, HUD, and acting-unit seal stay visible while the actor moves, the next actor's range stays hidden, and a defeated target remains intact until reaction begins. The renderer reconciles the final scene only at completion. Any seek, repeated render of the same tick, resize, or mount renders the final frame instantly.
- Reduced motion: every glide, lunge, streak, dissolve, and bloom snaps to its final frame. An attack shows as a static hairline thread from actor to target for that frame, damage as a static numeral, and the flash is dropped. The board never depends on motion to be a complete picture.

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

Candidate styles render over the two step 3 fixtures and are reviewed in the browser via replay and `npm run play` at 390 px, 640 px, and the maximum host width. Iteration continues until the owner signs off; the sign-off is recorded in this file's Status line. The placeholder HUD text remains through this step. Step 4.1 shares its palette and move/stat assets with step 4.2 but does not implement the HUD typography, strips, roster, chips, or terminal card.

## Tests

- Scene tests updated where they assert on style-bearing output; geometry and content assertions from step 3 stay unchanged. They cover each unit's gauge state, including the half and quarter boundaries and the critical broken-rim cue.
- Presentation-helper tests cover 18 CSS px, 12 CSS px, and values on both sides of each threshold. Browser resize coverage includes 390 px, 640 px, intermediate desktop widths, and the maximum viewport. It confirms figure, token, and compact presentation changes without changing logical scene geometry, including the host's wide-layout decision-log column.
- A renderer-local asset manifest lists all 30 bundled source assets and their intended sizes. Tests assert the files exist and match the manifest.
- A directly tested injectable asset loader resolves manifest entries through a stub without image decoding. Browser and perf smoke coverage load the real assets; jsdom mount is not evidence of browser decoding because the Pixi base skips WebGL setup there.
- Transition tests cover cadence scaling, sequential phase ordering, targetless capture reaction, prior-scene retention through a fresh forward death, and final-frame rendering for mount, seek, resize, and repeated ticks.
- A reduced-motion test asserts snap rendering produces each event's final frame.
- The step 3 perf smoke stays green with the real assets on the army fixture, and asserts the battlefield layer builds once per episode with textures in place.
- The e2e spectate journey stays green (it asserts on behavior, not pixels).

## Done when

Both fixtures replay in the Estuary Ink style at figure, token, or compact presentation levels appropriate to 390 px, 640 px, and the maximum host width. A live match and `npm run play` show the same identity. All 30 source assets are original art and load in the production build, the thumbnail is final, the art direction note sits beside the renderer, the perf smoke and scene tests are green, the forward-death and final-frame paths behave as specified, and the owner's sign-off is recorded in the Status line.
