import { describe, expect, it } from 'vitest'

import { emissiveSpec, propEffectSpec } from './effects.js'

describe('Three Branches prop effects', () => {
  it('is pure for equal animation inputs and carries a stable id phase', () => {
    const first = propEffectSpec('lantern', 'lit', 'lantern:one', 12.25)
    expect(propEffectSpec('lantern', 'lit', 'lantern:one', 12.25)).toEqual(first)
    expect(propEffectSpec('lantern', 'lit', 'lantern:two', 12.25)?.phase).not.toBe(first?.phase)
  })

  it('changes with fractional presentation tick and uses the configured palette tints', () => {
    const active = [
      ['lantern', 'lit', 'gilt'],
      ['hearth', 'lit', 'cinnabar'],
      ['shrine', 'tended', 'violet'],
      ['pump', 'flowing', 'water'],
      ['bell', 'ringing', 'gilt'],
    ] as const
    for (const [type, state, tint] of active)
      expect(propEffectSpec(type, state, type + ':one', 3)?.tint).toBe(tint)
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

  it('emits post-grade light only for active lanterns and hearths', () => {
    expect(emissiveSpec('lantern', 'lit')).toMatchObject({ tint: 'gilt' })
    expect(emissiveSpec('hearth', 'lit')).toMatchObject({ tint: 'cinnabar' })
    expect(emissiveSpec('lantern', 'unlit')).toBeNull()
    expect(emissiveSpec('shrine', 'tended')).toBeNull()
  })
})
