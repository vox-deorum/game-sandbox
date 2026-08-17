import { describe, expect, it } from 'vitest'

import { HEARTHSIDE_STYLE } from '../core/presentation.js'
import { emissiveSpec, propEffectSpec } from './effects.js'

describe('Three Branches prop effects', () => {
  it('is pure for equal animation inputs and carries a stable id phase', () => {
    const first = propEffectSpec('lantern', 'lit', 'lantern:one', 12.25)
    expect(propEffectSpec('lantern', 'lit', 'lantern:one', 12.25)).toEqual(first)
    expect(propEffectSpec('lantern', 'lit', 'lantern:two', 12.25)?.phase).not.toBe(first?.phase)
  })

  it('changes with fractional presentation tick', () => {
    expect(propEffectSpec('hearth', 'lit', 'hearth:one', 3.1)).not.toEqual(
      propEffectSpec('hearth', 'lit', 'hearth:one', 3.4),
    )
  })

  it('animates only the five configured active states', () => {
    expect(propEffectSpec('lantern', 'unlit', 'lantern:one', 3)).toBeNull()
    expect(propEffectSpec('hearth', 'unlit', 'hearth:one', 3)).toBeNull()
    expect(propEffectSpec('shrine', 'untended', 'shrine:one', 3)).toBeNull()
    expect(propEffectSpec('pump', 'idle', 'pump:one', 3)).toBeNull()
    expect(propEffectSpec('bell', 'silent', 'bell:one', 3)).toBeNull()
    for (const [type, state] of [
      ['lantern', 'lit'],
      ['hearth', 'lit'],
      ['shrine', 'tended'],
      ['pump', 'flowing'],
      ['bell', 'ringing'],
    ] as const) {
      expect(propEffectSpec(type, state, `${type}:one`, 3)).not.toBeNull()
    }
  })

  it('emits post-grade light only for active lanterns and hearths, in the configured tints', () => {
    expect(emissiveSpec('lantern', 'lit')?.tint).toBe(HEARTHSIDE_STYLE.emissives.lantern)
    expect(emissiveSpec('hearth', 'lit')?.tint).toBe(HEARTHSIDE_STYLE.emissives.hearth)
    expect(emissiveSpec('lantern', 'unlit')).toBeNull()
    expect(emissiveSpec('shrine', 'tended')).toBeNull()
  })
})
