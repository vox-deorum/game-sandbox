import { Container, Graphics, Text } from 'pixi.js'

import { PALETTE } from './presentation.js'
import type { CollisionShape } from './types.js'

/** Operations exposed by the diagnostic collision display layer. */
export interface CollisionLayer {
  /** Show or hide collision without rebuilding its geometry. */
  setVisible(visible: boolean): void
  /** Repaint collision geometry that remains fixed for the mounted village. */
  drawStatic(shapes: readonly CollisionShape[], resolution: number): void
  /** Repaint the small set of character bodies that can move within a tick. */
  drawDynamic(shapes: readonly CollisionShape[], resolution: number): void
}

/** Draw collision truth in an ungraded layer above every art layer. */
export function createCollisionLayer(layer: Container): CollisionLayer {
  const staticShapes = new Graphics()
  const staticLabels = new Container()
  const dynamicShapes = new Graphics()
  const dynamicLabels = new Container()
  layer.addChild(staticShapes, staticLabels, dynamicShapes, dynamicLabels)
  return {
    setVisible(visible) {
      layer.visible = visible
    },
    drawStatic(shapes, resolution) {
      drawShapes(staticShapes, staticLabels, shapes, resolution)
    },
    drawDynamic(shapes, resolution) {
      drawShapes(dynamicShapes, dynamicLabels, shapes, resolution)
    },
  }
}

function drawShapes(
  graphics: Graphics,
  labels: Container,
  collision: readonly CollisionShape[],
  resolution: number,
): void {
  graphics.clear()
  for (const child of labels.removeChildren()) child.destroy()
  for (const shape of collision) {
    const color = colorFor(shape.group)
    if (shape.kind === 'rect') {
      graphics
        .rect(shape.rect.x, shape.rect.y, shape.rect.width, shape.rect.height)
        .fill({ color, alpha: 0.24 })
        .stroke({ color, width: 1 })
      if (shape.group === 'object') {
        addLabel(labels, shape.label, shape.rect.x, shape.rect.y, resolution)
      }
    } else {
      graphics
        .circle(shape.center.x, shape.center.y, shape.radius)
        .fill({ color, alpha: 0.24 })
        .stroke({ color, width: 1 })
      addLabel(labels, shape.label, shape.center.x + shape.radius, shape.center.y, resolution)
    }
  }
}

function colorFor(group: CollisionShape['group']): string {
  if (group === 'blocked') return PALETTE.blockedCollision
  if (group === 'object') return PALETTE.objectCollision
  if (group === 'character') return PALETTE.characterCollision
  return PALETTE.boundaryCollision
}

function addLabel(layer: Container, value: string, x: number, y: number, resolution: number): void {
  const label = new Text({
    text: value,
    style: { fill: PALETTE.text, fontSize: 9, fontFamily: 'ui-monospace, monospace' },
    resolution,
  })
  label.position.set(x + 2, y + 2)
  layer.addChild(label)
}
