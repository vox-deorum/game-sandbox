import { describe, expect, it } from 'vitest'

import { CATALOG } from './overlay.js'
import { PROPS_ATLAS_FRAME_NAMES, EFFECTS_ATLAS_FRAME_NAMES } from './assets.js'
import { HEARTHSIDE_STYLE } from './presentation.js'
import { propTreatment, sceneryFrame } from './props-art.js'

describe('Three Branches prop art treatments', () => {
  it('resolves every catalog state to a permanent base and readable state treatment', () => {
    for (const prop of CATALOG.props) {
      for (const state of prop.states) {
        const treatment = propTreatment(prop.token, state)
        expect(treatment.base).toBe(`${prop.token === 'repair_bench' ? 'repairBench' : prop.token}Base`)
        expect(treatment.still !== null || treatment.overlays.length > 0).toBe(true)
      }
    }
  })

  it('keeps every treatment and configured effect frame in its atlas manifest', () => {
    for (const prop of CATALOG.props) for (const state of prop.states) {
      const treatment = propTreatment(prop.token, state)
      expect(PROPS_ATLAS_FRAME_NAMES).toContain(treatment.base)
      if (treatment.still !== null) expect(PROPS_ATLAS_FRAME_NAMES).toContain(treatment.still)
      treatment.overlays.forEach((frame) => expect(PROPS_ATLAS_FRAME_NAMES).toContain(frame))
    }
    Object.values(HEARTHSIDE_STYLE.propEffects).flat().forEach((frame) => expect(EFFECTS_ATLAS_FRAME_NAMES).toContain(frame))
    expect(EFFECTS_ATLAS_FRAME_NAMES).toContain(HEARTHSIDE_STYLE.emissives.frame)
  })

  it('includes the authored auxiliary frames with their state treatments', () => {
    expect(propTreatment('stall', 'open').overlays).toContain('stallGoods')
    expect(propTreatment('stall', 'closed').overlays).toContain('stallShutter')
    expect(propTreatment('bench', 'occupied').overlays).toContain('benchCushion')
    expect(propTreatment('shrine', 'tended').overlays).toContain('shrineOffering')
    expect(propTreatment('plot', 'tended').overlays).toContain('plotFence')
    expect(propTreatment('lantern', 'lit').overlays).toContain('lanternCore')
    expect(propTreatment('bell', 'ringing').overlays).toContain('bellClapper')
  })

  it('selects scenery variants from stable placement ids', () => {
    expect(sceneryFrame('pine', 'scenery:4')).toBe(sceneryFrame('pine', 'scenery:4'))
    expect(sceneryFrame('crate', 'scenery:4')).toBe('marketCrate')
  })

  it('fails clearly for unsupported catalog values', () => {
    expect(() => propTreatment('unknown', 'none')).toThrow(/type has no art treatment/)
    expect(() => propTreatment('lantern', 'unknown')).toThrow(/state has no art treatment/)
  })
})