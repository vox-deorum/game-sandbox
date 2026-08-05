import type { StepState } from '@game-sandbox/schema'
import { describe, expect, it } from 'vitest'

import {
  EMPTY_INSPECTION,
  inspectionPresentation,
  pinsInspectionForPointer,
  rangePresentation,
  reduceInspection,
  resolveInspection,
} from './inspection.js'
import { reachableTileKeys } from './reachability.js'
import { computeScene, type HexTile, type SceneUnit } from './scene.js'
import {
  armyFixture,
  armyLegalityRaw,
  expectedDestinations,
  type LegalityEntry,
  type LegalityFixture,
  skirmishFixture,
  skirmishLegalityRaw,
  statesFrom,
} from './test-helpers.js'

describe('Crane Reach HUD inspection and range', () => {
  it('keeps mouse hover transient while touch inspection persists, replaces, and dismisses', () => {
    const footman = { kind: 'roster', side: 'red', type: 'footman' } as const
    const archer = { kind: 'unit', unitId: 'blue_archer_0' } as const
    expect(pinsInspectionForPointer('mouse')).toBe(false)
    expect(pinsInspectionForPointer('touch')).toBe(true)
    expect(pinsInspectionForPointer('pen')).toBe(true)

    const pinnedRoster = reduceInspection(EMPTY_INSPECTION, { type: 'inspect', target: footman })
    const boardHover = reduceInspection(pinnedRoster, { type: 'hover-unit', unitId: archer.unitId })
    expect(resolveInspection(boardHover)).toEqual(archer)
    expect(inspectionPresentation(boardHover)).toEqual({ target: archer, range: 'inspected' })
    expect(rangePresentation(boardHover)).toEqual({
      wash: 'bone',
      alpha: 0.18,
      outline: 'dashed',
      outlineInk: 'dilute-ink',
      ring: true,
    })

    const restored = reduceInspection(boardHover, { type: 'hover-unit', unitId: null })
    expect(resolveInspection(restored)).toEqual(footman)
    expect(rangePresentation(restored)).toMatchObject({
      wash: 'gilt',
      outline: 'solid',
      ring: false,
    })
    const rosterHover = reduceInspection(restored, { type: 'hover-roster', target: footman })
    expect(inspectionPresentation(rosterHover)).toEqual({ target: footman, range: 'acting' })

    const pinnedUnit = reduceInspection(restored, { type: 'inspect', target: archer })
    expect(
      resolveInspection(reduceInspection(pinnedUnit, { type: 'hover-unit', unitId: null })),
    ).toEqual(archer)
    expect(rangePresentation(pinnedUnit, false)).toMatchObject({
      wash: 'gilt',
      outline: 'solid',
      ring: false,
    })
    expect(reduceInspection(pinnedUnit, { type: 'inspect', target: footman }).target).toEqual(
      footman,
    )
    expect(reduceInspection(pinnedUnit, { type: 'dismiss' })).toEqual(EMPTY_INSPECTION)
  })

  it('mirrors terrain cost, occupancy, the first expensive step, and the four-step limit', () => {
    const tile = (
      q: number,
      r: number,
      terrain: HexTile['terrain'] = 'grass',
      feature: HexTile['feature'] = 'none',
    ): HexTile => ({
      key: `${q},${r}`,
      q,
      r,
      terrain,
      feature,
      center: { x: q, y: r },
      corners: [],
    })
    const unit = { unitId: 'red_footman_0', tileKey: '0,0', type: 'footman' } as SceneUnit
    const tiles = [
      tile(0, 0),
      tile(1, 0, 'hill'),
      tile(2, 0),
      tile(3, 0),
      tile(4, 0),
      tile(0, 1, 'grass', 'marsh'),
      tile(1, 1),
    ]
    const reachable = reachableTileKeys(unit, tiles, [
      unit,
      { ...unit, unitId: 'blue_archer_0', tileKey: '1,1' },
    ])
    expect(reachable).toEqual(new Set(['0,0', '1,0', '0,1']))
    expect(reachable.has('2,0')).toBe(false)
    expect(reachable.has('1,1')).toBe(false)
    const cavalry = { ...unit, type: 'cavalry' as const }
    const line = Array.from({ length: 6 }, (_, q) => tile(q, 0))
    expect(reachableTileKeys(cavalry, line, [cavalry]).has('4,0')).toBe(true)
    expect(reachableTileKeys(cavalry, line, [cavalry]).has('5,0')).toBe(false)
  })

  it('matches fixture legality destination sets for each acting unit', () => {
    for (const [recording, legalityRaw] of [
      [skirmishFixture, skirmishLegalityRaw],
      [armyFixture, armyLegalityRaw],
    ] as const) {
      const states = statesFrom(recording)
      const legality = JSON.parse(legalityRaw) as LegalityFixture
      const opening = legality.entries[0]?.opening as StepState
      const openingScene = computeScene(opening)
      const openingUnit = openingScene.units.find(
        (candidate) => candidate.playerId === openingScene.activation?.playerId,
      )
      expect(openingUnit).toBeDefined()
      expect(
        reachableTileKeys(openingUnit as SceneUnit, openingScene.tiles, openingScene.units),
      ).toEqual(
        expectedDestinations(legality.entries[0] as LegalityEntry, openingUnit as SceneUnit),
      )
      const actionable = states.filter(
        (state) => ((state.overlay ?? {}) as Record<string, unknown>).a !== null,
      )
      for (const [index, state] of actionable.entries()) {
        const scene = computeScene(state)
        const unit = scene.units.find(
          (candidate) => candidate.playerId === scene.activation?.playerId,
        )
        const entry = legality.entries[index + 1] as LegalityEntry
        expect(unit).toBeDefined()
        expect(reachableTileKeys(unit as SceneUnit, scene.tiles, scene.units)).toEqual(
          expectedDestinations(entry, unit as SceneUnit),
        )
      }
    }
  })
})
