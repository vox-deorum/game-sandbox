import type { StepState } from '@game-sandbox/schema'
import { getRenderer } from '@renderers/registry.js'
import { describe, expect, it } from 'vitest'

import '@renderers/index.js'
import tileTypes from '../tile_types.json'
import { CRANE_STYLE, decodeOverlay, unitCardFor } from './scene.js'
import {
  armyFixture,
  armyLegalityRaw,
  armyScene,
  armyStates,
  skirmishFixture,
  skirmishLegalityRaw,
  skirmishScene,
  skirmishStates,
  skirmishStaticOverlay,
  verifyLegalityFixture,
} from './test-helpers.js'

describe('Crane Reach scene geometry and compact overlay', () => {
  it('registers the public renderer key', () => {
    expect(getRenderer('crane-reach-field')).toBeDefined()
  })

  it('lays out pointy-top axial hexes with the void surround still visible', () => {
    const scene = skirmishScene(skirmishStates[0] as StepState)
    const origin = scene.tiles.find((tile) => tile.q === 0 && tile.r === 0)
    const east = scene.tiles.find((tile) => tile.q === 1 && tile.r === 0)
    const southeast = scene.tiles.find((tile) => tile.q === 0 && tile.r === 1)
    expect(origin).toBeDefined()
    expect(east).toBeDefined()
    expect(southeast).toBeDefined()
    expect(origin?.corners[0]?.y).toBeLessThan(origin?.center.y as number)
    expect(east?.center.x).toBeCloseTo(
      (origin?.center.x as number) + Math.sqrt(3) * scene.hexRadius,
    )
    expect(southeast?.center.x).toBeCloseTo(
      (origin?.center.x as number) + (Math.sqrt(3) * scene.hexRadius) / 2,
    )
    expect(southeast?.center.y).toBeCloseTo((origin?.center.y as number) + scene.hexRadius * 1.5)
    expect(scene.tiles.some((tile) => tile.terrain === 'void')).toBe(true)
  })

  it('maps every terrain and feature code from the full variant', () => {
    const scene = armyScene(armyStates[0] as StepState)
    expect(scene.tiles.some((tile) => tile.terrain === 'grass')).toBe(true)
    expect(scene.tiles.some((tile) => tile.terrain === 'hill')).toBe(true)
    expect(scene.tiles.some((tile) => tile.terrain === 'water')).toBe(true)
    expect(scene.tiles.some((tile) => tile.feature === 'forest')).toBe(true)
    expect(scene.tiles.some((tile) => tile.feature === 'marsh')).toBe(true)
    expect(scene.tiles.some((tile) => tile.feature === 'waste')).toBe(true)
  })

  it('styles every tile type the shared source declares', () => {
    expect(Object.keys(tileTypes.terrains).sort()).toEqual(Object.keys(CRANE_STYLE.terrain).sort())
    expect(Object.keys(tileTypes.features).sort()).toEqual(Object.keys(CRANE_STYLE.feature).sort())
  })

  it('draws capture zones, all unit types, hit points, and the active unit', () => {
    const scenes = armyStates.map((state) => armyScene(state))
    const scene = scenes.find((candidate) => candidate.zones.length > 0)
    expect(scene?.zones.length).toBeGreaterThan(0)
    expect(new Set(scene?.units.map((unit) => unit.type))).toEqual(
      new Set(['footman', 'archer', 'cavalry']),
    )
    expect(scene?.units.every((unit) => unit.hitPoints > 0)).toBe(true)
    const activeScene = scenes.find((candidate) => candidate.activation !== null)
    expect(activeScene?.activation).not.toBeNull()
    expect(activeScene?.units.some((unit) => unit.unitId === activeScene.activation?.unitId)).toBe(
      true,
    )
  })

  it('keeps the most recent activation event as drawable scene content', () => {
    const scene = armyStates
      .map((state) => armyScene(state))
      .find((candidate) => candidate.event !== null)
    expect(scene?.event?.actorId).toMatch(/^(red|blue)_(footman|archer|cavalry)_\d+$/)
    expect(scene?.event?.from).toEqual(
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    )
    expect(scene?.event?.to).toEqual(
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    )
    expect(scene?.event?.route).toEqual(expect.any(Array))
    expect(scene?.event?.movementTiles).toBeGreaterThanOrEqual(0)
  })

  it('decodes the exact path recorded in a split v1 event', () => {
    const source = armyStates[0] as StepState
    const overlay = source.overlay as Record<string, unknown>
    const pathId = 58 // Directions 1, 3, 4: a turn that retraces q before ending at 10,11.
    const scene = armyScene({
      ...source,
      overlay: {
        ...overlay,
        e: [0, 10, 10, 10, 11, -1, 0, false, -1, 0, 0, pathId],
      },
    })
    expect(scene.event?.movementTiles).toBe(3)
    expect(scene.event?.route).toHaveLength(4)
    expect(scene.event?.route[0]).toEqual(scene.tiles.find((tile) => tile.key === '10,10')?.center)
    expect(scene.event?.route.at(-1)).toEqual(
      scene.tiles.find((tile) => tile.key === '10,11')?.center,
    )
  })

  it('keeps structured HUD and terminal state in the scene rather than renderer history', () => {
    const first = skirmishScene(skirmishStates[0] as StepState)
    const final = skirmishScene(skirmishStates.at(-1) as StepState)
    expect(first.hud.round).toEqual(expect.any(Number))
    expect(first.hud.capture).toBeNull()
    expect(first.hud.rosters.red).toEqual({ footman: 1, archer: 1, cavalry: 1 })
    expect(final.hud.rosters.red.footman).toBeLessThanOrEqual(1)
    expect(final.hud.terminal).toMatchObject({
      winner: expect.any(String),
      result: expect.any(String),
    })
  })

  it('keeps capture seals absent outside capture variants and exposes live roster losses', () => {
    const armyScenes = armyStates.map((state) => armyScene(state))
    const captureScene = armyScenes.find((scene) => scene.hud.capture !== null)
    expect(captureScene?.hud.capture).toMatchObject({
      red: expect.any(Number),
      blue: expect.any(Number),
      target: 200,
    })
    const source = armyStates[0] as StepState
    const overlay = source.overlay as Record<string, unknown>
    const records = [...(overlay.u as string[])]
    const removed = records.shift()
    expect(removed).toBeDefined()
    const afterLoss = armyScene({ ...source, overlay: { ...overlay, u: records } })
    expect(afterLoss.hud.rosters.red.footman).toBe(7)
  })

  it('pairs every inspection stat icon with a label and enables configured ability lines', () => {
    const withoutAbilities = armyScene(armyStates[0] as StepState)
    const withAbilities = armyScene(armyStates[0] as StepState, {
      terrainEnabled: true,
      unitAbilities: true,
    })
    expect(withoutAbilities.hud.unitAbilities).toBe(false)
    expect(withoutAbilities.hud.terrainEnabled).toBe(false)
    expect(withAbilities.hud.unitAbilities).toBe(true)
    expect(withAbilities.hud.terrainEnabled).toBe(true)
    expect(unitCardFor('footman', 4, true, { terrain: 'hill', feature: 'forest' })).toMatchObject({
      fields: [
        { icon: 'iconHp', label: 'HP', value: '4/12' },
        { icon: 'iconMove', label: 'MOV', value: '2' },
        { icon: 'iconAttack', label: 'ATK', value: '3' },
        { icon: 'iconRange', label: 'RNG', value: '1' },
        { icon: 'iconVision', label: 'VIS', value: '4' },
      ],
      tile: { terrain: 'hill', feature: 'forest' },
      ability: 'shield_wall',
    })
    expect(unitCardFor('cavalry', null, true).ability).toBe('charge')
    expect(unitCardFor('archer', null, true).ability).toBeNull()
    expect(unitCardFor('footman', null, false).ability).toBeNull()
  })

  it('derives red, blue, and draw terminal tints without legacy caption text', () => {
    const source = skirmishStates.at(-1) as StepState
    const terminal = (outcome: [number, number]) =>
      skirmishScene({ ...source, overlay: { ...(source.overlay as object), x: true, o: outcome } })
        .hud.terminal
    expect(terminal([84, 16])).toEqual({ winner: 'red', result: 'red wins 84 - 16' })
    expect(terminal([16, 84])).toEqual({ winner: 'blue', result: 'blue wins 84 - 16' })
    expect(terminal([50, 50])).toEqual({ winner: 'draw', result: 'draw 50 - 50' })
    expect(JSON.stringify(skirmishScene(source).hud)).not.toMatch(/Control|activation|caption/i)
  })

  it('is deterministic when a replay seeks to a previously rendered state', () => {
    const selected = armyStates[Math.floor(armyStates.length / 2)] as StepState
    const before = armyScene(selected)
    for (const state of armyStates) armyScene(state)
    const after = armyScene(selected)
    expect(after).toEqual(before)
    expect(after.tiles).toBe(before.tiles)
    expect(after.zones).toBe(before.zones)
  })

  it('requires split static data and rejects unsupported compact overlay versions', () => {
    const state = skirmishStates[0] as StepState
    expect(() => decodeOverlay(state, undefined)).toThrow('no static overlay')
    expect(() => decodeOverlay(state, { ...(skirmishStaticOverlay as object), k: 2 })).toThrow(
      'unsupported version',
    )
    expect(() =>
      decodeOverlay(
        { ...state, overlay: { ...(state.overlay as object), k: 2 } },
        skirmishStaticOverlay,
      ),
    ).toThrow('unsupported version')
  })
})

describe('Crane Reach scene performance', () => {
  it('computes every army recording frame within the pinned smoke budget', () => {
    const started = performance.now()
    for (const state of armyStates) armyScene(state)
    const elapsedMs = performance.now() - started
    expect(elapsedMs).toBeLessThan(5_000)
  })
})

describe('Crane Reach generated fixture legality', () => {
  it('covers the live-only opening and every actionable skirmish frame', () => {
    verifyLegalityFixture(
      'crane-reach-skirmish-recording.jsonl',
      skirmishFixture,
      skirmishLegalityRaw,
      4,
    )
  })

  it('covers the live-only opening and every actionable army frame', () => {
    verifyLegalityFixture('crane-reach-army-recording.jsonl', armyFixture, armyLegalityRaw, 21)
  })
})
