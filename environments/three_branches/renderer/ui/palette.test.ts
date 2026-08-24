import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'
import { HEARTHSIDE_STYLE, THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import { testText } from '../core/test-helpers.js'
import { createExpressionArt } from './annotations.js'
import { EMOTE_TOKENS } from './input.js'
import {
  createExpressionPalette,
  EMOTE_PLATES,
  paletteHit,
  plateProbe,
  USE_PLATE_RECT,
} from './palette.js'

function center(rect: { x: number; y: number; width: number; height: number }) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

const ALL_RECTS = [...EMOTE_PLATES.map((plate) => plate.rect), USE_PLATE_RECT]

/** The retained panel and label of the Use plate, the last plate built into the layer. */
function usePlate(layer: Container): { panel: Graphics; label: Text } {
  const panels = layer.children.filter((child): child is Graphics => child instanceof Graphics)
  const labels = layer.children.filter((child): child is Text => child instanceof Text)
  const label = labels.find((node) => node.text === 'Use')
  if (label === undefined) throw new Error('the palette should label the use plate.')
  const panel = panels.at(-1)
  if (panel === undefined) throw new Error('the palette should paint the use plate.')
  return { panel, label }
}

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
      // The palette stays well clear of the fixed bottom-left joystick.
      expect(rect.x).toBeGreaterThanOrEqual(size.width * 0.4)
      expect(rect.width).toBe(HEARTHSIDE_STYLE.expressions.inputPalette.plateWidth)
      expect(rect.height).toBe(HEARTHSIDE_STYLE.expressions.inputPalette.plateHeight)
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
    expect(waveLabel.anchor.y).toBe(0.5)
    expect(labels.some((label) => label.text === 'Shake')).toBe(true)
    expect(labels.some((label) => label.text === 'Shake Head')).toBe(false)
    expect(labels.some((label) => label.text === 'Use')).toBe(true)
    expect(labels.some((label) => label.text === '0')).toBe(true)
    expect(
      labels
        .filter((label) => !/^\d$/.test(label.text))
        .every(
          (label) =>
            label.style.fontSize === HEARTHSIDE_STYLE.expressions.inputPalette.labelFontSize,
        ),
    ).toBe(true)

    palette.update('wave', false, false, false, 2)
    expect(waveLabel.style.fill).toBe(HEARTHSIDE_STYLE.palette.ink)
    expect(waveLabel.resolution).toBe(2)
    palette.update(null, false, true, false, 1)
    expect(waveLabel.style.fill).toBe(HEARTHSIDE_STYLE.palette.bone)

    palette.setVisible(false)
    expect(layer.visible).toBe(false)
    palette.setVisible(true)
    expect(layer.visible).toBe(true)
  })

  it('installs an icon for every emote and keeps Use on the generic fallback', () => {
    const layer = new Container()
    const palette = createExpressionPalette(layer, testText)
    palette.install(createExpressionArt(Texture.WHITE))
    const icons = layer.children.filter((child): child is Sprite => child instanceof Sprite)
    expect(icons).toHaveLength(10)
    expect(icons.every((icon) => icon.visible)).toBe(true)
    palette.setUseIcon('missing_activity')
    expect(icons.at(-1)?.visible).toBe(true)
  })

  it('starts every icon and label at the configured positions', () => {
    const layer = new Container()
    const palette = createExpressionPalette(layer, testText)
    palette.install(createExpressionArt(Texture.WHITE))
    const layout = HEARTHSIDE_STYLE.expressions.inputPalette
    const rects = [...EMOTE_PLATES.map((plate) => plate.rect), USE_PLATE_RECT]
    const icons = layer.children.filter((child): child is Sprite => child instanceof Sprite)
    const labels = layer.children.filter(
      (child): child is Text => child instanceof Text && !/^\d$/.test(child.text),
    )
    expect(icons).toHaveLength(rects.length)
    expect(labels).toHaveLength(rects.length)
    for (const [index, rect] of rects.entries()) {
      const icon = icons[index]
      const label = labels[index]
      if (icon === undefined || label === undefined) {
        throw new Error('each palette plate should carry an icon and label.')
      }
      expect(icon.x - layout.iconContentWidth / 2).toBe(rect.x + layout.iconStartX)
      expect(label.x).toBe(
        rect.x + layout.iconStartX + layout.iconContentWidth + layout.iconLabelGap,
      )
      expect(icon.y).toBe(rect.y + rect.height / 2)
      expect(label.y).toBe(rect.y + rect.height / 2)
    }
  })

  it('paints the Use plate gilt while latched and dims it while disabled', () => {
    const layer = new Container()
    const palette = createExpressionPalette(layer, testText)
    const { panel, label } = usePlate(layer)

    palette.update(null, false, false, false, 1)
    expect(panel.alpha).toBe(1)
    expect(label.style.fill).toBe(HEARTHSIDE_STYLE.palette.bone)

    palette.update(null, true, false, false, 1)
    expect(panel.alpha).toBe(1)
    expect(label.style.fill).toBe(HEARTHSIDE_STYLE.palette.ink)

    palette.update('use', false, false, false, 1)
    expect(panel.alpha).toBe(1)
    expect(label.style.fill).toBe(HEARTHSIDE_STYLE.palette.ink)
  })

  it('dims the Use plate while disabled, even when latched or hovered', () => {
    const layer = new Container()
    const palette = createExpressionPalette(layer, testText)
    const { panel, label } = usePlate(layer)

    palette.update(null, false, false, true, 1)
    expect(panel.alpha).toBeLessThan(1)
    expect(label.alpha).toBeLessThan(1)

    palette.update(null, true, true, true, 1)
    expect(panel.alpha).toBeLessThan(1)
    expect(label.alpha).toBeLessThan(1)
  })
})
