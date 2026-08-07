import type { StepState } from '@game-sandbox/schema'
import type { FederatedPointerEvent } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import {
  EMPTY_INSPECTION,
  inspectionPresentation,
  type ProjectedUnit,
  pinsInspectionForPointer,
  probeExclusions,
  rangePresentation,
  rangeVisibleDuringEvent,
  reduceInspection,
  resolveInspection,
  selectInspectionProbe,
} from './inspection.js'
import { reachableTileKeys } from './legality.js'
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
import { createUnitNode } from './units.js'

describe('Crane Reach HUD inspection and range', () => {
  it('ignores bubbling pointerout and clears hover only when the pointer leaves the unit', () => {
    const events: string[] = []
    const node = createUnitNode(
      'red_footman_0',
      (event) => {
        if (event.type === 'hover-unit') events.push(event.unitId ?? 'none')
      },
      pinsInspectionForPointer,
    )

    const pointer = {} as FederatedPointerEvent
    node.root.emit('pointerenter', pointer)
    node.root.emit('pointerout', pointer)
    expect(events).toEqual(['red_footman_0'])
    node.root.emit('pointerleave', pointer)
    expect(events).toEqual(['red_footman_0', 'none'])
    node.root.destroy({ children: true })
  })

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
    expect(rangeVisibleDuringEvent(true, false)).toBe(true)
    expect(rangeVisibleDuringEvent(false, true)).toBe(true)
    expect(rangeVisibleDuringEvent(false, false)).toBe(false)

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

  it('probes the visible unit nearest the view center, not whichever sorts first', () => {
    // A camera zoomed and panned toward the far edge of the map, as the browser suite does, can leave
    // an edge-hugging unit only a short pan away from the frame while a central one stays put. Picking
    // whichever unit sorts first in scene order (rather than the one nearest the center) previously let
    // the probe anchor on that edge unit, so a small camera move afterward carried it off screen and
    // the test's follow-up hover landed on empty ground. See crane-reach.spec.ts's zoom-then-pan step.
    const view = { width: 1200, height: 860 }
    const edge = projectedUnit('blue_footman_0', 'blue', { x: 1027, y: 430 })
    const central = projectedUnit('red_footman_0', 'red', { x: 620, y: 440 })
    expect(selectInspectionProbe([edge, central], view, new Set())?.unit.unitId).toBe(
      'red_footman_0',
    )
    // Order must not matter: the same pair reversed still resolves to the central unit.
    expect(selectInspectionProbe([central, edge], view, new Set())?.unit.unitId).toBe(
      'red_footman_0',
    )
  })

  it('excludes the active event actor and target before falling back to the next tier', () => {
    const view = { width: 1200, height: 860 }
    const actor = projectedUnit('red_footman_0', 'red', { x: 600, y: 430 })
    const cavalry = projectedUnit('red_cavalry_0', 'red', { x: 610, y: 430 }, 'cavalry')
    const probe = selectInspectionProbe([actor, cavalry], view, new Set(['red_footman_0']))
    expect(probe?.unit.unitId).toBe('red_cavalry_0')
  })

  it('falls back to the off-screen unit nearest the view center when nothing is visible', () => {
    const view = { width: 1200, height: 860 }
    const farLeft = projectedUnit('red_footman_0', 'red', { x: -900, y: 430 })
    const farRight = projectedUnit('blue_footman_0', 'blue', { x: 1_500, y: 430 })
    const probe = selectInspectionProbe([farLeft, farRight], view, new Set())
    expect(probe?.unit.unitId).toBe('blue_footman_0')
  })

  it('excludes the event actor and target only while the event is still presenting', () => {
    // A skirmish has exactly one footman per side, so once that unit has acted, permanently
    // excluding it would leave the probe with only the other side's footman, however far from the
    // view center that one happens to be deployed. Once the event settles it is no less stable or
    // hoverable than any other unit, so the exclusion must lift with it.
    const event = { actorId: 'red_footman_0', targetId: 'blue_archer_0' }
    expect(probeExclusions(event, true)).toEqual(new Set(['red_footman_0', 'blue_archer_0']))
    expect(probeExclusions(event, false)).toEqual(new Set())
    expect(probeExclusions(null, true)).toEqual(new Set())
    expect(probeExclusions({ actorId: 'red_footman_0', targetId: null }, true)).toEqual(
      new Set(['red_footman_0']),
    )
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

function projectedUnit(
  unitId: string,
  side: 'red' | 'blue',
  point: { x: number; y: number },
  type: SceneUnit['type'] = 'footman',
): ProjectedUnit {
  return {
    unit: {
      playerId: unitId,
      unitId,
      side,
      type,
      hitPoints: 10,
      position: point,
      tileKey: '0,0',
    },
    point,
  }
}
