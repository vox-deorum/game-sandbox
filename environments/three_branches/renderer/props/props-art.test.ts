import { describe, expect, it } from 'vitest'

import { atlasFrameNames } from '../assets.js'
import { HEARTHSIDE_STYLE } from '../core/presentation.js'
import { CATALOG } from '../ui/overlay.js'
import {
  isFixedFacingPropType,
  PINE_FRAME_NAMES,
  propTreatment,
  sceneryFrame,
  stallVariantIndex,
} from './props-art.js'

const framesByPage = {
  props: atlasFrameNames('props'),
  monuments: atlasFrameNames('monuments'),
  lantern: atlasFrameNames('lantern'),
} as const
const effectFrames = atlasFrameNames('effects')

describe('Three Branches prop art treatments', () => {
  it('gives ordinary state stills a centered props-page frame', () => {
    expect(propTreatment('bench', 'occupied', 'bench_0').lower).toEqual({
      page: 'props',
      frame: 'benchOccupied',
    })
  })

  it('uses one centered pump frame for both recorded states', () => {
    expect(propTreatment('pump', 'idle', 'pump_0').lower).toEqual({
      page: 'monuments',
      frame: 'pump',
    })
    expect(propTreatment('pump', 'flowing', 'pump_0').lower).toEqual(
      propTreatment('pump', 'idle', 'pump_0').lower,
    )
  })

  it('uses one centered bell frame for both recorded states', () => {
    expect(propTreatment('bell', 'ringing', 'bell_0').lower).toEqual({
      page: 'props',
      frame: 'bellBase',
    })
    expect(propTreatment('bell', 'ringing', 'bell_0').moving).toEqual({
      page: 'props',
      frame: 'bellStriker',
    })
    expect(propTreatment('bell', 'silent', 'bell_0').lower).toEqual(
      propTreatment('bell', 'ringing', 'bell_0').lower,
    )
  })

  it('uses one complete lantern page frame as a centered lower-only prop', () => {
    expect(propTreatment('lantern', 'lit', 'lantern_0').lower).toEqual({
      page: 'lantern',
      frame: 'lanternLit',
    })
  })

  it('keeps centered prop selection independent from fixed-facing selection', () => {
    expect(isFixedFacingPropType('pump')).toBe(true)
    expect(isFixedFacingPropType('bell')).toBe(true)
    expect(isFixedFacingPropType('lantern')).toBe(true)
    expect(isFixedFacingPropType('shrine')).toBe(true)
    expect(isFixedFacingPropType('board')).toBe(true)
  })

  it('keeps every selected state frame in its dedicated atlas manifest', () => {
    for (const prop of CATALOG.props) {
      for (const state of prop.states) {
        const ids = prop.token === 'stall' ? ['stall_0', 'stall_1', 'stall_2'] : [`${prop.token}_0`]
        for (const id of ids) {
          const treatment = propTreatment(prop.token, state, id).lower
          expect(framesByPage[treatment.page]).toContain(treatment.frame)
        }
      }
    }
    Object.values(HEARTHSIDE_STYLE.propEffects)
      .flatMap((effect) => effect.frames)
      .forEach((frame) => {
        expect(effectFrames).toContain(frame)
      })
  })

  it('keeps every recorded state on its own state frame', () => {
    for (const prop of CATALOG.props) {
      if (prop.token === 'bell' || prop.token === 'pump') continue
      const stateFrames = prop.states.map((state) => {
        const treatment = propTreatment(prop.token, state, `${prop.token}_0`)
        return `${treatment.lower.page}.${treatment.lower.frame}`
      })
      expect(new Set(stateFrames).size).toBe(stateFrames.length)
    }
  })

  it('cycles all three stall constructions by numeric suffix', () => {
    expect(
      ['stall_0', 'stall_1', 'stall_2', 'stall_3', 'stall_4'].map(
        (id) => propTreatment('stall', 'closed', id).lower.frame,
      ),
    ).toEqual(['stallAClosed', 'stallBClosed', 'stallCClosed', 'stallAClosed', 'stallBClosed'])
  })

  it('uses construction A when a stall id has no numeric suffix', () => {
    expect(stallVariantIndex('market-stall')).toBe(0)
    expect(propTreatment('stall', 'closed', 'market-stall').lower.frame).toBe('stallAClosed')
  })

  it('keeps stall construction independent from its recorded state', () => {
    expect(propTreatment('stall', 'closed', 'stall_2').lower.frame).toBe('stallCClosed')
    expect(propTreatment('stall', 'open', 'stall_2').lower.frame).toBe('stallCOpen')
  })

  it('selects scenery variants from stable placement ids', () => {
    expect(sceneryFrame('pine', 'scenery:4')).toBe(sceneryFrame('pine', 'scenery:4'))
    expect(
      new Set(Array.from({ length: 128 }, (_, index) => sceneryFrame('pine', `scenery:${index}`))),
    ).toEqual(new Set(PINE_FRAME_NAMES))
    expect(sceneryFrame('crate', 'scenery:4')).toBe('marketCrate')
  })

  it('fails clearly for unsupported catalog values', () => {
    expect(() => propTreatment('unknown', 'none', 'unknown_0')).toThrow(/type has no art treatment/)
    expect(() => propTreatment('lantern', 'unknown', 'lantern_0')).toThrow(
      /state has no art treatment/,
    )
  })
})
