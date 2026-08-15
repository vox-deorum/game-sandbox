import { Container, Text } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import { EMOTE_TOKENS } from './input.js'
import {
  createExpressionPalette,
  EMOTE_PLATES,
  paletteHit,
  plateProbe,
  USE_PLATE_RECT,
} from './palette.js'
import { HEARTHSIDE_STYLE, THREE_BRANCHES_PRESENTATION } from './presentation.js'
import { testText } from './test-helpers.js'

function center(rect: { x: number; y: number; width: number; height: number }) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

const ALL_RECTS = [...EMOTE_PLATES.map((plate) => plate.rect), USE_PLATE_RECT]

describe('Three Branches expression palette', () => {
  it('lays out the nine emotes in ruleset order with hotkeys 1 through 9', () => {
    expect(EMOTE_PLATES.map((plate) => plate.token)).toEqual([...EMOTE_TOKENS])
    expect(EMOTE_PLATES.map((plate) => plate.hotkey)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ])
  })

  it('sits in the lower right of the content area, clear of the joystick half', () => {
    const size = THREE_BRANCHES_PRESENTATION.internalSize
    for (const rect of ALL_RECTS) {
      expect(rect.y).toBeGreaterThan(THREE_BRANCHES_PRESENTATION.chromeHeight)
      expect(rect.y + rect.height).toBeLessThanOrEqual(size.height)
      expect(rect.x + rect.width).toBeLessThanOrEqual(size.width)
      // The palette stays in the right half, well clear of the fixed bottom-left joystick.
      expect(rect.x).toBeGreaterThanOrEqual(size.width / 2)
      expect(rect.width).toBe(136)
      expect(rect.height).toBe(52)
    }
  })

  it('keeps the plates from overlapping, with Use beside the grid', () => {
    for (const [index, first] of ALL_RECTS.entries()) {
      for (const second of ALL_RECTS.slice(index + 1)) {
        const separated =
          first.x + first.width <= second.x ||
          second.x + second.width <= first.x ||
          first.y + first.height <= second.y ||
          second.y + second.height <= first.y
        expect(separated).toBe(true)
      }
    }
    const gridLeft = Math.min(...EMOTE_PLATES.map((plate) => plate.rect.x))
    expect(USE_PLATE_RECT.x + USE_PLATE_RECT.width).toBeLessThan(gridLeft)
  })

  it('answers presses through the same rectangles the probes publish', () => {
    for (const plate of EMOTE_PLATES) {
      expect(paletteHit(center(plate.rect))).toBe(plate.token)
    }
    expect(paletteHit(center(USE_PLATE_RECT))).toBe('use')
    expect(paletteHit({ x: 10, y: 500 })).toBeNull()
    const first = EMOTE_PLATES[0]
    if (first === undefined) throw new Error('the palette should have a first plate.')
    // The gap between the first two columns belongs to nobody.
    expect(
      paletteHit({ x: first.rect.x + first.rect.width + 5, y: center(first.rect).y }),
    ).toBeNull()
  })

  it('formats a plate rectangle the way the chrome probes do', () => {
    expect(plateProbe({ x: 1, y: 2, width: 3, height: 4 })).toBe('1,2,3,4')
  })

  it('builds the retained plates and marks the queued one', () => {
    const layer = new Container()
    const palette = createExpressionPalette(layer, testText)
    const labels = layer.children.filter((child): child is Text => child instanceof Text)
    // Each of the ten plates carries a label and a hotkey digit.
    expect(labels).toHaveLength(20)
    const waveLabel = labels.find((label) => label.text === 'Wave')
    if (waveLabel === undefined) throw new Error('the palette should label the wave plate.')
    expect(labels.some((label) => label.text === 'Shake Head')).toBe(true)
    expect(labels.some((label) => label.text === 'Use')).toBe(true)
    expect(labels.some((label) => label.text === '0')).toBe(true)
    expect(
      labels
        .filter((label) => !/^\d$/.test(label.text))
        .every((label) => label.style.fontSize === 20),
    ).toBe(true)

    palette.update('wave', false, 2)
    expect(waveLabel.style.fill).toBe(HEARTHSIDE_STYLE.palette.ink)
    expect(waveLabel.resolution).toBe(2)
    palette.update(null, true, 1)
    expect(waveLabel.style.fill).toBe(HEARTHSIDE_STYLE.palette.bone)

    palette.setVisible(false)
    expect(layer.visible).toBe(false)
    palette.setVisible(true)
    expect(layer.visible).toBe(true)
  })
})
