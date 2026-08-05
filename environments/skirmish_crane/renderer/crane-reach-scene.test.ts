import type { StepState } from '@game-sandbox/schema'
import { getRenderer } from '@renderers/registry.js'
import { describe, expect, it } from 'vitest'

import '@renderers/index.js'
import tileTypes from '../tile_types.json'
import { CRANE_STYLE, computeScene, decodeOverlay, unitCardFor } from './scene.js'
import {
  armyFixture,
  armyLegalityRaw,
  armyStates,
  skirmishFixture,
  skirmishLegalityRaw,
  skirmishStates,
  verifyLegalityFixture,
} from './test-helpers.js'

describe('Crane Reach scene geometry and compact overlay', () => {
  it('registers the public renderer key', () => {
    expect(getRenderer('crane-reach-field')).toBeDefined()
  })

  it('lays out pointy-top axial hexes with the void surround still visible', () => {
    const scene = computeScene(skirmishStates[0] as StepState)
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
    const scene = computeScene(armyStates[0] as StepState)
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
    const scenes = armyStates.map((state) => computeScene(state))
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
      .map((state) => computeScene(state))
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

  it('decodes v2 routes and recovers v1 paths before falling back to endpoint geometry', () => {
    const source = armyStates[0] as StepState
    const overlay = source.overlay as Record<string, unknown>
    const event = [0, 10, 10, 10, 11, -1, 0, false, -1, 0, 0]
    const pathId = 58 // Directions 1, 3, 4: a turn that retraces q before ending at 10,11.
    const v2 = computeScene({ ...source, overlay: { ...overlay, k: 2, e: [...event, pathId] } })
    expect(v2.event?.movementTiles).toBe(3)
    expect(v2.event?.route).toHaveLength(4)
    expect(v2.event?.route[0]).toEqual(v2.tiles.find((tile) => tile.key === '10,10')?.center)
    expect(v2.event?.route.at(-1)).toEqual(v2.tiles.find((tile) => tile.key === '10,11')?.center)

    const withActorPath = (path: unknown): StepState => ({
      ...source,
      agents: {
        ...source.agents,
        player_0: {
          reward: source.agents.player_0?.reward ?? 0,
          score: source.agents.player_0?.score ?? 0,
          action: { path },
        },
      },
    })
    const v1 = computeScene({
      ...withActorPath(pathId),
      overlay: { ...overlay, k: 1, e: event },
    })
    expect(v1.event?.route).toEqual(v2.event?.route)

    const degraded = computeScene({
      ...withActorPath(true),
      overlay: { ...overlay, k: 1, e: [0, 10, 10, 14, 14, -1, 0, false, -1, 0, 0] },
    })
    expect(degraded.event?.route).toHaveLength(2)
    expect(degraded.event?.movementTiles).toBe(4)
  })

  it('keeps structured HUD and terminal state in the scene rather than renderer history', () => {
    const first = computeScene(skirmishStates[0] as StepState)
    const final = computeScene(skirmishStates.at(-1) as StepState)
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
    const armyScenes = armyStates.map((state) => computeScene(state))
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
    const afterLoss = computeScene({ ...source, overlay: { ...overlay, u: records } })
    expect(afterLoss.hud.rosters.red.footman).toBe(7)
  })

  it('pairs every inspection stat icon with a label and enables configured ability lines', () => {
    const withoutAbilities = computeScene(armyStates[0] as StepState)
    const withAbilities = computeScene(armyStates[0] as StepState, { unitAbilities: true })
    expect(withoutAbilities.hud.unitAbilities).toBe(false)
    expect(withAbilities.hud.unitAbilities).toBe(true)
    expect(unitCardFor('footman', 4, true)).toMatchObject({
      fields: [
        { icon: 'iconHp', label: 'HP', value: '4/12' },
        { icon: 'iconMove', label: 'MOV', value: '2' },
        { icon: 'iconAttack', label: 'ATK', value: '3' },
        { icon: 'iconRange', label: 'RNG', value: '1' },
        { icon: 'iconVision', label: 'VIS', value: '4' },
      ],
      ability: 'Shield wall',
    })
    expect(unitCardFor('cavalry', null, true).ability).toBe('Charge')
    expect(unitCardFor('archer', null, true).ability).toBeNull()
    expect(unitCardFor('footman', null, false).ability).toBeNull()
  })

  it('derives red, blue, and draw terminal tints without legacy caption text', () => {
    const source = skirmishStates.at(-1) as StepState
    const terminal = (outcome: [number, number]) =>
      computeScene({ ...source, overlay: { ...(source.overlay as object), x: true, o: outcome } })
        .hud.terminal
    expect(terminal([84, 16])).toEqual({ winner: 'red', result: 'red wins 84 - 16' })
    expect(terminal([16, 84])).toEqual({ winner: 'blue', result: 'blue wins 84 - 16' })
    expect(terminal([50, 50])).toEqual({ winner: 'draw', result: 'draw 50 - 50' })
    expect(JSON.stringify(computeScene(source).hud)).not.toMatch(/Control|activation|caption/i)
  })

  it('is deterministic when a replay seeks to a previously rendered state', () => {
    const selected = armyStates[Math.floor(armyStates.length / 2)] as StepState
    const before = computeScene(selected)
    for (const state of armyStates) computeScene(state)
    expect(computeScene(selected)).toEqual(before)
  })

  it('rejects unsupported compact overlay versions', () => {
    const state: StepState = {
      schema_version: 1,
      tick: 0,
      agents: {},
      timing: { started_at: 0, duration_ms: 0 },
      overlay: { k: 3 },
    }
    expect(() => decodeOverlay(state)).toThrow('unsupported version')
  })
})

describe('Crane Reach scene performance', () => {
  it('computes every army recording frame within the pinned smoke budget', () => {
    const started = performance.now()
    for (const state of armyStates) computeScene(state)
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
