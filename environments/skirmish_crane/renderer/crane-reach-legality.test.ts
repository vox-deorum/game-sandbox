/**
 * The mask-agreement suite. The renderer computes legality itself so recordings stay compact, which
 * only works if its answer is the environment's answer. For the live-only opening state and every
 * actionable frame of both fixtures, the walkable path ids and the nameable target values computed
 * from the overlay must equal the masks the environment actually published that turn, exactly.
 */
import type { StepState } from '@game-sandbox/schema'
import { describe, expect, it } from 'vitest'

import {
  enemyRoster,
  nameableTargetValues,
  reachableTileKeys,
  walkablePathIds,
  walkFieldFor,
} from './legality.js'
import { decodePath, encodePath, MAX_PATH_ID } from './paths.js'
import { computeScene, hexDistance, type SceneUnit, tileCoordinate, UNIT_STATS } from './scene.js'
import {
  allowedValues,
  armyFixture,
  armyLegalityRaw,
  legalityCases,
  skirmishFixture,
  skirmishLegalityRaw,
} from './test-helpers.js'

const PATH_BITS = MAX_PATH_ID + 1

/** The acting unit and everything the legality module needs about its turn. */
function actingUnit(state: StepState): SceneUnit {
  const scene = computeScene(state)
  const activation = scene.activation
  expect(activation).not.toBeNull()
  const unit = scene.units.find((candidate) => candidate.unitId === activation?.unitId)
  expect(unit).toBeDefined()
  return unit as SceneUnit
}

const FIXTURES = [
  { name: 'skirmish', recording: skirmishFixture, legality: skirmishLegalityRaw, targetBits: 4 },
  { name: 'army', recording: armyFixture, legality: armyLegalityRaw, targetBits: 21 },
] as const

describe('Crane Reach mask agreement', () => {
  for (const fixture of FIXTURES) {
    it(`walks exactly the paths the ${fixture.name} masks allow`, () => {
      const cases = legalityCases(fixture.recording, fixture.legality)
      expect(cases.length).toBeGreaterThan(1)
      for (const { entry, state } of cases) {
        const scene = computeScene(state)
        const unit = actingUnit(state)
        expect(unit.playerId).toBe(entry.current_activation)
        const computed = walkablePathIds(walkFieldFor(unit, scene.tiles, scene.units), unit)
        expect([...computed].sort((a, b) => a - b)).toEqual(
          [...allowedValues(entry.path, PATH_BITS)].sort((a, b) => a - b),
        )
        // Stay is always legal and is what the confirmation button sends with an empty path.
        expect(computed.has(0)).toBe(true)
      }
    })

    it(`names exactly the targets the ${fixture.name} masks allow`, () => {
      const cases = legalityCases(fixture.recording, fixture.legality)
      for (const { entry, state } of cases) {
        const scene = computeScene(state)
        const unit = actingUnit(state)
        const visible = scene.visibility.get(unit.playerId)
        expect(visible).toBeDefined()
        const computed = nameableTargetValues(
          visible as ReadonlySet<string>,
          scene.roster,
          unit.side,
        )
        expect([...computed].sort((a, b) => a - b)).toEqual(
          [...allowedValues(entry.target, fixture.targetBits)].sort((a, b) => a - b),
        )
        // None is always legal, and is what human input always sends.
        expect(computed.has(0)).toBe(true)
      }
    })
  }

  it('keeps a visible enemy nameable well beyond strike range', () => {
    const cases = legalityCases(armyFixture, armyLegalityRaw)
    let farNameable = 0
    for (const { state } of cases) {
      const scene = computeScene(state)
      const unit = actingUnit(state)
      const visible = scene.visibility.get(unit.playerId) as ReadonlySet<string>
      const roster = enemyRoster(scene.roster, unit.side)
      for (const [slot, entry] of roster.entries()) {
        if (!visible.has(entry.unitId)) continue
        const enemy = scene.units.find((candidate) => candidate.unitId === entry.unitId)
        if (enemy === undefined) continue
        const distance = hexDistance(tileCoordinate(unit.tileKey), tileCoordinate(enemy.tileKey))
        if (distance <= UNIT_STATS[unit.type].range) continue
        farNameable += 1
        const nameable = nameableTargetValues(visible, scene.roster, unit.side)
        expect(nameable.has(slot + 1)).toBe(true)
      }
    }
    expect(farNameable).toBeGreaterThan(0)
  })

  it('round-trips every path id through the codec the student contract fixes', () => {
    expect(encodePath([])).toBe(0)
    expect(decodePath(0)).toEqual([])
    expect(encodePath([1])).toBe(1)
    expect(encodePath([6])).toBe(6)
    expect(encodePath([1, 1])).toBe(7)
    expect(encodePath([1, 2])).toBe(8)
    expect(encodePath([6, 6, 6, 6])).toBe(MAX_PATH_ID)
    for (let pathId = 0; pathId <= MAX_PATH_ID; pathId += 1) {
      expect(encodePath(decodePath(pathId))).toBe(pathId)
    }
    expect(() => decodePath(MAX_PATH_ID + 1)).toThrow()
    expect(() => encodePath([0])).toThrow()
    expect(() => encodePath([1, 1, 1, 1, 1])).toThrow()
  })

  it('reaches every tile the walkable paths end on, and no others', () => {
    const cases = legalityCases(skirmishFixture, skirmishLegalityRaw)
    for (const { state } of cases) {
      const scene = computeScene(state)
      const unit = actingUnit(state)
      const field = walkFieldFor(unit, scene.tiles, scene.units)
      const fromPaths = new Set(
        [...walkablePathIds(field, unit)].map((pathId) => {
          let { q, r } = tileCoordinate(unit.tileKey)
          for (const direction of decodePath(pathId)) {
            const [dq, dr] = [
              [1, -1],
              [1, 0],
              [0, 1],
              [-1, 1],
              [-1, 0],
              [0, -1],
            ][direction - 1] as [number, number]
            q += dq
            r += dr
          }
          return `${q},${r}`
        }),
      )
      expect(reachableTileKeys(unit, scene.tiles, scene.units)).toEqual(fromPaths)
    }
  })
})
