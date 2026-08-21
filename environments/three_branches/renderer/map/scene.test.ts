import { describe, expect, it } from 'vitest'
import { THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import { fixtureRecording } from '../core/test-helpers.js'
import type { CharacterDrawable, FrameScene } from '../core/types.js'
import { expectedCharacterIds, RULES, readDynamic, readStatic } from '../ui/overlay.js'
import {
  advanceWalkDistance,
  buildStaticScene,
  computeScene,
  expressionTitleFor,
  interpolateScene,
  pointToWorld,
  rectToWorld,
  sceneCharactersMoved,
  sceneVisitorMoved,
  settleGlideOnto,
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
    expect(scene.scenery.map((item) => item.collisionScale)).toEqual(
      village.scenery.map((item) => item.scale),
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

describe('interpolateScene walk displacement', () => {
  const { header, states } = fixtureRecording()
  const scene = buildStaticScene(readStatic(header))
  const roster = expectedCharacterIds(header)

  function rewriteCharacters(
    frame: FrameScene,
    overrides: Readonly<
      Record<
        string,
        Partial<Pick<CharacterDrawable, 'point' | 'x' | 'y' | 'moved' | 'heading' | 'walkDistance'>>
      >
    >,
  ): FrameScene {
    return {
      ...frame,
      characters: frame.characters.map((character) => {
        const override = overrides[character.id]
        return override === undefined ? character : { ...character, ...override }
      }),
    }
  }

  it('walks a character that displaces and rests one that stays put', () => {
    const from = computeScene(states[0] as (typeof states)[number], scene, roster)
    const to = computeScene(states[1] as (typeof states)[number], scene, roster)
    const mover = from.characters[0]
    const still = from.characters[1]
    if (mover === undefined || still === undefined) {
      throw new Error('the walk fixture needs at least two characters.')
    }
    const movedFrom = rewriteCharacters(from, {
      [mover.id]: { point: { x: 40, y: 80 }, x: 4, y: 8 },
    })
    const movedTo = rewriteCharacters(to, {
      [mover.id]: { point: { x: 50, y: 80 }, x: 5, y: 8, moved: 0.6 },
      [still.id]: { point: still.point, x: still.x, y: still.y, moved: 0 },
    })
    const halfway = interpolateScene(movedFrom, movedTo, 0.5)
    expect(halfway.characters.find((character) => character.id === mover.id)?.moved).toBe(0.6)
    expect(halfway.characters.find((character) => character.id === still.id)?.moved).toBe(0)
  })

  it('rests feet when the source and target points are equal despite a landed flag', () => {
    const from = computeScene(states[0] as (typeof states)[number], scene, roster)
    const mover = from.characters[0]
    if (mover === undefined) throw new Error('the walk fixture needs at least one character.')
    const to = rewriteCharacters(from, {
      [mover.id]: { point: mover.point, x: mover.x, y: mover.y, moved: 0.6 },
    })
    const halfway = interpolateScene(from, to, 0.5)
    expect(halfway.characters.find((character) => character.id === mover.id)?.moved).toBe(0)
  })

  it('lerps the walk phase distance between the source and target frames', () => {
    const from = computeScene(states[0] as (typeof states)[number], scene, roster)
    const to = computeScene(states[1] as (typeof states)[number], scene, roster)
    const mover = from.characters[0]
    if (mover === undefined) throw new Error('the walk fixture needs at least one character.')
    const walkFrom = rewriteCharacters(from, { [mover.id]: { walkDistance: 10 } })
    const walkTo = rewriteCharacters(to, { [mover.id]: { walkDistance: 14 } })
    const halfway = interpolateScene(walkFrom, walkTo, 0.5)
    expect(halfway.characters.find((character) => character.id === mover.id)?.walkDistance).toBe(12)
  })

  it('zeroes a recorded walk displacement below the dead zone on a landed frame', () => {
    const state = states[0] as (typeof states)[number]
    const dynamic = readDynamic(state, roster, scene.village)
    if (dynamic === null) throw new Error('the dead zone fixture needs a dynamic overlay.')
    const drift = dynamic.characters[0]
    const stride = dynamic.characters[1]
    if (drift === undefined || stride === undefined) {
      throw new Error('the dead zone fixture needs at least two characters.')
    }
    const patched: typeof state = {
      ...state,
      overlay: {
        ...(state.overlay ?? {}),
        characters: dynamic.characters.map((character) => ({
          ...character,
          moved:
            character.id === drift.id ? 0.03 : character.id === stride.id ? 0.5 : character.moved,
        })),
      },
    }
    const landed = computeScene(patched, scene, roster)
    expect(landed.characters.find((character) => character.id === drift.id)?.moved).toBe(0)
    expect(landed.characters.find((character) => character.id === stride.id)?.moved).toBe(0.5)
  })

  it('advances, holds, and re-anchors the walked phase accumulator', () => {
    const state = states[0] as (typeof states)[number]
    const dynamic = readDynamic(state, roster, scene.village)
    if (dynamic === null) throw new Error('the walk accumulator fixture needs a dynamic overlay.')
    const mover = dynamic.characters[0]
    if (mover === undefined) throw new Error('the walk accumulator fixture needs a character.')
    const patched = (moved: number): typeof state => ({
      ...state,
      overlay: {
        ...(state.overlay ?? {}),
        characters: dynamic.characters.map((character) => ({
          ...character,
          moved: character.id === mover.id ? moved : character.moved,
        })),
      },
    })

    const accumulated = new Map<string, number>()
    const first = computeScene(patched(0.4), scene, roster)
    advanceWalkDistance(accumulated, first, false, true)
    expect(first.characters.find((character) => character.id === mover.id)?.walkDistance).toBe(0.4)

    const second = computeScene(patched(0.6), scene, roster)
    advanceWalkDistance(accumulated, second, false, true)
    expect(second.characters.find((character) => character.id === mover.id)?.walkDistance).toBe(1)

    const held = computeScene(patched(0.6), scene, roster)
    advanceWalkDistance(accumulated, held, false, false)
    expect(held.characters.find((character) => character.id === mover.id)?.walkDistance).toBe(1)

    const reanchored = computeScene(patched(0.6), scene, roster)
    advanceWalkDistance(accumulated, reanchored, true, false)
    expect(reanchored.characters.find((character) => character.id === mover.id)?.walkDistance).toBe(
      0,
    )
    expect(accumulated.size).toBe(0)
  })

  it('settles a glide onto a later frame and snaps onto a same-tick re-delivery', () => {
    const from = computeScene(states[0] as (typeof states)[number], scene, roster)
    const to = computeScene(states[1] as (typeof states)[number], scene, roster)
    expect(settleGlideOnto(null, to)).toBe(false)
    expect(settleGlideOnto({ to: from }, to)).toBe(from.dynamic?.tick !== to.dynamic?.tick)
    // A movement already aimed at the same recorded tick must snap, not re-aim.
    const same = computeScene(states[1] as (typeof states)[number], scene, roster)
    expect(settleGlideOnto({ to }, same)).toBe(false)
  })

  it('flags displacement above the dead zone and turns, but never a still visitor', () => {
    const from = computeScene(states[0] as (typeof states)[number], scene, roster)
    const mover = from.characters[0]
    const npc = from.characters[1]
    const visitor = from.characters.find((character) => character.id === 'player_0')
    if (mover === undefined || npc === undefined || visitor === undefined) {
      throw new Error('the movement fixture needs the visitor and at least two characters.')
    }
    const allStill = Object.fromEntries(
      from.characters.map((character) => [character.id, { moved: 0 }]),
    )
    const rest = rewriteCharacters(from, allStill)
    expect(sceneCharactersMoved(from, rest)).toBe(false)
    expect(sceneVisitorMoved(from, rest)).toBe(false)

    const shifted = rewriteCharacters(rest, { [mover.id]: { moved: 0.06 } })
    expect(sceneCharactersMoved(rest, shifted)).toBe(true)

    const visitorMoved = rewriteCharacters(rest, { [visitor.id]: { moved: 0.06 } })
    expect(sceneVisitorMoved(rest, visitorMoved)).toBe(true)

    const turnedNpc = rewriteCharacters(rest, { [npc.id]: { heading: npc.heading + 90 } })
    expect(sceneCharactersMoved(rest, turnedNpc)).toBe(true)
    expect(sceneVisitorMoved(rest, turnedNpc)).toBe(false)

    const turnedVisitor = rewriteCharacters(rest, {
      [visitor.id]: { heading: visitor.heading + 90 },
    })
    expect(sceneCharactersMoved(rest, turnedVisitor)).toBe(true)
    expect(sceneVisitorMoved(rest, turnedVisitor)).toBe(false)
  })

  it('keeps the recorded walk flag on a landed target scene', () => {
    const state = states[0] as (typeof states)[number]
    const to = computeScene(state, scene, roster)
    const dynamic = readDynamic(state, roster, scene.village)
    const recordedBy = new Map(
      (dynamic?.characters ?? []).map((item) => [item.id, item.moved] as const),
    )
    for (const character of to.characters) {
      expect(character.moved).toBe(recordedBy.get(character.id))
    }
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
