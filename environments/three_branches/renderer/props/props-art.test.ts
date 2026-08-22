import { describe, expect, it } from 'vitest'

import {
  EFFECTS_ATLAS_FRAME_NAMES,
  LANTERN_ATLAS_FRAME_NAMES,
  MONUMENTS_ATLAS_FRAME_NAMES,
  PROPS_ATLAS_FRAME_NAMES,
} from '../assets.js'
import { HEARTHSIDE_STYLE } from '../core/presentation.js'
import { CATALOG } from '../ui/overlay.js'
import {
  hasPropArtRole,
  isFixedFacingPropType,
  PINE_FRAME_NAMES,
  propRoleTreatment,
  propTreatment,
  sceneryFrame,
  stallVariantIndex,
} from './props-art.js'

const framesByPage = {
  props: PROPS_ATLAS_FRAME_NAMES,
  monuments: MONUMENTS_ATLAS_FRAME_NAMES,
  lantern: LANTERN_ATLAS_FRAME_NAMES,
} as const

describe('Three Branches prop art treatments', () => {
  it('gives ordinary state stills only a lower role on the props page', () => {
    expect(propRoleTreatment('bench', 'occupied', 'bench_0', 'lower')).toMatchObject({
      page: 'props',
      frame: 'benchOccupied',
    })
    expect(propRoleTreatment('bench', 'occupied', 'bench_0', 'upper')).toBeNull()
  })

  it('uses the pump monument state twice as complementary registered clips', () => {
    expect(propRoleTreatment('pump', 'idle', 'pump_0', 'lower')).toEqual({
      page: 'monuments',
      frame: 'pumpIdle',
      registrationRole: 'full',
      clip: 'lower',
    })
    expect(propRoleTreatment('pump', 'idle', 'pump_0', 'upper')).toEqual({
      page: 'monuments',
      frame: 'pumpIdle',
      registrationRole: 'full',
      clip: 'upper',
    })
  })

  it('keeps the bell foundation below and its state still above', () => {
    expect(propRoleTreatment('bell', 'ringing', 'bell_0', 'lower')).toEqual({
      page: 'monuments',
      frame: 'bellFoundation',
      registrationRole: 'lower',
    })
    expect(propRoleTreatment('bell', 'ringing', 'bell_0', 'upper')).toEqual({
      page: 'monuments',
      frame: 'bellRinging',
      registrationRole: 'upper',
    })
  })

  it('uses one lantern page frame twice as complementary registered clips', () => {
    expect(propRoleTreatment('lantern', 'lit', 'lantern_0', 'lower')).toEqual({
      page: 'lantern',
      frame: 'lanternLit',
      registrationRole: 'full',
      clip: 'lower',
    })
    expect(propRoleTreatment('lantern', 'lit', 'lantern_0', 'upper')).toEqual({
      page: 'lantern',
      frame: 'lanternLit',
      registrationRole: 'full',
      clip: 'upper',
    })
  })

  it('keeps role selection independent from fixed-facing selection', () => {
    expect(hasPropArtRole('pump', 'upper')).toBe(true)
    expect(hasPropArtRole('pump', 'lower')).toBe(true)
    expect(isFixedFacingPropType('pump')).toBe(true)
    expect(isFixedFacingPropType('bell')).toBe(true)
    expect(isFixedFacingPropType('lantern')).toBe(true)
    expect(isFixedFacingPropType('shrine')).toBe(true)
  })

  it('keeps every selected state frame in its dedicated atlas manifest', () => {
    for (const prop of CATALOG.props) {
      for (const state of prop.states) {
        for (const role of ['lower', 'upper'] as const) {
          const ids =
            prop.token === 'stall' ? ['stall_0', 'stall_1', 'stall_2'] : [`${prop.token}_0`]
          for (const id of ids) {
            const treatment = propRoleTreatment(prop.token, state, id, role)
            if (treatment !== null) expect(framesByPage[treatment.page]).toContain(treatment.frame)
          }
        }
      }
    }
    Object.values(HEARTHSIDE_STYLE.propEffects)
      .flatMap((effect) => effect.frames)
      .forEach((frame) => expect(EFFECTS_ATLAS_FRAME_NAMES).toContain(frame))
  })

  it('keeps every recorded state on its own state frame', () => {
    for (const prop of CATALOG.props) {
      const stateFrames = prop.states.map((state) => {
        const treatment = propTreatment(prop.token, state, `${prop.token}_0`)
        const stateRole = treatment.upper ?? treatment.lower
        if (stateRole === undefined)
          throw new Error(`Prop state has no art role: ${prop.token}.${state}`)
        return `${stateRole.page}.${stateRole.frame}`
      })
      expect(new Set(stateFrames).size).toBe(stateFrames.length)
    }
  })

  it('cycles all three stall constructions by numeric suffix', () => {
    expect(
      ['stall_0', 'stall_1', 'stall_2', 'stall_3', 'stall_4'].map(
        (id) => propRoleTreatment('stall', 'closed', id, 'lower')?.frame,
      ),
    ).toEqual(['stallAClosed', 'stallBClosed', 'stallCClosed', 'stallAClosed', 'stallBClosed'])
  })

  it('uses construction A when a stall id has no numeric suffix', () => {
    expect(stallVariantIndex('market-stall')).toBe(0)
    expect(propRoleTreatment('stall', 'closed', 'market-stall', 'lower')?.frame).toBe(
      'stallAClosed',
    )
  })

  it('keeps stall construction independent from its recorded state', () => {
    expect(propRoleTreatment('stall', 'closed', 'stall_2', 'lower')?.frame).toBe('stallCClosed')
    expect(propRoleTreatment('stall', 'open', 'stall_2', 'lower')?.frame).toBe('stallCOpen')
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
