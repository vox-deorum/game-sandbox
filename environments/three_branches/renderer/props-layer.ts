import { type Container, Graphics } from 'pixi.js'

import { CATALOG } from './overlay.js'
import { HEARTHSIDE_STYLE, PALETTE } from './presentation.js'
import type { FrameScene, StaticDrawable, StaticScene } from './types.js'

/** Operations exposed by the retained prop display layer. */
export interface PropLayer {
  /** Apply one dynamic frame to the retained prop nodes. */
  reconcile(scene: FrameScene): void
  /** Outline one prop for the use preview, or clear the outline with null. */
  highlight(propId: string | null): void
}

/** Build stable prop and scenery nodes whose states are exposed by diagnostic collision mode. */
export function createPropLayer(
  sceneryLayer: Container,
  propLayer: Container,
  scene: StaticScene,
): PropLayer {
  const nodes = new Map<string, Graphics>()
  const startById = new Map<string, string>()
  for (const item of scene.scenery) {
    sceneryLayer.addChild(createNode(item, false))
  }
  for (const item of scene.props) {
    const node = createNode(item, true)
    const start = CATALOG.props.find((kind) => kind.token === item.type)?.start
    if (start === undefined) throw new Error(`Unknown prop type ${item.type}.`)
    nodes.set(item.id, node)
    startById.set(item.id, start)
    propLayer.addChild(node)
  }
  // Added last, so the preview outline draws above every prop body.
  const highlightNode = new Graphics()
  propLayer.addChild(highlightNode)
  return {
    reconcile(frame) {
      for (const prop of scene.props) {
        const node = nodes.get(prop.id)
        const start = startById.get(prop.id)
        if (node === undefined || start === undefined) continue
        const state = frame.dynamic?.props[prop.id] ?? start
        node.alpha = state === start ? 0.72 : 1
      }
    },
    highlight(propId) {
      highlightNode.clear()
      if (propId === null) return
      const item = scene.props.find((prop) => prop.id === propId)
      if (item === undefined) return
      const stroke = { color: HEARTHSIDE_STYLE.palette.gilt, width: 2 }
      if (item.shape === 'circle') {
        highlightNode
          .circle(
            item.rect.x + item.rect.width / 2,
            item.rect.y + item.rect.height / 2,
            Math.min(item.rect.width, item.rect.height) / 2 + 2,
          )
          .stroke(stroke)
      } else {
        highlightNode
          .rect(item.rect.x - 2, item.rect.y - 2, item.rect.width + 4, item.rect.height + 4)
          .stroke(stroke)
      }
    },
  }
}

function createNode(item: StaticDrawable, interactive: boolean): Graphics {
  const shape = new Graphics()
  const color = interactive ? PALETTE.prop : PALETTE.scenery
  if (item.shape === 'circle') {
    shape
      .circle(
        item.rect.x + item.rect.width / 2,
        item.rect.y + item.rect.height / 2,
        Math.min(item.rect.width, item.rect.height) / 2,
      )
      .fill(color)
  } else {
    shape.rect(item.rect.x, item.rect.y, item.rect.width, item.rect.height).fill(color)
  }
  if (item.facing !== undefined) {
    const centerX = item.rect.x + item.rect.width / 2
    const centerY = item.rect.y + item.rect.height / 2
    const direction = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }[item.facing]
    if (direction !== undefined) {
      const [dx = 0, dy = 0] = direction
      shape
        .moveTo(centerX, centerY)
        .lineTo(centerX + dx * 8, centerY + dy * 8)
        .stroke({ color: PALETTE.text, width: 2 })
    }
  }
  return shape
}
