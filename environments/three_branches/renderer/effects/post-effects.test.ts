import { describe, expect, it } from 'vitest'

import { HEARTHSIDE_STYLE } from '../core/presentation.js'
import type { FrameScene } from '../core/types.js'
import { RULES } from '../ui/overlay.js'
import {
  type DayLight,
  dayLightAt,
  gradeMatrix,
  hasAmbientTransition,
  isIdentityMatrix,
} from './post-effects.js'

const midpoint = (name: string): number => {
  const phase = RULES.phases.find((item) => item.name === name)
  if (phase === undefined) throw new Error(`Unknown phase ${name}`)
  return (phase.start + phase.end) / 2
}

/** How bright mid grey looks after the grade, averaged over the three channels. */
const greyLevel = (light: DayLight): number => {
  const matrix = gradeMatrix(light)
  let total = 0
  for (const row of [0, 1, 2]) {
    const base = row * 5
    total += 0.5 * ((matrix[base] ?? 0) + (matrix[base + 1] ?? 0) + (matrix[base + 2] ?? 0))
    total += matrix[base + 4] ?? 0
  }
  return total / 3
}

describe('Three Branches day light', () => {
  it('holds each phase keyframe at its midpoint tick', () => {
    for (const phase of RULES.phases) {
      const keyframe = HEARTHSIDE_STYLE.postEffects.dayCycle[phase.name]
      const light = dayLightAt(phase.name, midpoint(phase.name))
      expect(light.exposure).toBeCloseTo(keyframe?.exposure ?? Number.NaN)
      expect(light.glow).toBeCloseTo(keyframe?.glow ?? Number.NaN)
      expect(light.cranes).toBeCloseTo(keyframe?.cranes ?? Number.NaN)
    }
  })

  it('blends continuously across a phase boundary', () => {
    const before = dayLightAt('evening', 960)
    const after = dayLightAt('night', 961)
    expect(Math.abs(before.exposure - after.exposure)).toBeLessThan(0.01)
    expect(Math.abs(before.glow - after.glow)).toBeLessThan(0.01)
    expect(Math.abs(before.vignette - after.vignette)).toBeLessThan(0.01)
  })

  it('depends only on the presented tick, including fractional glide ticks', () => {
    expect(dayLightAt('night', 1000.25)).toEqual(dayLightAt('night', 1000.25))
    const early = dayLightAt('evening', 900)
    const middle = dayLightAt('evening', 900.5)
    const late = dayLightAt('evening', 901)
    expect(middle.exposure).toBeLessThan(early.exposure)
    expect(middle.exposure).toBeGreaterThan(late.exposure)
  })

  it('darkens from midday through evening into night', () => {
    const midday = greyLevel(dayLightAt('midday', midpoint('midday')))
    const evening = greyLevel(dayLightAt('evening', midpoint('evening')))
    const night = greyLevel(dayLightAt('night', midpoint('night')))
    expect(evening).toBeLessThan(midday)
    expect(night).toBeLessThan(evening)
  })

  it('renders the off phase and the tickless opening as an ungraded midday', () => {
    const midday = dayLightAt('midday', midpoint('midday'))
    expect(dayLightAt(RULES.off_phase, 1100)).toEqual(midday)
    expect(dayLightAt(null, 0)).toEqual(midday)
    expect(isIdentityMatrix(gradeMatrix(midday))).toBe(true)
    expect(isIdentityMatrix(gradeMatrix(dayLightAt('night', 1100)))).toBe(false)
  })

  it('leaves alpha untouched so transparent apertures survive the grade', () => {
    const matrix = gradeMatrix(dayLightAt('night', 1100))
    expect(matrix.slice(15)).toEqual([0, 0, 0, 1, 0])
    for (const row of [0, 1, 2]) expect(matrix[row * 5 + 3]).toBe(0)
  })

  it('glides a tick change while clouds or cranes are in the sky, and rests at night', () => {
    const at = (phase: string, tick: number): FrameScene =>
      ({ dynamic: { phase }, presentationTick: tick }) as unknown as FrameScene
    expect(hasAmbientTransition(at('morning', 300), at('morning', 301))).toBe(true)
    expect(hasAmbientTransition(at('morning', 300), at('morning', 300))).toBe(false)
    expect(hasAmbientTransition(at(RULES.off_phase, 300), at(RULES.off_phase, 301))).toBe(true)
    expect(hasAmbientTransition(at('night', 1100), at('night', 1101))).toBe(false)
  })
})
