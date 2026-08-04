# Step 4.1: Art Style

Status: planned. This file carries the first design draft; exit requires explicit owner sign-off on the art direction, recorded here.

Part of [the Skirmish at Crane Reach plan](../README.md). This is build-order step 4.1: the crane-reach-field visual identity, named Estuary Ink, replacing the step 3 placeholder styling on the live renderer. The information layer over the board is [step 4.2](4-2-hud.md). The hands-on surface is both fixture recordings replaying in the final style.

## Why this is its own seam

A renderer owns its game's visual identity, but a new visual pattern needs owner confirmation, and design decisions are the owner's to make ([design system](../../../docs/contributors/frontend/design-system.md)). Skirmish at Crane Reach is the first battlefield renderer, so its identity is entirely new. Concentrating the board art in one step, on a working renderer, means candidate styles are judged on real frames: a live army match, a replay seek, the 750 ms watch cadence. Step 3 built the scene layer style-swappable for exactly this reason. The HUD is its own step (4.2) because it is information design over the finished board, reviewed as text mockups rather than painted frames.

## The design: Estuary Ink

Crane Reach is painted, not rendered. The battlefield is a sheet of aged parchment washed with dilute pigment, floating in dark river mist on the black stage. Terrain is brushwork, units are lacquered tokens or ink figures depending on how close the view is, and capture zones glow faintly like consecrated ground. Red is cinnabar, Blue is indigo, attention is gilt. Motion behaves like ink: it glides, blooms, and dissolves.

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

Terrain washes. Muted estuary pigments, each far enough from its neighbors to survive a 25 px hex:

| Key            | Value   | Name        |
| -------------- | ------- | ----------- |
| terrain.grass  | #a9ae8a | reed        |
| terrain.hill   | #bfa072 | silt        |
| terrain.water  | #5a7680 | slack water |
| terrain.void   | #131c19 | deep mist   |
| feature.forest | #4f6a4b | pine        |
| feature.marsh  | #7f8261 | sedge       |

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
| zoneGlow | #b98cc0 | pale orchid | zone luminance, rune border, drifting motes |
| hpLow | #e6b054 | amber ink | rim gauge at or below half |
| danger | #e06a50 | ember | rim gauge at or below a quarter, damage numerals, target seal, clock under 10 s |

### Terrain and the board

The battlefield layer still builds once per episode; everything here is placed at build time.

