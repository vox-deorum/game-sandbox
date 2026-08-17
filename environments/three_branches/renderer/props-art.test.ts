import { describe, expect, it } from 'vitest'

import { CATALOG } from './overlay.js'
import { EFFECTS_ATLAS_FRAME_NAMES, MONUMENTS_ATLAS_FRAME_NAMES, PROPS_ATLAS_FRAME_NAMES } from './assets.js'
import { HEARTHSIDE_STYLE, propMonumentTreatment } from './presentation.js'
import { propFoundationFrame, propTreatment, sceneryFrame } from './props-art.js'

function camelType(token: string): string {
  return token.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

describe('Three Branches prop art treatments', () => {
  it('resolves every catalog state to a readable frame named after its type and state', () => {
    for (const prop of CATALOG.props) {
      for (const state of prop.states) {
        const treatment = propTreatment(prop.token, state)
        expect(treatment.frame).toBe(`${camelType(prop.token)}${state[0]?.toUpperCase()}${state.slice(1)}`)
      }
    }
  })

  it('keeps every treatment, foundation, and configured effect frame in its atlas manifest', () => {
    for (const prop of CATALOG.props) {
      const frames =
        propMonumentTreatment(prop.token) !== null ? MONUMENTS_ATLAS_FRAME_NAMES : PROPS_ATLAS_FRAME_NAMES
      for (const state of prop.states) {
        expect(frames).toContain(propTreatment(prop.token, state).frame)
      }
      const foundation = propFoundationFrame(prop.token)
      if (foundation !== null) expect(frames).toContain(foundation)
    }
    Object.values(HEARTHSIDE_STYLE.propEffects)
      .flatMap((effect) => effect.frames)
      .forEach((frame) => expect(EFFECTS_ATLAS_FRAME_NAMES).toContain(frame))
    expect(EFFECTS_ATLAS_FRAME_NAMES).toContain(HEARTHSIDE_STYLE.emissives.frame)
  })

  it('gives every state of a prop type its own frame', () => {
    for (const prop of CATALOG.props) {
      const frames = prop.states.map((state) => propTreatment(prop.token, state).frame)
      expect(new Set(frames).size).toBe(frames.length)
    }
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