import { Container, Graphics } from 'pixi.js'

import { CATALOG } from './overlay.js'
import { PALETTE } from './presentation.js'
import type { FrameScene, StaticDrawable, StaticScene } from './types.js'

interface PropNode {
  root: Container
}

/** Operations exposed by the retained prop display layer. */
export interface PropLayer {
  /** Apply one dynamic frame to the retained prop nodes. */
  reconcile(scene: FrameScene): void
}

/** Build stable prop and scenery nodes whose states are exposed by diagnostic collision mode. */
export function createPropLayer(layer: Container, scene: StaticScene): PropLayer {
  const nodes = new Map<string, PropNode>()
  for (const item of [...scene.scenery, ...scene.props]) {
    const node = createNode(item, scene.props.some((prop) => prop.id === item.id))
    nodes.set(item.id, node)
    layer.addChild(node.root)
  }
  return {
    reconcile(frame) {
      for (const prop of scene.props) {
        const node = nodes.get(prop.id)
        const catalog = CATALOG.props.find((item) => item.token === prop.type)
        if (node === undefined || catalog === undefined) continue
        const state = frame.dynamic?.props[prop.id] ?? catalog.start
        node.root.alpha = state === catalog.start ? 0.72 : 1
      }
    },
  }
}

function createNode(item: StaticDrawable, interactive: boolean): PropNode {
  const root = new Container()
  const shape = new Graphics()
  const color = interactive ? PALETTE.prop : PALETTE.scenery
  if (item.shape === 'circle') {
    shape.circle(item.rect.x + item.rect.width / 2, item.rect.y + item.rect.height / 2, Math.min(item.rect.width, item.rect.height) / 2).fill(color)
  } else {
    shape.rect(item.rect.x, item.rect.y, item.rect.width, item.rect.height).fill(color)
  }
  if (item.facing !== undefined) {
    const centerX = item.rect.x + item.rect.width / 2
    const centerY = item.rect.y + item.rect.height / 2
    const direction = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }[item.facing]
    if (direction !== undefined) {
      const [dx = 0, dy = 0] = direction
      shape.moveTo(centerX, centerY).lineTo(centerX + dx * 8, centerY + dy * 8).stroke({ color: PALETTE.text, width: 2 })
    }
  }
  root.addChild(shape)
  return { root }
}