- The sheet: one parchment polygon covers the field's outer hexagon, bleeding 4 to 6 px past the outer tile edges, with the paper-grain texture multiplied over it once. The boundary gets a dry-brush ink stroke with deliberate gaps, the way a loaded brush skips.
- Tiles: a flat terrain fill plus one `wash-hex` sprite tinted the same color at alpha 0.5, variant and rotation picked by a hash of the tile key, so pigment pools differently tile to tile and rebuilds are deterministic. Grid strokes are dilute ink, so the hexes read as penciled construction lines under the paint, not as a game grid.
- Grass is the bare reed wash. Hill adds a `contour` sprite (two curved strokes tinted #8f7550) so high ground reads as drawn elevation even at 25 px. Water is the darkest wash with one `ripple` sprite per tile at alpha 0.4. Forest keeps its grass base and adds a `canopy` sprite at 0.75 tile width tinted pine. Marsh adds one or two `sedge` tufts; at far zoom they read as darker stippling.
- Void and mist: void tiles are never drawn. The night-ink backdrop shows through, and four to six `mist-band` sprites lie along the parchment boundary, overlapping the sheet's edge by half a tile, so the field dissolves into the dark like a scroll painting's unfinished edge. The mist drifts on one very slow cycle derived from the recorded tick (the flappy bird cloud pattern), so it advances as the match advances, freezes on pause, and lands identically on any seek.

### The texture atlas

One hand-drawn set, all original art, shipped with the renderer. Raster pieces are grayscale-alpha PNGs packed into one spritesheet and tinted at draw; glyphs and figures are SVG for crisp scaling. The pennant and crane also serve the step 4.2 HUD.

| Asset | Size | For |
| --- | --- | --- |
| paper-field.png | 1024 x 1024 | paper tooth over the sheet |
| wash-hex-a/b/c.png | 128 x 128 each | per-tile pigment pooling, 3 variants |
| edge-stroke.png | 256 x 64 | dry-brush boundary, tiled along edges |
| mist-band-a/b.png | 512 x 192 each | drifting void mist |
| canopy.png | 96 x 96 | forest |
| sedge-a/b.png | 96 x 48 each | marsh tufts |
| ripple.png | 96 x 32 | water |
| contour.png | 96 x 96 | hill strokes |
| shadow-oval.png | 64 x 64 | unit shadows |
| seal-ring.png | 96 x 96 | brushy circle: activation ring, target seal |
| rune-dash.png | 96 x 24 | zone border segments |
| mote.png | 32 x 32 | zone light motes |
| glyph-sword.svg, glyph-bow.svg, glyph-horse.svg | 64 x 64 each | token glyphs |
| fig-footman.svg, fig-archer.svg, fig-cavalry.svg | 128 x 128 each | near-zoom silhouettes, roster marks |
| pennant.svg | 48 x 64 | capture zone standard |
| crane.svg | 192 x 96 | terminal banner and thumbnail motif |

Twenty-two files, one spritesheet plus SVGs, everything tintable, nothing borrowed.

### Units and the zoom level

Zoom level is a first-class scene fact. The scene exposes `zoomLevel: 'near' | 'far'`, computed as `hexRadius >= 24 ? 'near' : 'far'` in logical scene units. Today that derives only from the battlefield: the skirmish plan (15 across, hexRadius near 27) lands near, the army plan (21 across, hexRadius near 20) lands far. If a pan-and-zoom camera ever arrives, the same rule reads the effective on-screen hex radius and every zoom-keyed treatment follows without redesign.

- Far level, lacquer tokens: a round token at 0.62 hexRadius. Side-color disc, the white weapon glyph filling the center: a point-up straight blade, a drawn bow with nocked arrow, a left-facing horse head, bold single-color silhouettes legible at 12 px.
- Near level, ink figures: silhouettes (standing spearman with shield, kneeling archer at full draw, mounted rider) tinted the side's deep shade with a thin bone edge light, standing on a side-color oval base plate.
- Hit points are the border: the token's outer rim (near level: the base plate's edge) is a gauge arc. The lit portion spans hit points over the type's maximum, starting at the top and sweeping clockwise; the depleted remainder is the side's deep shade. The lit arc is bone at healthy, amber ink at or below half, ember at or below a quarter, and at ember the whole rim reads ember, so a critical unit is findable across the board. The exact numeral appears on hover, in the step 4.2 chip.
- Shadow: every unit stands on a `shadow-oval` tinted pooled ink at alpha 0.35, 1.4 x 0.5 of the token radius. It grounds the figures and is the strongest depth cue at far zoom.
- Death: the unit desaturates to dilute ink, tips slightly, and dissolves upward as a short wisp, then is simply absent. No persistent stains: the scene stays a pure function of the recorded state.

### Zones, activation, and events

- Capture zones read as consecrated ground. All seven tiles take a mulberry wash at alpha 0.16 with a pale-orchid luminance rising toward the center tile. The zone's outer boundary (the union outline, not per-tile rings) is drawn in `rune-dash` segments tinted pale orchid, circulating slowly on the same tick-derived cycle as the mist. Two or three `mote` sprites drift above the zone on that cycle. The center tile carries the standard: the `pennant` sprite at near zoom, a mulberry seal-ring at far zoom. At far zoom the motes shrink and the luminance softens so the army board stays calm.
- Activation: the acting unit wears the `seal-ring` tinted gilt at 0.9 hexRadius, plus a soft gilt under-glow on its tile at alpha 0.12. The highlight is the only actor signal; no HUD text names the actor. Step 4.2 extends it with the acting unit's movement-range wash.
- Events: the animation budget becomes `min(450, 0.6 x transitionMs)`: 450 ms at the 750 ms watch cadence, 300 ms at the 500 ms live cadence. An activation that walks and strikes spends the first 60 percent walking, the rest striking. All easing uses the host curve, cubic-bezier(0.2, 0, 0, 1).

| Event | Shape | Color | Timing within budget |
| --- | --- | --- | --- |
| move | the unit glides origin to final tile, leaving a dilute-ink trail (width 3, alpha 0.5) that fades as it settles | dilute ink | walk phase; trail fades in the last 20 percent |
| melee attack (distance 1) | actor lunges 20 percent toward the target and returns | side color | 120 ms out, 80 ms back |
| ranged attack | a thin pale-bone streak arcs actor to target, vanishing on arrival | pale bone | 160 ms |
| damage | target flashes bone for 80 ms, then an ember tint fades; a mono `-3` rises 12 px and fades, minimum 12 px text | ember | 300 ms, overlapping the strike |
| death | the ink-dissolve treatment, starting when damage lands | dilute ink | 250 ms |
| capture score | the zone's luminance swells, its motes flare, and a `+1` in the scoring side's color drifts up from the standard | side color, pale orchid | 300 ms in the settle phase |

