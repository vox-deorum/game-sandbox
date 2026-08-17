/**
 * The visitor's expression palette: a 3 by 3 emote grid with a separate Use plate, drawn in the
 * chrome strip's Hearthside plate style and clicked in the browser's own coordinates through the
 * fixed rectangles below, exactly as the chrome controls are.
 */
import type { RendererTextFactory } from '@renderers/base/PixiRenderer.js'
import { type Container, Graphics, type Text } from 'pixi.js'
import {
  HEARTHSIDE_STYLE,
  HUD_FONT_SIZE,
  THREE_BRANCHES_PRESENTATION,
} from '../core/presentation.js'
import { titleFor } from '../map/scene.js'
import { EMOTE_TOKENS } from './input.js'

const PALETTE = HEARTHSIDE_STYLE.palette

type Rect = { x: number; y: number; width: number; height: number }

const PLATE_WIDTH = 136
const PLATE_HEIGHT = 52
const PLATE_GAP = 10
const CONTENT_MARGIN = 18

const GRID_WIDTH = 3 * PLATE_WIDTH + 2 * PLATE_GAP
const GRID_HEIGHT = 3 * PLATE_HEIGHT + 2 * PLATE_GAP
const GRID_X = THREE_BRANCHES_PRESENTATION.internalSize.width - CONTENT_MARGIN - GRID_WIDTH
const GRID_Y = THREE_BRANCHES_PRESENTATION.internalSize.height - CONTENT_MARGIN - GRID_HEIGHT

/** One emote plate: its ruleset token, its hotkey digit, and its fixed logical rectangle. */
export interface EmotePlate {
  token: string
  hotkey: string
  rect: Rect
}

/** The nine emote plates in ruleset order, hotkeys 1 through 9, lower right of the content area. */
export const EMOTE_PLATES: readonly EmotePlate[] = EMOTE_TOKENS.map((token, index) => ({
  token,
  hotkey: String(index + 1),
  rect: {
    x: GRID_X + (index % 3) * (PLATE_WIDTH + PLATE_GAP),
    y: GRID_Y + Math.floor(index / 3) * (PLATE_HEIGHT + PLATE_GAP),
    width: PLATE_WIDTH,
    height: PLATE_HEIGHT,
  },
}))

/** The separate Use plate beside the grid, hotkey 0, bottom-aligned with the last emote row. */
export const USE_PLATE_RECT: Rect = {
  x: GRID_X - PLATE_GAP - PLATE_WIDTH,
  y: GRID_Y + GRID_HEIGHT - PLATE_HEIGHT,
  width: PLATE_WIDTH,
  height: PLATE_HEIGHT,
}

/** The expression a view point presses: an emote token, 'use', or null outside every plate. */
export function paletteHit(view: { x: number; y: number }): string | null {
  for (const plate of EMOTE_PLATES) {
    if (within(view, plate.rect)) return plate.token
  }
  return within(view, USE_PLATE_RECT) ? 'use' : null
}

/** Format a plate rectangle for the browser probe, matching the chrome control probes. */
export function plateProbe(rect: Rect): string {
  return `${rect.x},${rect.y},${rect.width},${rect.height}`
}

/** Retained palette drawing, repainted toward the queued expression and the Use hover. */
export interface ExpressionPalette {
  /** Repaint the plates: the queued plate takes the gilt active treatment, a hovered Use a gilt stroke. */
  update(queued: string | null, useHovered: boolean, resolution: number): void
  /** Show or hide the whole palette, for the end of the session. */
  setVisible(visible: boolean): void
}

/** Build the retained palette plates in the given fixed layer. */
export function createExpressionPalette(
  layer: Container,
  createText: RendererTextFactory,
): ExpressionPalette {
  const plates = EMOTE_PLATES.map((emote) =>
    buildPlate(layer, createText, emote.rect, titleFor(emote.token), emote.hotkey),
  )
  const usePlate = buildPlate(layer, createText, USE_PLATE_RECT, 'Use', '0')

  const paint = (queued: string | null, useHovered: boolean, resolution: number): void => {
    for (const [index, plate] of plates.entries()) {
      paintPlate(
        plate,
        EMOTE_PLATES[index]?.rect,
        EMOTE_PLATES[index]?.token === queued,
        false,
        resolution,
      )
    }
    paintPlate(usePlate, USE_PLATE_RECT, queued === 'use', useHovered, resolution)
  }
  paint(null, false, 1)

  return {
    update(queued, useHovered, resolution) {
      paint(queued, useHovered, resolution)
    },
    setVisible(visible) {
      layer.visible = visible
    },
  }
}

/** One timber plate: a rounded panel, a centered label, and a small hotkey digit. */
interface Plate {
  panel: Graphics
  label: Text
  hotkey: Text
}

function buildPlate(
  layer: Container,
  createText: RendererTextFactory,
  rect: Rect,
  labelText: string,
  hotkeyText: string,
): Plate {
  const panel = new Graphics()
  layer.addChild(panel)
  const label = createText(labelText, HUD_FONT_SIZE, PALETTE.bone, 'center')
  label.position.set(rect.x + rect.width / 2, rect.y + rect.height / 2)
  layer.addChild(label)
  const hotkey = createText(hotkeyText, 11, PALETTE.bone, 'right')
  hotkey.position.set(rect.x + rect.width - 6, rect.y + 4)
  hotkey.alpha = 0.75
  layer.addChild(hotkey)
  return { panel, label, hotkey }
}

function paintPlate(
  plate: Plate,
  rect: Rect | undefined,
  queued: boolean,
  hovered: boolean,
  resolution: number,
): void {
  if (rect === undefined) return
  plate.panel
    .clear()
    .roundRect(rect.x, rect.y, rect.width, rect.height, 7)
    .fill(queued ? PALETTE.gilt : PALETTE.timber)
    .stroke(hovered ? { color: PALETTE.gilt, width: 2 } : { color: PALETTE.ink, width: 1 })
  plate.label.style.fill = queued ? PALETTE.ink : PALETTE.bone
  plate.label.resolution = resolution
  plate.hotkey.style.fill = queued ? PALETTE.ink : PALETTE.bone
  plate.hotkey.resolution = resolution
}

/** Return whether a point lies inside an inclusive axis-aligned rectangle. */
export function within(point: { x: number; y: number }, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}
