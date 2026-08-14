import { describe, expect, it } from 'vitest'

import {
  type FrameTreatment,
  HEARTHSIDE_PALETTE_KEYS,
  HEARTHSIDE_STYLE,
  WATER_BANK_CARDINAL_FRAMES,
  measureDeliveryGap,
  type PhaseGrade,
  phaseGrade,
  readHearthsideStyle,
  transitionDurationMs,
} from './presentation.js'

const APPROVED_PALETTE = {
  backdrop: '#101816',
  parchment: '#cfc5a9',
  bone: '#efe7d3',
  ink: '#6f6757',
  reed: '#a9ae8a',
  silt: '#bfa072',
  water: '#5a7680',
  pine: '#4f6a4b',
  indigo: '#27436b',
  cinnabar: '#b0402e',
  gilt: '#d9a441',
  violet: '#6b5d72',
  timber: '#8a6246',
} as const

describe('Hearthside Ink presentation', () => {
  it('exports exactly the thirteen approved palette colors', () => {
    expect(HEARTHSIDE_PALETTE_KEYS).toHaveLength(13)
    expect(HEARTHSIDE_STYLE.palette).toEqual(APPROVED_PALETTE)
  })

  it('keeps day neutral and configures every graded rules phase', () => {
    expect(Object.keys(HEARTHSIDE_STYLE.phaseGrades)).toEqual([
      'dawn',
      'morning',
      'midday',
      'evening',
      'night',
    ])
    expect(phaseGrade('day')).toBeNull()
    expect(phaseGrade('midday')).toBe(HEARTHSIDE_STYLE.phaseGrades.midday)
  })

  it('uses explicit host pace and caps unpaced delivery gaps at the natural duration', () => {
    expect(transitionDurationMs({ snap: true }, 400)).toBe(0)
    expect(transitionDurationMs({ transitionScale: 0 }, 400)).toBe(0)
    expect(transitionDurationMs({ transitionScale: 0.5 }, 900)).toBe(500)
    expect(transitionDurationMs(undefined, 240)).toBe(240)
    expect(transitionDurationMs(undefined, 1_400)).toBe(1_000)
    expect(transitionDurationMs()).toBe(1_000)
    expect(transitionDurationMs(undefined, Number.NaN)).toBe(1_000)
  })

  it('measures consecutive unpaced deliveries and resets the clock on snaps and pacing', () => {
    expect(measureDeliveryGap(null, 100)).toEqual({ gapMs: undefined, nextMs: 100 })
    expect(measureDeliveryGap(100, 340)).toEqual({ gapMs: 240, nextMs: 340 })
    expect(measureDeliveryGap(340, 500, { snap: true })).toEqual({
      gapMs: undefined,
      nextMs: null,
    })
    expect(measureDeliveryGap(null, 700)).toEqual({ gapMs: undefined, nextMs: 700 })
    expect(measureDeliveryGap(700, 900, { transitionScale: 0.5 })).toEqual({
      gapMs: undefined,
      nextMs: null,
    })
  })

  it('validates the explicit water-bank corner order and accents against terrain frames', () => {
    const waterBank = HEARTHSIDE_STYLE.terrain.edges.pairings[0]
    expect(waterBank?.corners).toEqual({
      northEast: ['cornerA', 'cornerB'],
      southEast: ['cornerC', 'cornerD'],
      southWest: ['cornerE', 'cornerF'],
      northWest: ['cornerG', 'cornerH'],
    })
    expect(waterBank?.frames).toEqual(WATER_BANK_CARDINAL_FRAMES)
    expect(waterBank?.accents).toEqual(['bankShoulder', 'bankStones'])

    const badCorner = structuredClone(HEARTHSIDE_STYLE)
    const cornerPairing = badCorner.terrain.edges.pairings[0] as unknown as {
      corners: Record<string, string[]>
    }
    cornerPairing.corners.northEast = ['cornerA']
    expect(() => readHearthsideStyle(badCorner)).toThrow('northEast must contain exactly two frames')

    const badAccent = structuredClone(HEARTHSIDE_STYLE)
    const accentPairing = badAccent.terrain.edges.pairings[0] as unknown as { accents: string[] }
    accentPairing.accents = ['missingFrame']
    expect(() => readHearthsideStyle(badAccent)).toThrow('accents[0] is unknown')
    const reordered = structuredClone(HEARTHSIDE_STYLE)
    const reorderedFrames = reordered.terrain.edges.pairings[0] as unknown as { frames: string[] }
    ;[reorderedFrames.frames[0], reorderedFrames.frames[1]] = [
      reorderedFrames.frames[1]!,
      reorderedFrames.frames[0]!,
    ]
    expect(() => readHearthsideStyle(reordered)).toThrow('water-bank cardinal order')

    const duplicate = structuredClone(HEARTHSIDE_STYLE)
    const duplicateFrames = duplicate.terrain.edges.pairings[0] as unknown as { frames: string[] }
    duplicateFrames.frames[1] = duplicateFrames.frames[0]!
    expect(() => readHearthsideStyle(duplicate)).toThrow('water-bank cardinal order')

    const shortened = structuredClone(HEARTHSIDE_STYLE)
    const shortenedFrames = shortened.terrain.edges.pairings[0] as unknown as { frames: string[] }
    shortenedFrames.frames.pop()
    expect(() => readHearthsideStyle(shortened)).toThrow('water-bank cardinal order')
    const badReedCorners = structuredClone(HEARTHSIDE_STYLE)
    const reedWithCorners = badReedCorners.terrain.edges.pairings[1] as unknown as Record<string, unknown>
    reedWithCorners.corners = {}
    expect(() => readHearthsideStyle(badReedCorners)).toThrow('pairings[1] keys do not match')

    const badReedAccents = structuredClone(HEARTHSIDE_STYLE)
    const reedWithAccents = badReedAccents.terrain.edges.pairings[1] as unknown as Record<string, unknown>
    reedWithAccents.accents = ['bankShoulder']
    expect(() => readHearthsideStyle(badReedAccents)).toThrow('pairings[1] keys do not match')
  })
  it('rejects unknown manifest frames, palette tints, and phase keys', () => {
    const badFrame = structuredClone(HEARTHSIDE_STYLE)
    const fills = badFrame.terrain.fills as Record<string, FrameTreatment>
    fills.ground = { frames: ['missingFrame'], tint: 'reed' }
    expect(() => readHearthsideStyle(badFrame)).toThrow('frames[0] is unknown')

    const badTint = structuredClone(HEARTHSIDE_STYLE)
    const tintFills = badTint.terrain.fills as Record<string, { frames: string[]; tint: string }>
    tintFills.ground = { frames: ['washA'], tint: 'orange' }
    expect(() => readHearthsideStyle(badTint)).toThrow('tint is unknown')

    const badPhases = structuredClone(HEARTHSIDE_STYLE)
    const grades = badPhases.phaseGrades as Record<string, PhaseGrade>
    grades.day = grades.midday as PhaseGrade
    expect(() => readHearthsideStyle(badPhases)).toThrow('phaseGrades keys')
  })
})
