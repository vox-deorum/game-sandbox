import { describe, expect, it } from 'vitest'

import { HEARTHSIDE_STYLE } from '../core/presentation.js'
import { bellStrikerRotation, emissiveSpec, pingPongOpacity, propEffectSpec } from './effects.js'

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
    expect(effect.opacityAnimation).toEqual({
      mode: 'pingPong',
      min: 0.45,
      max: 1,
      periodTicks: 10,
    })
    const animation = effect.opacityAnimation
    if (animation === undefined) throw new Error('Shrine opacity animation is missing.')
    const initial = requiredPropEffect('shrine', 'tended', 'shrine:one', 0)
    const troughTick = (1 - initial.phase / 0xffffffff) * animation.periodTicks
    const trough = requiredPropEffect('shrine', 'tended', 'shrine:one', troughTick)
    const peak = requiredPropEffect(
      'shrine',
      'tended',
      'shrine:one',
      troughTick + animation.periodTicks / 2,
    )

    expect(trough).toMatchObject({
      alpha: 0.45,
      scale: 2,
      offsetX: 0,
      offsetY: 0,
      rotation: 0,
    })
    expect(peak.alpha).toBeCloseTo(1)
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

  it('uses the authored ripple and sound-line frames for the simplified landmarks', () => {
    expect(requiredPropEffect('pump', 'flowing', 'pump:one', 3).frame).toBe('waterRipple')
    expect(requiredPropEffect('bell', 'ringing', 'bell:one', 3).frame).toMatch(
      /^bellLines[A-F]$/,
    )
  })

  it('moves the well ripple in a slow, subpixel ellipse instead of shaking it', () => {
    expect(HEARTHSIDE_STYLE.propEffects.pump?.frameRate).toBe(0.15)
    const initial = requiredPropEffect('pump', 'flowing', 'pump:one', 0)
    const tick = 2.5
    const moved = requiredPropEffect('pump', 'flowing', 'pump:one', tick)
    const angle = (tick * 0.15 + initial.phase / 0xffffffff) * Math.PI * 2

    expect(Math.abs(initial.offsetX)).toBeLessThanOrEqual(0.3)
    expect(Math.abs(initial.offsetY)).toBeLessThanOrEqual(0.18)
    expect(moved.offsetX).toBeCloseTo(Math.cos(angle) * 0.3)
    expect(moved.offsetY).toBeCloseTo(Math.sin(angle) * 0.18)
    expect(initial.scale).toBeGreaterThanOrEqual(0.5445)
    expect(initial.scale).toBeLessThanOrEqual(0.5555)
    expect(moved.scale).toBeCloseTo(0.55 + Math.sin(angle) * 0.0055)
  })

  it('keeps the bell striker still when silent and seek-safe while ringing', () => {
    expect(bellStrikerRotation('silent', 'bell:one', 2)).toBe(0)
    const first = bellStrikerRotation('ringing', 'bell:one', 2)
    expect(first).toBeGreaterThanOrEqual(-0.14)
    expect(first).toBeLessThanOrEqual(0.14)
    expect(bellStrikerRotation('ringing', 'bell:one', 3)).not.toBeCloseTo(first)
    expect(bellStrikerRotation('ringing', 'bell:one', 10)).toBeCloseTo(first)
  })

  it('crossfades overlapping lantern glow frames with a constant opacity envelope', () => {
    const initial = requiredPropEffect('lantern', 'lit', 'lantern:one', 0)
    const initialClock = (initial.phase / 0xffffffff) * 6
    const tick = ((Math.floor(initialClock) + 0.25 - initialClock + 1) % 1) / 0.5
    const effect = requiredPropEffect('lantern', 'lit', 'lantern:one', tick)
    expect(effect.nextFrame).toBeDefined()
    expect(effect.blend).toBeCloseTo(0.15625)
    expect(effect.offsetY).toBe(-2.6)
    const overlap = effect.alpha * (1 - (effect.blend ?? 0)) + effect.alpha * (effect.blend ?? 0)
    expect(overlap).toBeCloseTo(effect.alpha)
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
