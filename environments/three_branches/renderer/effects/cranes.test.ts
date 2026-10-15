import { Container, Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import { HEARTHSIDE_STYLE } from '../core/presentation.js'
import { fixtureRecording } from '../core/test-helpers.js'
import { buildStaticScene } from '../map/scene.js'
import { readStatic } from '../ui/overlay.js'
import { cranePlacements, craneSeed, createCraneLayer } from './cranes.js'
import { dayLightAt } from './post-effects.js'

function fixtureStatic() {
  return buildStaticScene(readStatic(fixtureRecording().header))
}

describe('Three Branches cranes', () => {
  it('places a stable flock whose size stays inside the configured range', () => {
    const scene = fixtureStatic()
    const seed = craneSeed(scene)
    expect(craneSeed(fixtureStatic())).toBe(seed)
    const placements = cranePlacements(seed, scene.world, 300)
    const [minimum, maximum] = HEARTHSIDE_STYLE.cranes.count
    expect(placements.length).toBeGreaterThanOrEqual(minimum)
    expect(placements.length).toBeLessThanOrEqual(maximum)
    expect(cranePlacements(seed, scene.world, 300)).toEqual(placements)
  })

  it('moves smoothly within a flight and alternates its wing frames by tick', () => {
    const scene = fixtureStatic()
    const seed = craneSeed(scene)
    const stepUnits =
      (2 * Math.hypot(scene.world.width, scene.world.height)) / HEARTHSIDE_STYLE.cranes.flightTicks
    for (let tick = 0; tick < 1200; tick += 1) {
      const now = cranePlacements(seed, scene.world, tick)
      const next = cranePlacements(seed, scene.world, tick + 0.5)
      for (const [index, crane] of now.entries()) {
        const later = next[index]
        if (later === undefined || later.rotation !== crane.rotation) continue
        expect(Math.hypot(later.x - crane.x, later.y - crane.y)).toBeLessThan(stepUnits)
      }
    }
    const frames = new Set(
      [0, 1, 2, 3].map((tick) => cranePlacements(seed, scene.world, tick)[0]?.frame),
    )
    expect(frames).toEqual(new Set(HEARTHSIDE_STYLE.cranes.frames))
  })

  it('draws only after its art loads and hides when the night fades the cranes out', () => {
    const scene = fixtureStatic()
    const layer = new Container()
    const cranes = createCraneLayer(layer, scene)
    cranes.present(dayLightAt('midday', 600), 600)
    expect(layer.visible).toBe(false)

    cranes.install(
      Object.fromEntries(HEARTHSIDE_STYLE.cranes.frames.map((frame) => [frame, Texture.WHITE])),
    )
    cranes.present(dayLightAt('midday', 600), 600)
    expect(layer.visible).toBe(true)
    const birds = layer.getChildByLabel('crane-birds') as Container
    expect(birds.children.length).toBe(cranePlacements(craneSeed(scene), scene.world, 600).length)

    cranes.present(dayLightAt('night', 1100), 1100)
    expect(layer.visible).toBe(false)
  })
})
