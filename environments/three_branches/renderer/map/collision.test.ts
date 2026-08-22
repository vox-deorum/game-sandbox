import { describe, expect, it } from 'vitest'
import { THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import { fixtureRecording } from '../core/test-helpers.js'
import { CATALOG, expectedCharacterIds, RULES, readStatic } from '../ui/overlay.js'
import { collisionWithPropStates, frameCollision, staticCollision } from './collision.js'
import { buildStaticScene, computeScene } from './scene.js'

describe('Three Branches collision scene', () => {
  it('derives blocked cells from passability while leaving configured doorways open', () => {
    const scene = buildStaticScene(readStatic(fixtureRecording().header))
    const shapes = staticCollision(scene)
    const blockedCodes = new Set(
      RULES.grounds.filter((ground) => !ground.passable).map((ground) => ground.code),
    )
    const expectedBlocked = scene.village.ground.reduce(
      (count, row) => count + [...row].filter((code) => blockedCodes.has(code)).length,
      0,
    )
    expect(shapes.filter((shape) => shape.group === 'blocked')).toHaveLength(expectedBlocked)
    const doorway = RULES.grounds.find((ground) => ground.name === 'doorway')
    expect(doorway?.passable).toBe(true)
    expect(shapes.filter((shape) => shape.group === 'boundary')).toHaveLength(4)
  })

  it('keeps catalog shapes axis-aligned while following a turned prop footprint', () => {
    const village = readStatic(fixtureRecording().header)
    const scene = buildStaticScene(village)
    const shapes = staticCollision(scene)
    for (const prop of scene.props) {
      const catalog = CATALOG.props.find((item) => item.token === prop.type)
      const shape = shapes.find((item) => item.id === prop.id)
      expect(shape?.kind).toBe(catalog?.shape === 'circle' ? 'circle' : 'rect')
    }
    const bench = village.props.find((item) => item.type === 'bench')
    if (bench === undefined) throw new Error('the fixture has no bench to turn.')
    // Both facings are set here rather than read off the fixture, so regenerating the recording
    // cannot quietly hand this the bench already turned and leave it asserting nothing.
    const facing = (direction: typeof bench.facing) =>
      staticCollision(
        buildStaticScene({
          ...village,
          props: village.props.map((item) =>
            item.id === bench.id ? { ...item, facing: direction } : item,
          ),
        }),
      ).find((shape) => shape.id === bench.id)
    const upright = facing('north')
    const turned = facing('east')
    if (upright?.kind !== 'rect' || turned?.kind !== 'rect') throw new Error('a bench is a box.')
    expect(turned.rect.width).toBe(upright.rect.height)
    expect(turned.rect.height).toBe(upright.rect.width)

    const crate = scene.scenery.find((item) => item.type === 'crate')
    const crateCollision = shapes.find((item) => item.id === crate?.id)
    expect(crateCollision).toEqual(
      crate === undefined
        ? undefined
        : { id: crate.id, kind: 'rect', rect: crate.rect, label: crate.label, group: 'object' },
    )
  })

  it('uses the configured character radius for the dynamic bodies', () => {
    const { header, states } = fixtureRecording()
    const scene = buildStaticScene(readStatic(header))
    const frame = computeScene(
      states[0] as (typeof states)[number],
      scene,
      expectedCharacterIds(header),
    )
    const bodies = frameCollision(frame)
    expect(bodies).toHaveLength(expectedCharacterIds(header).length)
    expect(
      bodies.every(
        (shape) =>
          shape.kind === 'circle' &&
          shape.radius === RULES.profile.body_radius * THREE_BRANCHES_PRESENTATION.unitsPerMetre,
      ),
    ).toBe(true)
    const labelled = collisionWithPropStates(staticCollision(scene), frame)
    const prop = scene.props[0]
    expect(labelled.find((shape) => shape.id === prop?.id)?.label).toContain(
      frame.dynamic?.props[prop?.id ?? ''],
    )
  })
})
