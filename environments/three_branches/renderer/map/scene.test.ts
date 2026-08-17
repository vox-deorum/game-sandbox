import { describe, expect, it } from 'vitest'
import { THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import { fixtureRecording } from '../core/test-helpers.js'
import { expectedCharacterIds, RULES, readStatic } from '../ui/overlay.js'
import {
  buildStaticScene,
  computeScene,
  expressionTitleFor,
  interpolateScene,
  pointToWorld,
  rectToWorld,
} from './scene.js'

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
    expect(halfway.presentationTick).toBeCloseTo((from.presentationTick + to.presentationTick) / 2)
    expect(halfway.static).toBe(scene)
    expect(to).toEqual(computeScene(states[1] as (typeof states)[number], scene, roster))
  })
})

describe('expressionTitleFor', () => {
  const { header } = fixtureRecording()
  const scene = buildStaticScene(readStatic(header))

  it('returns null for none', () => {
    expect(expressionTitleFor(scene, { type: 'none', target: 'none' })).toBeNull()
  })

  it('title-cases an emote token', () => {
    expect(expressionTitleFor(scene, { type: 'wave', target: 'none' })).toBe('Wave')
    expect(expressionTitleFor(scene, { type: 'shake_head', target: 'none' })).toBe('Shake Head')
  })

  it('names the target prop activity per prop type', () => {
    expect(expressionTitleFor(scene, { type: 'use', target: 'bench_0' })).toBe('Sitting')
    expect(expressionTitleFor(scene, { type: 'use', target: 'pump_0' })).toBe('Working Pump')
    expect(expressionTitleFor(scene, { type: 'use', target: 'board_0' })).toBe('Reading Board')
    expect(expressionTitleFor(scene, { type: 'use', target: 'shrine_0' })).toBe('Tending Shrine')
    expect(expressionTitleFor(scene, { type: 'use', target: 'bell_0' })).toBe('Ringing Bell')
  })

  it('falls back to Use when the target is absent from the scene', () => {
    expect(expressionTitleFor(scene, { type: 'use', target: 'missing_0' })).toBe('Use')
  })
})
