import { describe, expect, it } from 'vitest'

import { collisionWithPropStates, frameCollision, staticCollision } from './collision.js'
import { CATALOG, expectedCharacterIds, readStatic, RULES } from './overlay.js'
import { THREE_BRANCHES_PRESENTATION } from './presentation.js'
import { buildStaticScene, computeScene } from './scene.js'
import { fixtureRecording } from './test-helpers.js'

describe('Three Branches collision scene', () => {
  it('derives blocked cells from passability while leaving configured doorways open', () => {
    const scene = buildStaticScene(readStatic(fixtureRecording().header))
    const shapes = staticCollision(scene)
    const blockedCodes = new Set(RULES.grounds.filter((ground) => !ground.passable).map((ground) => ground.code))
    const expectedBlocked = scene.village.ground.reduce(
      (count, row) => count + [...row].filter((code) => blockedCodes.has(code)).length,
      0,
    )
    expect(shapes.filter((shape) => shape.group === 'blocked')).toHaveLength(expectedBlocked)
    const doorway = RULES.grounds.find((ground) => ground.name === 'doorway')
    expect(doorway?.passable).toBe(true)
    expect(shapes.filter((shape) => shape.group === 'boundary')).toHaveLength(4)
  })

  it('uses catalog shapes without rotating prop collision by facing', () => {
    const scene = buildStaticScene(readStatic(fixtureRecording().header))
    const shapes = staticCollision(scene)
    for (const prop of scene.props) {
      const catalog = CATALOG.props.find((item) => item.token === prop.type)
      const shape = shapes.find((item) => item.id === prop.id)
      expect(shape?.kind).toBe(catalog?.shape === 'circle' ? 'circle' : 'rect')
    }
  })

  it('uses the configured character radius for the dynamic bodies', () => {
    const { header, states } = fixtureRecording()
    const scene = buildStaticScene(readStatic(header))
    const frame = computeScene(states[0] as (typeof states)[number], scene, expectedCharacterIds(header))
    const bodies = frameCollision(frame)
    expect(bodies).toHaveLength(expectedCharacterIds(header).length)
    expect(bodies.every((shape) => shape.kind === 'circle' && shape.radius === RULES.profile.body_radius * THREE_BRANCHES_PRESENTATION.unitsPerMetre)).toBe(true)
    const labelled = collisionWithPropStates(staticCollision(scene), frame)
    const prop = scene.props[0]
    expect(labelled.find((shape) => shape.id === prop?.id)?.label).toContain(
      frame.dynamic?.props[prop?.id ?? ''],
    )
  })
})
