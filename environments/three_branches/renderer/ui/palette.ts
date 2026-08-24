/**
 * The visitor's expression palette: a 3 by 3 emote grid with a separate Use plate, drawn in the
 * chrome strip's Hearthside plate style and clicked in the browser's own coordinates through the
 * fixed rectangles below, exactly as the chrome controls are.
 */
import type { RendererTextFactory } from '@renderers/base/PixiRenderer.js'
import { type Container, Graphics, Sprite, type Text, Texture } from 'pixi.js'
import { HEARTHSIDE_STYLE, THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import { titleFor } from '../map/scene.js'
import { EMOTE_TOKENS } from './input.js'
import type { ExpressionArt } from './annotations.js'

const PALETTE = HEARTHSIDE_STYLE.palette
const LAYOUT = HEARTHSIDE_STYLE.expressions.inputPalette

type Rect = { x: number; y: number; width: number; height: number }

const PLATE_WIDTH = LAYOUT.plateWidth
const PLATE_HEIGHT = LAYOUT.plateHeight
const PLATE_GAP = LAYOUT.gap
const CONTENT_MARGIN = LAYOUT.contentMargin

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

/** Retained palette drawing, repainted toward the queued expression and the Use latch. */
export interface ExpressionPalette {
  /**
   * Repaint the plates: the queued emote takes the gilt active treatment, the Use plate the gilt
   * treatment while latched, a gilt stroke while hovered, and a dim treatment while disabled.
   */
  update(
    queued: string | null,
    useLatched: boolean,
    useHovered: boolean,
    useDisabled: boolean,
    resolution: number,
  ): void
  /** Install the monochrome expression textures after the effects atlas loads. */
  install(art: ExpressionArt): void
  /** Choose the icon shown on the Use plate, falling back to the generic use marker. */
  setUseIcon(token: string | null): void
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
  let art: ExpressionArt | null = null
  let useIcon = 'use'

  const applyIcons = (): void => {
    for (const [index, plate] of plates.entries()) {
      const token = EMOTE_PLATES[index]?.token
      assignIcon(plate, art?.icon[token ?? ''] ?? Texture.EMPTY)
    }
    assignIcon(usePlate, art?.icon[useIcon] ?? art?.icon.use ?? Texture.EMPTY)
  }

  const paint = (
    queued: string | null,
    useLatched: boolean,
    useHovered: boolean,
    useDisabled: boolean,
    resolution: number,
  ): void => {
    for (const [index, plate] of plates.entries()) {
      paintPlate(
        plate,
        EMOTE_PLATES[index]?.rect,
        EMOTE_PLATES[index]?.token === queued,
        false,
        resolution,
      )
    }
    paintPlate(
      usePlate,
      USE_PLATE_RECT,
      queued === 'use' || useLatched,
      useHovered,
      resolution,
      useDisabled,
    )
  }
  paint(null, false, false, false, 1)

  return {
    update(queued, useLatched, useHovered, useDisabled, resolution) {
      paint(queued, useLatched, useHovered, useDisabled, resolution)
    },
    install(nextArt) {
      art = nextArt
      applyIcons()
    },
    setUseIcon(token) {
      useIcon = token ?? 'use'
      applyIcons()
    },
    setVisible(visible) {
      layer.visible = visible
    },
  }
}

/** One timber plate: a rounded panel, a centered label, and a small hotkey digit. */
interface Plate {
  panel: Graphics
  icon: Sprite
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
  const icon = new Sprite({ texture: Texture.EMPTY, label: 'expression-palette-icon' })
  icon.anchor.set(0.5)
  icon.tint = PALETTE.bone
  icon.position.set(rect.x + LAYOUT.iconFrameWidth / 2, rect.y + rect.height / 2)
  icon.visible = false
  layer.addChild(icon)
  const label = createText(labelText, LAYOUT.labelFontSize, PALETTE.bone, 'left')
  label.position.set(rect.x + LAYOUT.iconFrameWidth, rect.y + rect.height / 2)
  layer.addChild(label)
  const hotkey = createText(hotkeyText, 11, PALETTE.bone, 'right')
  hotkey.position.set(rect.x + rect.width - 6, rect.y + 4)
  hotkey.alpha = 0.75
  layer.addChild(hotkey)
  return { panel, icon, label, hotkey }
}

function assignIcon(plate: Plate, texture: Texture): void {
  plate.icon.texture = texture
  plate.icon.visible = texture !== Texture.EMPTY
  plate.icon.scale.set(texture.width > 0 ? LAYOUT.iconFrameWidth / texture.width : 1)
}

function paintPlate(
  plate: Plate,
  rect: Rect | undefined,
  active: boolean,
  hovered: boolean,
  resolution: number,
  disabled = false,
): void {
  if (rect === undefined) return
  // A disabled plate reads dim: a faded panel and text, with the hover stroke suppressed.
  plate.panel.alpha = disabled ? 0.45 : 1
  plate.label.alpha = disabled ? 0.55 : 1
  plate.icon.alpha = disabled ? 0.55 : 1
  plate.hotkey.alpha = disabled ? 0.55 : 0.75
  plate.panel
    .clear()
    .roundRect(rect.x, rect.y, rect.width, rect.height, 7)
    .fill(active ? PALETTE.gilt : PALETTE.timber)
    .stroke(
      hovered && !disabled ? { color: PALETTE.gilt, width: 2 } : { color: PALETTE.ink, width: 1 },
    )
  plate.label.style.fill = active ? PALETTE.ink : PALETTE.bone
  plate.icon.tint = active ? PALETTE.ink : PALETTE.bone
  plate.label.resolution = resolution
  plate.hotkey.style.fill = active ? PALETTE.ink : PALETTE.bone
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
