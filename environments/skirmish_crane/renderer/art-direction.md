# Estuary Ink art direction

Crane Reach is an aged parchment field set in a greener night-ink surround. The palette is parchment `#cfc5a9`, bone `#efe7d3`, dilute grid ink `#6f6757`, reed `#a9ae8a`, silt `#bfa072`, slack water `#5a7680`, cinnabar `#b0402e`, indigo `#3a5f8f`, gilt `#d9a441`, mulberry `#7d5a7e`, and ash violet `#6b5d72`.

The scene owns paint and game marks, not host controls. The host supplies the black stage, rounded clipping, transport, chat, and results. Night ink is intentionally greener than the host chrome. Host mint and sky do not enter the canvas.

Board geometry remains logical and is independent of the viewport. Presentation uses the effective CSS hex radius: figure at 18 px or more, token from 12 px to below 18 px, and compact below 12 px. Each level preserves unit type through a distinct silhouette, glyph, or shape.

Terrain always combines wash and mark. Grassland is a muted bare reed wash with no paired grass tufts. Hills use clearly separated silt contours, water uses broad slack ripples, forest uses canopy, marsh uses one or two sedge tufts, and wasteland uses the ash-violet waste mark. A tile draws its terrain mark first and its feature mark over it. Marks need enough contrast and stroke weight to be understood at token scale.

Units use Sengoku visual language. Footmen are ashigaru with a jingasa, yari, and restrained tate shield. Archers kneel with asymmetric yumi at full draw. Cavalry are mounted samurai with kabuto-shaped horse detail. Token glyphs use bold mon-like masses: a curved katana, an asymmetric yumi, a warhorse head, and a waraji footprint, each with few interior details and heavy strokes. Every tintable runtime asset is a white grayscale-alpha PNG mask that Pixi can multiply by the selected color. Figure rendering adds a small bone edge light where needed.

The exact high-resolution generated originals live in `source-art/`, including superseded variants. Runtime assets in `assets/` are optimized grayscale-alpha PNG masks at their manifest dimensions.

Motion only describes a change: glides, short lunges, pale-bone arrows, rising damage, ink dissolves, and brief capture blooms. A transition uses 90 percent of the host transition duration and follows a sequential activation hold, movement, settle beat, optional attack, and reaction. Movement completes before the attack or capture reaction begins. Damage numerals use an opaque black outline that stays two CSS pixels wide across display scales. The preceding units and HUD remain on screen until the timeline completes, with the event actor's gilt seal and no next-actor range. A defeated target stays intact until reaction begins. Seeking, mounting, resizing, repeated ticks, and reduced motion show the completed frame directly.

## HUD

The canvas keeps the battlefield clear between y 90 and y 746. A quiet top strip holds the small Lato `ROUND` label, its bone mono number, and optional cinnabar and indigo capture seals with their scores. The lower strip holds each side's live footman, archer, and cavalry figures with mono counts. It carries no control, caption, or activation text.

Inspection is parchment, not chrome. A board unit or roster pair opens a dilute-ink card with its name and icon-led hit points, movement, damage, range, and vision. Board inspection adds a bone ring and bone range wash. The acting unit keeps its gilt range wash when no board unit is inspected. Ability lines appear only in episodes with unit abilities enabled.

At match end the canvas keeps its normal top strip and bottom rosters. The host owns the game-over result and presents it outside the renderer.
