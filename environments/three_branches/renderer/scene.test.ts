import { describe, expect, it } from 'vitest'

import { expectedCharacterIds, RULES, readStatic } from './overlay.js'
import { THREE_BRANCHES_PRESENTATION } from './presentation.js'
import {
  buildStaticScene,
  computeScene,
  interpolateScene,
  pointToWorld,
  rectToWorld,
} from './scene.js'
import { fixtureRecording } from './test-helpers.js'

describe('Three Branches pure scene', () => {
  it('derives bounds and the y inversion from configured header dimensions', () => {
    const village = readStatic(fixtureRecording().header)
    const scene = buildStaticScene(village)
    expect(scene.world).toEqual({
      width:
        village.size.cellsX * village.size.cellSize * THREE_BRANCHES_PRESENTATION.unitsPerMetre,
      height:
        village.size.cellsY * village.size.cellSize * THREE_BRANCHES_PRESENTATION.unitsPerMetre,
    })
    expect(pointToWorld(village, 2, 3)).toEqual({
      x: 2 * THREE_BRANCHES_PRESENTATION.unitsPerMetre,
      y:
        (village.size.cellsY * village.size.cellSize - 3) *
        THREE_BRANCHES_PRESENTATION.unitsPerMetre,
    })
    expect(rectToWorld(village, 2, 3, 4, 5).height).toBe(
      5 * THREE_BRANCHES_PRESENTATION.unitsPerMetre,
    )
    expect(scene.topFirstRows[0]).toBe(village.ground.at(-1))
  })

  it('maps every configured ground and catalog placement into the static scene', () => {
    const village = readStatic(fixtureRecording().header)
    const scene = buildStaticScene(village)
    expect(scene.ground.map((ground) => ground.code)).toEqual(
      RULES.grounds.map((ground) => ground.code),
    )
    expect(scene.ground.every((ground) => ground.color.length > 0)).toBe(true)
    expect(scene.buildings).toHaveLength(village.buildings.length)
    expect(scene.props).toHaveLength(village.props.length)
    expect(scene.scenery.map((item) => item.id)).toEqual(
      village.scenery.map((_, index) => `scenery:${index}`),
    )
  })

  it('turns a prop rectangle a quarter turn when it faces east or west', () => {
    const village = readStatic(fixtureRecording().header)
    const bench = village.props.find((item) => item.type === 'bench')
    if (bench === undefined) throw new Error('the fixture has no bench to turn.')
    // Both facings are set here rather than read off the fixture, so regenerating the recording
    // cannot quietly hand this the bench already turned and leave it asserting nothing.
    const facing = (direction: typeof bench.facing) =>
      buildStaticScene({
        ...village,
        props: village.props.map((item) =>
          item.id === bench.id ? { ...item, facing: direction } : item,
        ),
      }).props.find((item) => item.id === bench.id)
    const upright = facing('north')
    const turned = facing('east')
    expect(upright?.rect.width).not.toBe(upright?.rect.height)
    expect(turned?.rect.width).toBe(upright?.rect.height)
    expect(turned?.rect.height).toBe(upright?.rect.width)
    expect(turned?.rect.x).toBe(upright?.rect.x)
  })

  it('is deterministic across seeks and reuses one static reference', () => {
    const { header, states } = fixtureRecording()
    const scene = buildStaticScene(readStatic(header))
    const roster = expectedCharacterIds(header)
    const first = computeScene(states[0] as (typeof states)[number], scene, roster)
    const last = computeScene(states.at(-1) as (typeof states)[number], scene, roster)
    const repeated = computeScene(states[0] as (typeof states)[number], scene, roster)
    expect(first.static).toBe(scene)
    expect(last.static).toBe(scene)
    expect(repeated).toEqual(first)
    expect(repeated.characters.map((character) => character.id)).toEqual(roster)
  })

  it('interpolates stable characters within a tick without changing the target scene', () => {
    const { header, states } = fixtureRecording()
    const scene = buildStaticScene(readStatic(header))
    const roster = expectedCharacterIds(header)
    const from = computeScene(states[0] as (typeof states)[number], scene, roster)
    const to = computeScene(states[1] as (typeof states)[number], scene, roster)
    const halfway = interpolateScene(from, to, 0.5)
    const visitor = halfway.characters.find((character) => character.id === 'player_0')
    const fromVisitor = from.characters.find((character) => character.id === 'player_0')
    const toVisitor = to.characters.find((character) => character.id === 'player_0')
    expect(visitor?.point.x).toBeCloseTo(
      ((fromVisitor?.point.x ?? 0) + (toVisitor?.point.x ?? 0)) / 2,
    )
    expect(halfway.static).toBe(scene)
    expect(to).toEqual(computeScene(states[1] as (typeof states)[number], scene, roster))
  })
})
