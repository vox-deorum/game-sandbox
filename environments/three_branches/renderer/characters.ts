import { degreesToRadians } from '@renderers/base/math.js'
import { Container, Graphics } from 'pixi.js'

import { PALETTE } from './presentation.js'
import type { CharacterDrawable, FrameScene } from './types.js'

interface CharacterNode {
  root: Container
  body: Graphics
}

/** Operations exposed by the retained character display layer. */
export interface CharacterLayer {
  /** Reconcile the retained character nodes toward one pure frame. */
  reconcile(scene: FrameScene): void
}

/** Reconcile characters by stable environment id so arbitrary replay seeks never depend on arrival order. */
export function createCharacterLayer(layer: Container): CharacterLayer {
  const nodes = new Map<string, CharacterNode>()
  return {
    reconcile(scene) {
      const active = new Set(scene.characters.map((character) => character.id))
      for (const [id, node] of nodes) {
        if (!active.has(id)) {
          node.root.destroy({ children: true })
          nodes.delete(id)
        }
      }
      for (const character of scene.characters) {
        let node = nodes.get(character.id)
        if (node === undefined) {
          node = createNode()
          nodes.set(character.id, node)
          layer.addChild(node.root)
        }
        drawCharacter(node, character)
      }
    },
  }
}

function createNode(): CharacterNode {
  const root = new Container()
  const body = new Graphics()
  root.addChild(body)
  return { root, body }
}

function drawCharacter(node: CharacterNode, character: CharacterDrawable): void {
  node.body.clear()
  node.body.circle(character.point.x, character.point.y, character.radius).fill(character.fill).stroke({ color: PALETTE.backdrop, width: 2 })
  const heading = degreesToRadians(character.heading)
  node.body.moveTo(character.point.x, character.point.y).lineTo(character.point.x + Math.cos(heading) * character.radius * 1.8, character.point.y - Math.sin(heading) * character.radius * 1.8).stroke({ color: PALETTE.backdrop, width: 2 })
}
