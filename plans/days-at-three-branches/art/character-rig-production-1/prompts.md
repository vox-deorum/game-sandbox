# Character rig production 1

Status: production build in progress.

This batch converts the three approved villager concepts into the same static-base and canonical-arm-pair layout as the approved visitor rig. Built-in image generation produced each proof separately.

## References

1. The selected villager concept is the edit target and identity authority for each generation.
2. `../visitor-rig-comparison-1/visitor-indigo-rig-proof.png` controls only the three-part layout and relative scale.
3. `../hearthside-ink-approval.png` controls whole-scene style and character scale.
4. `../hearthside-ink-material-board.png` controls Hearthside Ink materials and palette.
5. `../top-down-shooter-direction.png` controls exact-overhead projection.

## Shared prompt

```text
Use case: precise-object-edit
Asset type: full-color layered villager rig source proof for Days at Three Branches
Input images: Image 1 is the approved villager identity and edit target. Preserve its named identity details. Image 2 is a layout reference only: match its exact three-part arrangement, part separation, camera, and relative scale, but do not copy the visitor's indigo hat or clothing. Images 3 through 5 are Hearthside Ink style, material, scale, and exact-projection authorities.
Primary request: Reorganize the approved villager into exactly three isolated production parts on one genuinely transparent landscape canvas. Do not show an assembled duplicate.
Part 1, static base: upper center. Include the complete approved hat and all torso, shoulder, and lower garment art except the arms. Remove both arms, sleeves, cuffs, and hands. Reconstruct clean hidden garment edges beneath their former positions. The base remains one compact exact-overhead footprint.
Part 2, canonical left arm: lower-left quadrant. One complete sleeve, cuff, and relaxed hand matching Image 1. Its shoulder attachment end points toward the top of the canvas. Keep it as one connected rigid piece.
Part 3, canonical right arm: lower-right quadrant. One complete sleeve, cuff, and relaxed hand matching Image 1. Its shoulder attachment end points toward the top of the canvas. Keep it as one connected rigid piece.
Projection: exact 90-degree orthographic map view with only upward-facing surfaces. Preserve the selected character's compact proportions. Detached arms use exactly the same camera and scale as the base.
Style/medium: Hearthside Ink, irregular translucent umber or charcoal hand-ink, changing pressure, broken passages, dry-brush taper, controlled hand tint, two or three broad wash values, sparse deliberate marks, smooth illustration surface, crisp small-scale silhouettes.
Composition: landscape canvas with large transparent gaps between all three parts. No overlap. Base is clearly largest. Arms are visually matched at equal scale.
Constraints: actual transparent alpha; exactly one static base and exactly one left/right arm pair; no assembled character; no extra arms, hands, poses, parts, labels, text, numbers, grids, pivot dots, guide lines, borders, ground, checkerboard, cast shadow, contact shadow, halo, glow, scenery, watermark, face, eyes, hair, feet, vertical garment front, perspective, or foreshortening. Preserve the approved hat silhouette and color relationships.
```

## Felt cap identity

Edit target: `../visitor-comparison-1/visitor-c-felt-cap-raw.png`.

```text
Preserve its soft round violet-gray felt cap with irregular scalloped brim, shallow off-center crown, warm timber-and-reed garment, parchment cuffs and open hands, and its small rear cloth tab.
```

## Quilted cap identity

Edit target: `../villager-comparison-1/villager-f-quilted-work-cap-raw.png`.

```text
Preserve its low patchwork quilted work cap with large uneven muted violet, walnut, and parchment panels, green garment, pale cuffs, relaxed hands, and its restrained rear stitch.
```

## Linen bonnet identity

Edit target: `../villager-comparison-1/villager-h-pleated-linen-bonnet-raw.png`.

```text
Preserve its warm parchment pleated linen bonnet with broad fabric segments, blue-gray oval crown, timber-brown crown band, pine garment, pale cuffs, relaxed hands, and its small rear tab.
```

## Files

Each `*-raw.png` file is the direct generator output with a baked neutral checkerboard. `normalize-assets.ps1` uses the shared normalization module to create the corresponding full-colour transparent proof without redrawing it.

`registration.json` records every source crop, shared per-rig scale, target placement, root pivot, and shoulder coordinate. `build-assets.ps1` writes the twelve registered 192 by 192 full-colour source cells and an assembled four-cast preview without cosmetically changing the generated art.
