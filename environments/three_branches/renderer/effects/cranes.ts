import { degreesToRadians, hashUnit, stableHashParts } from '@renderers/base/math.js'
import { Container, Sprite, type Texture } from 'pixi.js'

import { HEARTHSIDE_STYLE, THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import type { StaticScene, WorldSize } from '../core/types.js'
import type { DayLight } from './post-effects.js'

const CRANE_FRAME_WIDTH = 192
/** How far, in cells, a crane's ground shadow falls per cell of character shadow length. */
const SHADOW_HEIGHT_CELLS = 10
const SHADOW_BASE_CELLS = 2
const SHADOW_ALPHA = 0.5

/** One crane at one presented instant, in renderer world coordinates. */
export interface CranePlacement {
  x: number
  y: number
  /** Sprite rotation. The art faces north, so this turns it onto its heading. */
  rotation: number
  frame: string
}

/** Operations exposed by the retained crane dressing. */
export interface CraneLayer {
  install(effects: Readonly<Record<string, Texture>>): void
  present(light: DayLight, tick: number): void
}

/** A stable seed for one static layout, so the same village always gets the same flock. */
export function craneSeed(scene: StaticScene): number {
  return stableHashParts(
    'three-branches-cranes',
    scene.village.size.cellsX,
    scene.village.size.cellsY,
    ...scene.village.ground,
  )
}

/**
 * Where every crane is at a presented tick. The flock size comes from the layout seed. Each crane
 * flies straight across the village on a route picked by hash from its seed, index, and flight
 * number, starting and ending beyond the world edge, and its wings alternate by tick. Everything
 * is a pure function of the tick, so seeks land on exactly the frame continuous play would show.
 */
export function cranePlacements(
  seed: number,
  world: WorldSize,
  tick: number,
): readonly CranePlacement[] {
  const { count, frames, flightTicks, ticksPerFrame } = HEARTHSIDE_STYLE.cranes
  const total = count[0] + Math.floor(hashUnit(seed) * (count[1] - count[0] + 1))
  const reach = Math.hypot(world.width, world.height) / 2 + spanUnits()
  const placements: CranePlacement[] = []
  for (let index = 0; index < total; index += 1) {
    // Staggered flights keep the flock from leaving and re-entering in one beat.
    const stagger = hashUnit(stableHashParts('crane-stagger', seed, index)) * flightTicks
    const flight = Math.floor((tick + stagger) / flightTicks)
    const progress = (tick + stagger) / flightTicks - flight
    const route = (name: string): number => hashUnit(stableHashParts(name, seed, index, flight))
    const heading = route('crane-heading') * Math.PI * 2
    const centreX = world.width * (0.2 + 0.6 * route('crane-centre-x'))
    const centreY = world.height * (0.2 + 0.6 * route('crane-centre-y'))
    const along = (progress * 2 - 1) * reach
    const frame = frames[(Math.floor(tick / ticksPerFrame) + index) % frames.length] ?? ''
    placements.push({
      x: centreX + Math.cos(heading) * along,
      y: centreY + Math.sin(heading) * along,
      rotation: heading + Math.PI / 2,
      frame,
    })
  }
  return placements
}

/**
 * Draw the white cranes as renderer dressing above the authored village. They have no collision,
 * perception, or gameplay effect, fade with the day light, and cast a faint shadow that follows
 * the sun.
 */
export function createCraneLayer(layer: Container, scene: StaticScene): CraneLayer {
  const seed = craneSeed(scene)
  const cellUnits = THREE_BRANCHES_PRESENTATION.unitsPerMetre * scene.village.size.cellSize
  const scale = spanUnits() / CRANE_FRAME_WIDTH
  const shadows = new Container({ label: 'crane-shadows' })
  const birds = new Container({ label: 'crane-birds' })
  layer.addChild(shadows, birds)
  let frames: Readonly<Record<string, Texture>> | null = null

  const spriteAt = (parent: Container, index: number, label: string): Sprite => {
    const existing = parent.children[index]
    if (existing instanceof Sprite) return existing
    const sprite = new Sprite({ label })
    sprite.anchor.set(0.5)
    sprite.scale.set(scale)
    parent.addChild(sprite)
    return sprite
  }

  return {
    install(effects) {
      frames = effects
    },
    present(light, tick) {
      layer.visible = frames !== null && light.cranes > 0
      if (frames === null || !layer.visible) return
      const placements = cranePlacements(seed, scene.world, tick)
      const angle = degreesToRadians(light.shadow.angleDegrees)
      const drop = (SHADOW_BASE_CELLS + SHADOW_HEIGHT_CELLS * light.shadow.length) * cellUnits
      for (const [index, placement] of placements.entries()) {
        const texture = frames[placement.frame]
        if (texture === undefined) throw new Error(`Crane frame is missing: ${placement.frame}`)
        const bird = spriteAt(birds, index, `crane:${index}`)
        bird.texture = texture
        bird.tint = HEARTHSIDE_STYLE.palette[HEARTHSIDE_STYLE.cranes.tint]
        bird.alpha = light.cranes
        bird.position.set(placement.x, placement.y)
        bird.rotation = placement.rotation
        const shadow = spriteAt(shadows, index, `crane-shadow:${index}`)
        shadow.texture = texture
        shadow.tint = HEARTHSIDE_STYLE.palette.backdrop
        shadow.alpha = light.cranes * light.shadow.alpha * SHADOW_ALPHA
        shadow.position.set(
          placement.x + Math.cos(angle) * drop,
          placement.y + Math.sin(angle) * drop,
        )
        shadow.rotation = placement.rotation
      }
    },
  }
}

function spanUnits(): number {
  return HEARTHSIDE_STYLE.cranes.spanMetres * THREE_BRANCHES_PRESENTATION.unitsPerMetre
}
