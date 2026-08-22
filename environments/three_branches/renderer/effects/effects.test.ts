import { describe, expect, it } from 'vitest'

import { HEARTHSIDE_STYLE } from '../core/presentation.js'
import { bellSwingRotation, emissiveSpec, pingPongOpacity, propEffectSpec } from './effects.js'

describe('Three Branches prop effects', () => {
  it('carries a stable id phase', () => {
    const first = propEffectSpec('lantern', 'lit', 'lantern:one', 12.25)
    expect(propEffectSpec('lantern', 'lit', 'lantern:two', 12.25)?.phase).not.toBe(first?.phase)
  })

  it('changes with fractional presentation tick', () => {
    expect(propEffectSpec('hearth', 'lit', 'hearth:one', 3.1)).not.toEqual(
      propEffectSpec('hearth', 'lit', 'hearth:one', 3.4),
    )
  })

  it('moves configured opacity through one complete ping-pong cycle', () => {
    const animation = { mode: 'pingPong' as const, min: 0, max: 1, periodTicks: 8 }
    expect(pingPongOpacity(animation, 0, 0)).toBe(0)
    expect(pingPongOpacity(animation, 2, 0)).toBe(0.5)
    expect(pingPongOpacity(animation, 4, 0)).toBe(1)
    expect(pingPongOpacity(animation, 6, 0)).toBe(0.5)
    expect(pingPongOpacity(animation, 8, 0)).toBe(0)
  })

  it('applies a configured opacity animation after the effect-specific behavior', () => {
    const effect = HEARTHSIDE_STYLE.propEffects.shrine
    if (effect === undefined) throw new Error('Shrine effect treatment is missing.')
    const previous = effect.opacityAnimation
    effect.opacityAnimation = { mode: 'pingPong', min: 0, max: 1, periodTicks: 8 }

    try {
      const initial = requiredPropEffect('shrine', 'tended', 'shrine:one', 0)
      const troughTick = (1 - initial.phase / 0xffffffff) * 8
      const trough = requiredPropEffect('shrine', 'tended', 'shrine:one', troughTick)
      const peak = requiredPropEffect('shrine', 'tended', 'shrine:one', troughTick + 4)

      delete effect.opacityAnimation
      const unmodulatedPeak = requiredPropEffect('shrine', 'tended', 'shrine:one', troughTick + 4)

      expect(trough.alpha).toBeCloseTo(0)
      expect(peak.alpha).toBeCloseTo(1)
      expect(unmodulatedPeak).toMatchObject({
        alpha: 1,
        scale: 1.6,
        offsetX: 0,
        offsetY: 0,
        rotation: 0,
      })
      expect(peak).toMatchObject({
        frame: unmodulatedPeak.frame,
        tint: unmodulatedPeak.tint,
        scale: unmodulatedPeak.scale,
        offsetX: unmodulatedPeak.offsetX,
        offsetY: unmodulatedPeak.offsetY,
        rotation: unmodulatedPeak.rotation,
        phase: unmodulatedPeak.phase,
      })
    } finally {
      if (previous === undefined) delete effect.opacityAnimation
      else effect.opacityAnimation = previous
    }
  })

  it('keeps the silent bell stationary and swings ringing bells deterministically', () => {
    expect(bellSwingRotation('silent', 'bell:one', 3.1)).toBe(0)
    expect(bellSwingRotation('ringing', 'bell:one', 3.1)).toBe(
      bellSwingRotation('ringing', 'bell:one', 3.1),
    )
    expect(bellSwingRotation('ringing', 'bell:one', 3.1)).not.toBe(
      bellSwingRotation('ringing', 'bell:two', 3.1),
    )
    expect(bellSwingRotation('ringing', 'bell:one', 3.1)).not.toBe(
      bellSwingRotation('ringing', 'bell:one', 3.35),
    )
    expect(Math.abs(bellSwingRotation('ringing', 'bell:one', 3.1))).toBeLessThanOrEqual(0.18)
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

function requiredPropEffect(
  type: string,
  state: string,
  propId: string,
  fractionalTick: number,
): NonNullable<ReturnType<typeof propEffectSpec>> {
  const effect = propEffectSpec(type, state, propId, fractionalTick)
  if (effect === null) throw new Error(`${type} ${state} effect is missing.`)
  return effect
}