- Snap and seek: any seek, any repeated render of the same tick, and any mount renders the final frame instantly; only a fresh forward transition animates. Idle motion (mist, runes, motes) is a pure function of the tick, so a paused board is still and a seek lands on an identical frame.
- Reduced motion: glides, lunges, dissolves, pulses, and drift snap to their final frames; an attack shows as a static hairline thread from actor to target for that frame, damage as a static numeral, and the flash is dropped. The animations are the only carrier of strike information (no HUD text repeats it), so these static forms keep every frame readable.

### Fog treatment for step 5 (visual spec only; step 5 wires it)

Terrain is standing knowledge, so the painted battlefield never dims structurally. Fog is a glaze on top.

- Hidden tiles take a fog-glaze fill (night ink at alpha 0.45) shaped by the tile's `wash-hex` mask, so the glaze's edges stay soft and painterly rather than hard hex cuts. Glazed terrain remains identifiable by construction of the palette.
- The visible set carries no glaze; the glaze edge is the boundary, so no outline is needed.
- Units outside vision are absent. Not ghosted, not remembered: the past lives in a unit's own code, and the picture mirrors that honesty.
- Perspective switches crossfade the glaze layer over 200 ms with the host ease; reduced motion snaps it.

### The thumbnail

`thumbnail.svg`, 320 x 180, hand-composed, all paths, no font dependency. Night ink fills the frame. A parchment band with torn, brush-broken edges crosses the lower two thirds at a slight tilt, carrying five or six hex washes: reed flats, a slack-water passage, one silt rise. A cinnabar token with the sword glyph stands left of the water; an indigo token with the bow glyph faces it. Mist wisps cross the parchment's upper edge, a bone crane flies upper right, and `CRANE REACH` sits lower left in EB Garamond letterforms converted to outlines over a short gilt rule.

### Living inside the host chrome

The host owns the calm frame: the true-black stage, the 8 px corner rounding (the host clips, the renderer paints to the edges), the transport, the chat, and the result card. The renderer draws none of those. Inside the canvas, night ink is greener than the host's blue-charcoal, so the stage reads as a lit window rather than another app panel. No game meaning uses the host's mint or sky, gilt never shares a surface with the host's medal gold, and cinnabar and indigo sit clearly apart from the host's coral and sky.

### The art direction note

A short written record of the choices distilled from this file: palette, hex geometry and scale, unit iconography, animation vocabulary, and the host-chrome relationship. It lives beside the renderer so future changes have a reference. Step 4.2 extends it with the HUD typography and layout.

### Review workflow

Candidate styles render over the two step 3 fixtures and are reviewed in the browser via replay and `npm run play`. Iteration continues until the owner signs off; the sign-off is recorded in this file's Status line. The placeholder HUD text remains through this step and is restyled in step 4.2.

## Tests

- Scene tests updated where they assert on style-bearing output; geometry and content assertions from step 3 stay unchanged. The scene newly exposes `zoomLevel` and each unit's gauge state; tests cover the army fixture landing far, the skirmish fixture landing near, the threshold boundary at 24, and the half and quarter gauge edges.
- An atlas manifest module lists every asset with its intended size; a test asserts the files exist and match the manifest.
- Texture loading sits behind an atlas loader with an injectable stub, so jsdom tests mount without real image decoding; one test asserts a clean mount with the stub.
- Idle-motion determinism: rendering the same tick twice yields identical mist, rune, and mote positions.
- A reduced-motion test asserts snap rendering produces each event's final frame.
- The step 3 perf smoke stays green with the real atlas on the army fixture, and asserts the battlefield layer builds once per episode with textures in place.
- The e2e spectate journey stays green (it asserts on behavior, not pixels).

## Done when

Both fixtures replay in the Estuary Ink style at their zoom levels (army tokens, skirmish silhouettes), a live match and `npm run play` show the same identity, every atlas asset is original art loading in the production build, the thumbnail is final, the art direction note sits beside the renderer, the perf smoke and scene tests are green, and the owner's sign-off is recorded in the Status line.

## Open items for the review round

1. Silhouette bases: side-color oval base plates carrying the gauge (proposed), or figures on shadow alone with a token-style rim.
2. Zone magic intensity at far zoom: how soft the luminance and motes go before the army board reads as noisy.
3. Whether the mist drift cycle stays subtle enough on the skirmish board, where hexes are large and the surround is wide.
