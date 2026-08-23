import type { RendererTextFactory } from '@renderers/base/PixiRenderer.js'
import { Container, Graphics, Text } from 'pixi.js'

import { PALETTE } from '../core/presentation.js'
import type { CollisionShape } from '../core/types.js'

/** Operations exposed by the diagnostic collision display layer. */
export interface CollisionLayer {
  /** Show or hide collision without rebuilding its geometry. */
  setVisible(visible: boolean): void
  /** Repaint collision geometry that remains fixed for the mounted village. */
  drawStatic(shapes: readonly CollisionShape[], resolution: number): void
  /** Repaint the small set of character bodies that can move within a tick. */
  drawDynamic(shapes: readonly CollisionShape[], resolution: number): void
}

/** One label slot, moved or re-created in place so the overlay never churns text objects. */
interface PlacedLabel {
  value: string
  x: number
  y: number
}

/**
 * Draw collision truth in an ungraded layer above every art layer. The layer is inert while hidden:
 * `draw` calls record their arguments and nothing is built, and showing repaints the recorded sets.
 * Visible labels are reused by index rather than destroyed and re-created each frame.
 */
export function createCollisionLayer(
  layer: Container,
  createText: RendererTextFactory,
): CollisionLayer {
  const staticShapes = new Graphics()
  const staticLabels = new Container()
  const dynamicShapes = new Graphics()
  const dynamicLabels = new Container()
  layer.addChild(staticShapes, staticLabels, dynamicShapes, dynamicLabels)
  layer.visible = false

  let visible = false
  let recordedStatic: { shapes: readonly CollisionShape[]; resolution: number } | null = null
  let recordedDynamic: { shapes: readonly CollisionShape[]; resolution: number } | null = null

  const paintStatic = (): void => {
    if (recordedStatic === null) return
    drawShapes(
      staticShapes,
      staticLabels,
      recordedStatic.shapes,
      recordedStatic.resolution,
      createText,
    )
  }
  const paintDynamic = (): void => {
    if (recordedDynamic === null) return
    drawShapes(
      dynamicShapes,
      dynamicLabels,
      recordedDynamic.shapes,
      recordedDynamic.resolution,
      createText,
    )
  }

  return {
    setVisible(wanted) {
      if (visible === wanted) return
      visible = wanted
      if (visible) {
        paintStatic()
        paintDynamic()
      }
      layer.visible = visible
    },
    drawStatic(shapes, resolution) {
      recordedStatic = { shapes, resolution }
      if (visible) paintStatic()
    },
    drawDynamic(shapes, resolution) {
      recordedDynamic = { shapes, resolution }
      if (visible) paintDynamic()
    },
  }
}

function drawShapes(
  graphics: Graphics,
  labels: Container,
  collision: readonly CollisionShape[],
  resolution: number,
  createText: RendererTextFactory,
): void {
  graphics.clear()
  const placed: PlacedLabel[] = []
  for (const shape of collision) {
    const color = colorFor(shape.group)
    if (shape.kind === 'rect') {
      graphics
        .rect(shape.rect.x, shape.rect.y, shape.rect.width, shape.rect.height)
        .fill({ color, alpha: 0.24 })
        .stroke({ color, width: 1 })
      if (shape.group === 'object') {
        placed.push({ value: shape.label, x: shape.rect.x + 2, y: shape.rect.y + 2 })
      }
    } else {
      graphics
        .circle(shape.center.x, shape.center.y, shape.radius)
        .fill({ color, alpha: 0.24 })
        .stroke({ color, width: 1 })
      placed.push({
        value: shape.label,
        x: shape.center.x + shape.radius + 2,
        y: shape.center.y + 2,
      })
    }
  }
  retainLabels(labels, placed, resolution, createText)
}

function retainLabels(
  layer: Container,
  placed: readonly PlacedLabel[],
  resolution: number,
  createText: RendererTextFactory,
): void {
  const existing = layer.children
  for (let index = 0; index < placed.length; index += 1) {
    const desired = placed[index]
    if (desired === undefined) continue
    const node = existing[index]
    if (node instanceof Text) {
      if (node.text !== desired.value) node.text = desired.value
      if (node.resolution !== resolution) node.resolution = resolution
      node.position.set(desired.x, desired.y)
    } else {
      layer.addChild(newLabel(desired.value, desired.x, desired.y, resolution, createText))
    }
  }
  while (layer.children.length > placed.length) {
    const extra = layer.removeChildAt(layer.children.length - 1)
    extra.destroy()
  }
}

function newLabel(
  value: string,
  x: number,
  y: number,
  resolution: number,
  createText: RendererTextFactory,
): Text {
  const label = createText(value, 9, PALETTE.text, 'left', 'ui-monospace, monospace')
  label.resolution = resolution
  label.position.set(x, y)
  return label
}

function colorFor(group: CollisionShape['group']): string {
  if (group === 'blocked') return PALETTE.blockedCollision
  if (group === 'object') return PALETTE.objectCollision
  if (group === 'character') return PALETTE.characterCollision
  return PALETTE.boundaryCollision
}
