import { type Container, Graphics } from 'pixi.js'

import { PALETTE } from './presentation.js'
import type { StaticScene } from './types.js'

/** Draw semantic building extents once; painted floor and walls remain authoritative underneath. */
export function drawBuildings(layer: Container, scene: StaticScene): void {
  for (const building of scene.buildings) {
    const outline = new Graphics()
      .rect(building.rect.x, building.rect.y, building.rect.width, building.rect.height)
      .fill({ color: PALETTE.building, alpha: 0.12 })
      .stroke({ color: PALETTE.building, width: 2, alpha: 0.8 })
    layer.addChild(outline)
  }
}
