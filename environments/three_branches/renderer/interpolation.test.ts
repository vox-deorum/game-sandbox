import { describe, expect, it } from 'vitest'

import {
  interpolateDynamicOverlay,
  interpolationProgress,
  smoothedArrivalMs,
  transitionDurationFor,
  transitionDurationMs,
} from './interpolation.js'
import { decodeDynamic } from './overlay.js'
import { states, staticOverlay } from './test-helpers.js'

describe('Three Branches playback interpolation', () => {
  const from = decodeDynamic(states[0], staticOverlay)
  const to = decodeDynamic(states[1], staticOverlay)

  it('uses exact endpoints and a smooth deterministic midpoint', () => {
    expect(interpolationProgress(0, 1_000)).toBe(0)
    expect(interpolationProgress(250, 1_000)).toBe(0.25)
    expect(interpolationProgress(500, 1_000)).toBe(0.5)
    expect(interpolationProgress(1_000, 1_000)).toBe(1)
    expect(interpolateDynamicOverlay(from, to, 0)).toBe(from)
    expect(interpolateDynamicOverlay(from, to, 1)).toBe(to)

    const midpoint = interpolateDynamicOverlay(from, to, 0.5)
    const before = from.characters[0]
    const after = to.characters[0]
    const character = midpoint.characters[0]
    if (before === undefined || after === undefined || character === undefined) {
      throw new Error('fixture has no interpolation character')
    }
    expect(character.position.x).toBeCloseTo((before.position.x + after.position.x) / 2)
    expect(character.position.y).toBeCloseTo((before.position.y + after.position.y) / 2)
    expect(midpoint.tick).toBeCloseTo((from.tick + to.tick) / 2)
  })

  it('keeps equal velocity through three consecutive frames at a tick boundary', () => {
    const middle = structuredClone(from)
    const end = structuredClone(from)
    const startCharacter = from.characters[0]
    const middleCharacter = middle.characters[0]
    const endCharacter = end.characters[0]
    if (
      startCharacter === undefined ||
      middleCharacter === undefined ||
      endCharacter === undefined
    ) {
      throw new Error('fixture has no interpolation character')
    }
    middleCharacter.position.x = startCharacter.position.x + 1
    endCharacter.position.x = startCharacter.position.x + 2
    const positions = [
      interpolateDynamicOverlay(from, middle, interpolationProgress(750, 1_000)),
      interpolateDynamicOverlay(from, middle, interpolationProgress(1_000, 1_000)),
      interpolateDynamicOverlay(middle, end, interpolationProgress(250, 1_000)),
    ].map((frame) => frame.characters[0]?.position.x ?? 0)
    const [beforeBoundary, atBoundary, afterBoundary] = positions
    if (beforeBoundary === undefined || atBoundary === undefined || afterBoundary === undefined) {
      throw new Error('three interpolation frames are required')
    }

    expect(atBoundary - beforeBoundary).toBeCloseTo(0.25)
    expect(afterBoundary - atBoundary).toBeCloseTo(0.25)
  })

  it('scales the one-second natural transition to the host cadence', () => {
    expect(transitionDurationMs(1)).toBe(1_000)
    expect(transitionDurationMs(0.25)).toBe(250)
  })

  it('falls back to the measured arrival gap when the host declares no cadence', () => {
    expect(transitionDurationFor(0.25, 250)).toBe(250)
    expect(transitionDurationFor(0, 250)).toBe(0)
    expect(transitionDurationFor(undefined, null)).toBe(1_000)
    expect(transitionDurationFor(undefined, 250)).toBe(250)
    // A stall resumes at walking pace rather than crawling through a minute-long transition.
    expect(transitionDurationFor(undefined, 60_000)).toBe(1_000)
  })

  it('smooths arrival jitter instead of tracking every gap exactly', () => {
    expect(smoothedArrivalMs(null, 250)).toBe(250)
    const jittered = smoothedArrivalMs(smoothedArrivalMs(250, 400), 100)
    expect(jittered).toBeGreaterThan(100)
    expect(jittered).toBeLessThan(400)
  })

  it('takes the shortest continuous route across the heading wrap', () => {
    const wrappedFrom = structuredClone(from)
    const wrappedTo = structuredClone(to)
    const before = wrappedFrom.characters[0]
    const after = wrappedTo.characters[0]
    if (before === undefined || after === undefined) throw new Error('fixture has no character')
    before.heading = 350
    after.heading = 10
    expect(interpolateDynamicOverlay(wrappedFrom, wrappedTo, 0.5).characters[0]?.heading).toBe(0)
  })
})
