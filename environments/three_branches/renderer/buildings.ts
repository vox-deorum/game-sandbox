import { Container, Graphics } from 'pixi.js'

import { PALETTE } from './presentation.js'
import type { StaticScene } from './types.js'

/** Draw semantic building extents while the terrain-art load is still pending. */
export function drawBuildings(layer: Container, scene: StaticScene): Container {
  const outlines = new Container()
  for (const building of scene.buildings) {
    outlines.addChild(
      new Graphics()
        .rect(building.rect.x, building.rect.y, building.rect.width, building.rect.height)
        .fill({ color: PALETTE.building, alpha: 0.12 })
        .stroke({ color: PALETTE.building, width: 2, alpha: 0.8 }),
    )
  }
  layer.addChild(outlines)
  return outlines
}