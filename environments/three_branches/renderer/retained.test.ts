import { Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import { CharactersLayer } from './characters.js'
import { CraneLayer, cranePresentationFor } from './cranes.js'
import { WORLD_SCALE, WORLD_SIZE_METERS } from './geometry.js'
import { PhaseGradeLayer } from './phase-grade.js'
import { handsFrameFor, PRESENTATION, stableHash } from './presentation.js'
import { PropsLayer } from './props-layer.js'
import { computeScene, type DynamicScene, PALETTE, staticScene } from './scene.js'
import { firstDynamic, staticOverlay } from './test-helpers.js'
import { createVillage, doorwayTangentRotation } from './village.js'

const staticPresentation = staticScene(staticOverlay)
const baseDynamic = computeScene(firstDynamic, staticOverlay).dynamic
const textureFor = () => Texture.WHITE

describe('Hearthside retained scene', () => {
  it('seeks all five sustained prop treatments back to the same retained node state', () => {
    const target = dynamicWithPropStates(137, 'night', true)
    const away = dynamicWithPropStates(811, 'evening', false)
    const fresh = new PropsLayer(staticPresentation, PALETTE, textureFor)
    const retained = new PropsLayer(staticPresentation, PALETTE, textureFor)
    fresh.update(target)
    retained.update(target)
    const retainedRoots = [...retained.view.children]
    retained.update(away)
    retained.update(target)

    const ids = activePropIds()
    const expected = fresh.snapshot().filter((item) => ids.has(item.id))
    const repeated = retained.snapshot().filter((item) => ids.has(item.id))
    expect(repeated).toEqual(expected)
    expect(retained.view.children).toEqual(retainedRoots)
    for (const item of repeated) {
      expect(item.effect.visible || item.emissive.visible).toBe(true)
      expect(item.effect.asset || item.emissive.asset).not.toBe('')
    }
    fresh.destroy()
    retained.destroy()
  })

  it('seeks a walking character back to its exact retained head, hand, and heading pose', () => {
    const target = dynamicWithMovingCharacter(137, 33)
    const away = dynamicWithMovingCharacter(509, 241)
    const fresh = new CharactersLayer(PALETTE, () => null)
    const retained = new CharactersLayer(PALETTE, () => null)
    fresh.update(target, 2)
    retained.update(target, 2)
    const retainedRoots = [...retained.view.children]
    retained.update(away, 2)
    retained.update(target, 2)

    const expected = fresh.snapshot().find((item) => item.id === target.characters[0]?.id)
    const repeated = retained.snapshot().find((item) => item.id === target.characters[0]?.id)
    expect(repeated).toEqual(expected)
    expect(retained.view.children).toEqual(retainedRoots)
    const id = target.characters[0]?.id ?? ''
    const cycle = [0, 1, 2, 3].map((step) => handsFrameFor(137 + step, id, 10))
    expect(new Set(cycle).size).toBe(4)
    expect(repeated?.hands).toBe(handsFrameFor(137, id, 10))
    expect(repeated?.presentation).toBe('detailed')
    expect(repeated?.rotation).toBeCloseTo(((33 + 90) * Math.PI) / 180)
    fresh.destroy()
    retained.destroy()
  })

  it('seeks phase grade and crane sprites without retaining history', () => {
    const freshGrade = new PhaseGradeLayer()
    const retainedGrade = new PhaseGradeLayer()
    freshGrade.update('night')
    retainedGrade.update('night')
    retainedGrade.update('dawn')
    retainedGrade.update('night')
    expect(retainedGrade.snapshot()).toEqual(freshGrade.snapshot())
    expect(retainedGrade.snapshot()).toMatchObject({ phase: 'night', visible: true })

    const freshCranes = new CraneLayer(staticPresentation.layoutKey, PALETTE, textureFor)
    const retainedCranes = new CraneLayer(staticPresentation.layoutKey, PALETTE, textureFor)
    freshCranes.update(137)
    retainedCranes.update(137)
    const target = retainedCranes.snapshot()
    retainedCranes.update(509)
    expect(retainedCranes.snapshot()).not.toEqual(target)
    retainedCranes.update(137)
    expect(retainedCranes.snapshot()).toEqual(freshCranes.snapshot())
    freshCranes.destroy()
    retainedCranes.destroy()
  })

  it('renders smooth retained midpoints for prop effects, crane flight, and walking hands', () => {
    const propLayer = new PropsLayer(staticPresentation, PALETTE, textureFor)
    propLayer.update(dynamicWithPropStates(137, 'night', true))
    const propStart = propLayer.snapshot()
    propLayer.update(dynamicWithPropStates(137.5, 'night', true))
    const propMidpoint = propLayer.snapshot()
    propLayer.update(dynamicWithPropStates(138, 'night', true))
    const propEnd = propLayer.snapshot()
    for (const id of representativeActivePropIds()) {
      expect(motionFor(propMidpoint, id)).not.toEqual(motionFor(propStart, id))
      expect(motionFor(propMidpoint, id)).not.toEqual(motionFor(propEnd, id))
    }

    const craneLayer = new CraneLayer(staticPresentation.layoutKey, PALETTE, textureFor)
    craneLayer.update(137)
    const craneStart = craneLayer.snapshot()
    craneLayer.update(137.5)
    const craneMidpoint = craneLayer.snapshot()
    craneLayer.update(138)
    const craneEnd = craneLayer.snapshot()
    expect(craneMidpoint).not.toEqual(craneStart)
    expect(craneMidpoint).not.toEqual(craneEnd)

    const characterLayer = new CharactersLayer(PALETTE, () => null)
    characterLayer.update(dynamicWithMovingCharacter(137, 33, 0), 2)
    const characterStart = characterLayer.snapshot()[0]
    characterLayer.update(dynamicWithMovingCharacter(137.5, 33, 5), 2)
    const characterMidpoint = characterLayer.snapshot()[0]
    characterLayer.update(dynamicWithMovingCharacter(138, 33, 10), 2)
    const characterEnd = characterLayer.snapshot()[0]
    expect(characterMidpoint?.handsAlpha).not.toBe(characterStart?.handsAlpha)
    expect(characterMidpoint?.handsAlpha).not.toBe(characterEnd?.handsAlpha)
    expect(characterMidpoint?.x).toBeCloseTo(
      ((characterStart?.x ?? 0) + (characterEnd?.x ?? 0)) / 2,
    )

    propLayer.destroy()
    craneLayer.destroy()
    characterLayer.destroy()
  })

  it('wraps crane routes only beyond the visible world boundary', () => {
    const period = PRESENTATION.cranes.periodTicks
    const seed = stableHash(`${staticPresentation.layoutKey}:crane:0`)
    const wrapTick = (period - (seed % period)) % period
    const before = cranePresentationFor(staticPresentation.layoutKey, 0, wrapTick - 0.001)
    const after = cranePresentationFor(staticPresentation.layoutKey, 0, wrapTick)
    const worldWidth = WORLD_SIZE_METERS * WORLD_SCALE
    expect([before.x, after.x].some((x) => x < 0)).toBe(true)
    expect([before.x, after.x].some((x) => x > worldWidth)).toBe(true)
  })

  it('reaches the same pose through the per-frame motion path as through a full tick', () => {
    const start = dynamicWithMovingCharacter(137, 33, 0)
    const midpoint = dynamicWithMovingCharacter(137.5, 61, 5)
    const perTick = new CharactersLayer(PALETTE, () => null)
    const perFrame = new CharactersLayer(PALETTE, () => null)
    perTick.update(midpoint, 2)
    perFrame.update(start, 2)
    perFrame.applyMotion(midpoint)
    expect(perFrame.snapshot()).toEqual(perTick.snapshot())

    const propsPerTick = new PropsLayer(staticPresentation, PALETTE, textureFor)
    const propsPerFrame = new PropsLayer(staticPresentation, PALETTE, textureFor)
    propsPerTick.update(dynamicWithPropStates(137.5, 'night', true))
    propsPerFrame.update(dynamicWithPropStates(137, 'night', true))
    propsPerFrame.animate(137.5)
    expect(propsPerFrame.snapshot()).toEqual(propsPerTick.snapshot())

    perTick.destroy()
    perFrame.destroy()
    propsPerTick.destroy()
    propsPerFrame.destroy()
  })

  it('mounts every doorway mark along its actual wall tangent', () => {
    const art = createVillage(staticPresentation, PALETTE)
    const doorwayMarks = art.upper.children.filter((child) => child.label === 'doorwayMark')
    expect(doorwayMarks).toHaveLength(staticPresentation.buildings.length)
    for (const [index, building] of staticPresentation.buildings.entries()) {
      expect(doorwayMarks[index]?.rotation).toBeCloseTo(doorwayTangentRotation(building))
    }
    art.lower.destroy({ children: true })
    art.upper.destroy({ children: true })
  })
})

function dynamicWithPropStates(tick: number, phase: string, active: boolean): DynamicScene {
  const dynamic = structuredClone(baseDynamic)
  dynamic.tick = tick
  dynamic.phase = phase
  const states: Record<string, string> = active
    ? { lantern: 'lit', hearth: 'lit', shrine: 'tended', pump: 'flowing', bell: 'ringing' }
    : { lantern: 'unlit', hearth: 'unlit', shrine: 'untended', pump: 'idle', bell: 'silent' }
  for (const prop of dynamic.props) prop.state = states[prop.type] ?? prop.state
  return dynamic
}

function dynamicWithMovingCharacter(tick: number, heading: number, xOffset = 0): DynamicScene {
  const dynamic = structuredClone(baseDynamic)
  dynamic.tick = tick
  const character = dynamic.characters[0]
  if (character === undefined) throw new Error('fixture has no character')
  character.moved = 10
  character.heading = heading
  character.position.x += xOffset
  return dynamic
}

function activePropIds(): Set<string> {
  const types = new Set(['lantern', 'hearth', 'shrine', 'pump', 'bell'])
  return new Set(
    staticPresentation.props.filter((prop) => types.has(prop.type)).map((prop) => prop.id),
  )
}

function representativeActivePropIds(): string[] {
  return ['lantern', 'hearth', 'shrine', 'pump', 'bell'].map((type) => {
    const prop = staticPresentation.props.find((candidate) => candidate.type === type)
    if (prop === undefined) throw new Error(`fixture has no ${type}`)
    return prop.id
  })
}

function motionFor(
  snapshots: ReturnType<PropsLayer['snapshot']>,
  id: string,
): { alpha: number; rotation: number; y: number } {
  const prop = snapshots.find((candidate) => candidate.id === id)
  if (prop === undefined) throw new Error(`retained layer has no ${id}`)
  const moving = prop.effect.visible ? prop.effect : prop.emissive
  return { alpha: moving.alpha, rotation: moving.rotation, y: moving.y }
}
