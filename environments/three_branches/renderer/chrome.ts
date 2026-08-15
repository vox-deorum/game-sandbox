import type { RendererTextFactory } from '@renderers/base/PixiRenderer.js'
import { type Container, Graphics, type Text } from 'pixi.js'

import { HEARTHSIDE_STYLE, THREE_BRANCHES_PRESENTATION } from './presentation.js'
import type { FrameScene } from './types.js'

const PALETTE = HEARTHSIDE_STYLE.palette

/**
 * Fixed logical hit rectangle for the collision overlay control.
 *
 * This and {@link RECENTER_RECT} are the single statement of where their controls sit in the
 * chrome strip, shared by the drawing below, the renderer's chrome hit band, and the browser
 * probe.
 */
export const COLLISION_TOGGLE_RECT = { x: 840, y: 5, width: 184, height: 44 } as const

/** Fixed logical hit rectangle for the Recenter control. See {@link COLLISION_TOGGLE_RECT}. */
export const RECENTER_RECT = { x: 1036, y: 5, width: 148, height: 44 } as const

/** Retained village information strip and its permanent controls. */
export interface ChromeLayer {
  /** Reconcile the strip's labels and button treatments toward one frame. */
  update(
    scene: FrameScene,
    fallbackTick: number,
    collisionVisible: boolean,
    resolution: number,
  ): void
}

/** The strip's status text for one frame. */
export function statusText(scene: FrameScene, fallbackTick: number): string {
  const dynamic = scene.dynamic
  if (dynamic === null) return `Opening · Tick ${fallbackTick}`
  return `${dynamic.phase} · Tick ${dynamic.tick}${dynamic.terminal ? ' · Complete' : ''}`
}

/** The bell's state word, or null when the village has no bell or no frame has landed. */
export function bellText(scene: FrameScene): string | null {
  const bellProp = scene.static.props.find((prop) => prop.type === 'bell')
  if (bellProp === undefined || scene.dynamic === null) return null
  // Anything other than the ringing token reads as silent, so an unrecognized state stays safe.
  return scene.dynamic.props[bellProp.id] === 'ringing' ? 'rings' : 'silent'
}

/** The collision button's label. */
export function collisionText(collisionVisible: boolean): string {
  return `Collision: ${collisionVisible ? 'On' : 'Off'}`
}

type Rect = { x: number; y: number; width: number; height: number }

const BELL_ICON_X = 560
const BELL_ICON_SIZE = 18
const TEXTURE_FLECK_COUNT = 40

/**
 * Build the fixed village information strip and its Recenter and collision controls.
 *
 * The strip is drawn once here with Pixi `Graphics` and `Text`, outside the graded world
 * container, so it is never colour-graded. It is clicked in the browser's own coordinates by the
 * renderer, which is how every other gesture in this environment is answered.
 */
export function createChrome(layer: Container, createText: RendererTextFactory): ChromeLayer {
  const width = THREE_BRANCHES_PRESENTATION.internalSize.width
  const height = THREE_BRANCHES_PRESENTATION.chromeHeight

  layer.addChild(new Graphics().rect(0, 0, width, height).fill(PALETTE.parchment))
  layer.addChild(textureFlecks(width, height))
  layer.addChild(new Graphics().rect(0, height - 1, width, 1).fill(PALETTE.ink))

  const status = textAt(layer, createText, 16, height / 2, 19, PALETTE.ink)

  const bellIcon = new Graphics()
  layer.addChild(bellIcon)
  const bell = textAt(
    layer,
    createText,
    BELL_ICON_X + BELL_ICON_SIZE + 10,
    height / 2,
    15,
    PALETTE.ink,
  )

  const recenter = plate(layer, createText, RECENTER_RECT)
  recenter.label.text = 'Recenter'

  const collision = plate(layer, createText, COLLISION_TOGGLE_RECT)

  return {
    update(scene, fallbackTick, collisionVisible, resolution) {
      status.text = statusText(scene, fallbackTick)
      status.resolution = resolution

      const word = bellText(scene)
      bellIcon.visible = word !== null
      bell.visible = word !== null
      if (word !== null) {
        drawBellIcon(bellIcon, word === 'rings' ? PALETTE.gilt : PALETTE.ink)
        bell.text = word
        bell.resolution = resolution
      }

      recenter.label.resolution = resolution

      collision.label.text = collisionText(collisionVisible)
      collision.label.style.fill = collisionVisible ? PALETTE.ink : PALETTE.bone
      collision.label.resolution = resolution
      paintPlate(collision.panel, COLLISION_TOGGLE_RECT, collisionVisible)
    },
  }
}

/** One timber button plate: a rounded panel with an ink stroke and a centered label. */
interface Plate {
  panel: Graphics
  label: Text
}

function plate(layer: Container, createText: RendererTextFactory, rect: Rect): Plate {
  const panel = new Graphics()
  layer.addChild(panel)
  paintPlate(panel, rect, false)
  const label = createText('', 15, PALETTE.bone, 'center')
  label.position.set(rect.x + rect.width / 2, rect.y + rect.height / 2)
  layer.addChild(label)
  return { panel, label }
}

/** Paint a button's timber plate, or its gilt active treatment when it is toggled on. */
function paintPlate(panel: Graphics, rect: Rect, active: boolean): void {
  panel
    .clear()
    .roundRect(rect.x, rect.y, rect.width, rect.height, 7)
    .fill(active ? PALETTE.gilt : PALETTE.timber)
    .stroke({ color: PALETTE.ink, width: 1 })
}

/** Redraw the small bell icon (a dome, a rim, and a clapper) in the given accent color. */
function drawBellIcon(icon: Graphics, color: string): void {
  const centerY = THREE_BRANCHES_PRESENTATION.chromeHeight / 2
  const domeRadius = BELL_ICON_SIZE / 2
  const centerX = BELL_ICON_X + domeRadius
  icon
    .clear()
    .circle(centerX, centerY - domeRadius * 0.15, domeRadius)
    .rect(BELL_ICON_X, centerY + domeRadius * 0.55, BELL_ICON_SIZE, BELL_ICON_SIZE * 0.14)
    .circle(centerX, centerY + domeRadius * 0.95, BELL_ICON_SIZE * 0.11)
    .fill(color)
}

/**
 * A handful of short ink hatch marks placed by fixed arithmetic on the fleck index, never
 * `Math.random`, so the parchment texture is identical on every mount and every replay seek.
 */
function textureFlecks(width: number, height: number): Graphics {
  const flecks = new Graphics()
  for (let i = 0; i < TEXTURE_FLECK_COUNT; i++) {
    const x = 10 + ((i * 87) % (width - 20))
    const y = 8 + ((i * 31) % (height - 16))
    const tilt = i % 2 === 0 ? 1 : -1
    flecks.moveTo(x, y).lineTo(x + 6, y + tilt * 3)
  }
  flecks.stroke({ color: PALETTE.ink, width: 1, alpha: 0.16 })
  return flecks
}

function textAt(
  layer: Container,
  createText: RendererTextFactory,
  x: number,
  y: number,
  size: number,
  color: string,
): Text {
  const value = createText('', size, color, 'left')
  value.anchor.y = 0.5
  value.position.set(x, y)
  layer.addChild(value)
  return value
}
