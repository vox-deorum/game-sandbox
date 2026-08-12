import { degreesToRadians } from '@renderers/base/math.js'
import { type Container, Graphics } from 'pixi.js'

import { PALETTE } from './presentation.js'
import type { CharacterDrawable, FrameScene } from './types.js'

/** Operations exposed by the retained character display layer. */
export interface CharacterLayer {
  /** Reconcile the retained character nodes toward one pure frame. */
  reconcile(scene: FrameScene): void
}

/** Reconcile characters by stable environment id so arbitrary replay seeks never depend on arrival order. */
export function createCharacterLayer(layer: Container): CharacterLayer {
  const nodes = new Map<string, Graphics>()
  return {
    reconcile(scene) {
      const active = new Set(scene.characters.map((character) => character.id))
      for (const [id, body] of nodes) {
        if (!active.has(id)) {
          body.destroy()
          nodes.delete(id)
        }
      }
      for (const character of scene.characters) {
        let body = nodes.get(character.id)
        if (body === undefined) {
          body = new Graphics()
          nodes.set(character.id, body)
          layer.addChild(body)
        }
        drawCharacter(body, character)
      }
    },
  }
}

function drawCharacter(body: Graphics, character: CharacterDrawable): void {
  body.clear()
  body
    .circle(character.point.x, character.point.y, character.radius)
    .fill(character.fill)
    .stroke({ color: PALETTE.backdrop, width: 2 })
  const heading = degreesToRadians(character.heading)
  body
    .moveTo(character.point.x, character.point.y)
    .lineTo(
      character.point.x + Math.cos(heading) * character.radius * 1.8,
      character.point.y - Math.sin(heading) * character.radius * 1.8,
    )
    .stroke({ color: PALETTE.backdrop, width: 2 })
}
