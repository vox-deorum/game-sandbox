/**
 * Everything human play paints: the mist veil where perception ends, the gilt marks of an order being
 * composed, the informational automatic-strike preview, and the reset and confirmation controls.
 *
 * The pieces are split three ways, each for its own reason. The hit areas sit below the units so a
 * unit stays hoverable, and no unit can stand on an offered tile because occupancy is exactly what
 * makes a tile unofferable. The settled marks sit above the range washes so composition always reads
 * over hover inspection, and they are rebuilt only when the path changes, because their step numerals
 * bake text and a human turn can sit still for a minute. Only the parts that actually move, the
 * strike preview and the draining perimeter, are redrawn every frame.
 */
import type { MoveClockReading } from '@renderers/base/move-clock.js'
import { type Container, Graphics, Polygon } from 'pixi.js'

import type { CraneAssetName } from './assets.js'
import { hash } from './board.js'
import { MONO, type SpriteFactory, type TextFactory } from './draw.js'
import type { Perspective } from './fog.js'
import type { OrderComposition, StrikePreview } from './orders.js'
import {
  CRANE_STYLE,
  type CraneReachScene,
  type HexTile,
  type Point,
  SCENE_WIDTH,
} from './scene.js'

/** How much night ink the unseen ground takes. Terrain stays legible under it, by design. */
const FOG_VEIL_ALPHA = 0.45

/** The two fixed controls, centered in the bottom strip's clear space. */
export const RESET_BUTTON = { x: 564, y: 802, radius: 30 } as const
export const CONFIRM_BUTTON = { x: 636, y: 802, radius: 30 } as const

/** The preview pulse repeats on this period; reduced motion snaps to its final highlight instead. */
const PREVIEW_PERIOD_MS = 1_600

/** A step taken back pulses the tile it left, once, over this long. */
export const REVERT_PULSE_MS = 350

/** The strike thread's dash rhythm, in scene pixels. */
const THREAD_DASH = 6
const THREAD_GAP = 4

export interface OrderPlan {
  order: OrderComposition
  /** Tile keys a click may extend the path onto. */
  offered: ReadonlySet<string>
  preview: StrikePreview | null
  /** Where each previewed target stands, so the thread has somewhere to point. */
  previewPositions: Point[]
  /** The tile a step was just taken back from, and how much of its single pulse is left. */
  revert: { tileKey: string; strength: number } | null
  clock: MoveClockReading | null
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * The move clock as an arc: a full perimeter at the start of the turn, draining clockwise from the
 * top to nothing. There is no separate countdown anywhere, so this is the whole readout.
 *
 * What is drawn is the time that is left, so the gap opens at the top and its leading edge sweeps
 * clockwise as the budget goes. The arc always ends back at the top.
 */
export function clockArc(fraction: number): { start: number; end: number } {
  const top = -Math.PI / 2
  const remaining = Math.PI * 2 * Math.min(1, Math.max(0, fraction))
  return { start: top + Math.PI * 2 - remaining, end: top + Math.PI * 2 }
}

/** How much of the revert pulse is left. It fades once and does not repeat. */
export function revertPulse(elapsedMs: number, reducedMotion: boolean): number {
  if (reducedMotion) return 0
  return Math.max(0, 1 - elapsedMs / REVERT_PULSE_MS)
}

/** The preview's swell, or the settled final highlight when motion is unwelcome. */
export function previewPhase(elapsedMs: number, reducedMotion: boolean): number {
  if (reducedMotion) return 1
  return (1 - Math.cos((elapsedMs / PREVIEW_PERIOD_MS) * Math.PI * 2)) / 2
}

/** The activated unit's quiet fade while a person is deciding on an order. */
export function activationPulseAlpha(elapsedMs: number, reducedMotion: boolean): number {
  if (reducedMotion) return 1
  return 0.35 + 0.65 * ((1 + Math.cos((elapsedMs / PREVIEW_PERIOD_MS) * Math.PI * 2)) / 2)
}

/**
 * Glaze every tile outside the perspective. The glaze takes the tile's own wash-hex mask, the same
 * one its pigment pool uses, so its edges stay soft and the boundary needs no outline of its own.
 * Glazed terrain stays identifiable; the battlefield is standing knowledge and never dims away.
 */
export function drawFogVeil(
  layer: Container,
  sprite: SpriteFactory,
  scene: CraneReachScene,
  perspective: Perspective,
): void {
  for (const tile of scene.tiles) {
    if (perspective.tiles.has(tile.key)) continue
    const glaze = sprite(
      ['washHexA', 'washHexB', 'washHexC'][hash(tile.key) % 3] as CraneAssetName,
      tile.center.x,
      tile.center.y,
      scene.hexRadius * 2,
      scene.hexRadius * 2,
    )
    if (glaze === null) continue
    glaze.tint = CRANE_STYLE.fog
    glaze.alpha = FOG_VEIL_ALPHA
    glaze.rotation = (hash(`${tile.key}:turn`) % 6) * (Math.PI / 3)
    layer.addChild(glaze)
  }
}

/** How long a perspective switch takes to cross-dissolve, and its ease. */
export const FOG_CROSSFADE_MS = 200

export function fogCrossfade(elapsedMs: number, reducedMotion: boolean): number {
  if (reducedMotion) return 1
  const t = Math.min(1, Math.max(0, elapsedMs / FOG_CROSSFADE_MS))
  return t * t * (3 - 2 * t)
}

/**
 * The settled marks of an order being composed: what is offered, what has been walked, and where the
 * unit would end up. This is rebuilt only when the path changes, because the step numerals bake text
 * and a human turn can sit here for a minute.
 */
export function drawOrderMarks(
  layer: Container,
  text: TextFactory,
  scene: CraneReachScene,
  plan: OrderPlan,
  textResolution: number,
): void {
  const radius = scene.hexRadius
  const byKey = new Map(scene.tiles.map((tile) => [tile.key, tile]))
  const marks = new Graphics()

  for (const tileKey of plan.offered) {
    const tile = byKey.get(tileKey)
    if (tile === undefined) continue
    marks.poly(flatten(tile.corners)).fill({ color: CRANE_STYLE.activation, alpha: 0.25 })
    marks.circle(tile.center.x, tile.center.y, radius * 0.11).fill({ color: CRANE_STYLE.grid })
  }

  const walked = walkedCenters(byKey, plan)
  if (walked.length >= 2) {
    const [first, ...rest] = walked as [Point, ...Point[]]
    marks.moveTo(first.x, first.y)
    for (const point of rest) marks.lineTo(point.x, point.y)
    marks.stroke({ color: CRANE_STYLE.activation, width: Math.max(3, radius * 0.14), alpha: 0.92 })
  }

  layer.addChild(marks)

  for (const [step, center] of walked.slice(1).entries()) {
    const numeral = text(
      String(step + 1),
      Math.max(10, radius * 0.5),
      CRANE_STYLE.text,
      'center',
      MONO,
      { color: CRANE_STYLE.shadow, width: 2 },
    )
    numeral.resolution = textResolution
    numeral.position.set(center.x, center.y - radius * 0.62)
    layer.addChild(numeral)
  }
}

/**
 * The marks that breathe: the informational strike thread from the projected final tile, and the
 * single pulse on a tile a step was just taken back from. Redrawn every frame, so nothing here bakes
 * text or builds a node.
 */
export function drawOrderPulse(
  layer: Container,
  scene: CraneReachScene,
  plan: OrderPlan,
  phase: number,
): void {
  const radius = scene.hexRadius
  const byKey = new Map(scene.tiles.map((tile) => [tile.key, tile]))
  const pulse = new Graphics()

  const reverted = plan.revert === null ? undefined : byKey.get(plan.revert.tileKey)
  if (plan.revert !== null && reverted !== undefined && plan.revert.strength > 0) {
    pulse
      .circle(
        reverted.center.x,
        reverted.center.y,
        radius * (0.5 + (1 - plan.revert.strength) * 0.5),
      )
      .stroke({ color: CRANE_STYLE.activation, width: 2, alpha: plan.revert.strength })
  }

  if (plan.preview !== null) {
    const walked = walkedCenters(byKey, plan)
    const endpoint = walked[walked.length - 1]
    const stroke = { color: CRANE_STYLE.event, width: 1.5, alpha: 0.35 + phase * 0.5 }
    for (const target of plan.previewPositions) {
      if (endpoint === undefined) break
      // Always dashed, so the thread stays legible over painted ground. Several threads at once is
      // what says the strike is a draw between candidates; no caption is needed for that.
      thread(pulse, endpoint, target, stroke)
      pulse
        .circle(target.x, target.y, radius * (0.3 + phase * 0.16))
        .stroke({ color: CRANE_STYLE.event, width: 2, alpha: 0.3 + phase * 0.45 })
    }
  }
  layer.addChild(pulse)
}

/**
 * A dashed thread. The dashes are a fixed length rather than a fraction of the line, so a strike at
 * an adjacent hex reads as a dashed thread just as a shot across the field does.
 */
function thread(
  graphics: Graphics,
  from: Point,
  to: Point,
  style: { color: string; width: number; alpha: number },
): void {
  const length = Math.hypot(to.x - from.x, to.y - from.y)
  for (let along = 0; along < length; along += THREAD_DASH + THREAD_GAP) {
    const start = along / length
    const end = Math.min(1, (along + THREAD_DASH) / length)
    graphics
      .moveTo(from.x + (to.x - from.x) * start, from.y + (to.y - from.y) * start)
      .lineTo(from.x + (to.x - from.x) * end, from.y + (to.y - from.y) * end)
  }
  graphics.stroke(style)
}

/** The centres of the tiles the composed path has entered, its origin first. */
function walkedCenters(byKey: Map<string, HexTile>, plan: OrderPlan): Point[] {
  return plan.order.path.tiles
    .map((tileKey) => byKey.get(tileKey)?.center)
    .filter((center): center is Point => center !== undefined)
}

/**
 * Make the composable tiles clickable and nothing else. The set is the offered continuations plus the
 * two revision controls: the current endpoint takes a step back, and the unit's own tile clears.
 */
export function wireOrderHits(
  layer: Container,
  scene: CraneReachScene,
  clickable: ReadonlySet<string>,
  onPick: (tileKey: string) => void,
): void {
  for (const tile of scene.tiles) {
    if (!clickable.has(tile.key)) continue
    const target = new Graphics()
    target.poly(flatten(tile.corners)).fill({ color: CRANE_STYLE.activation, alpha: 0 })
    target.eventMode = 'static'
    target.cursor = 'pointer'
    target.hitArea = new Polygon(flatten(tile.corners))
    target.on('pointertap', (event) => {
      event.stopPropagation()
      onPick(tile.key)
    })
    layer.addChild(target)
  }
}

/**
 * The order controls' hit targets, built once and shown only while an order is being composed.
 * They are separate from the drawing below because the clock redraws every frame, and a hit target
 * replaced between a press and its release would never complete a tap.
 */
export function wireOrderButtons(
  layer: Container,
  onReset: () => void,
  onConfirm: () => void,
): Graphics {
  let reset: Graphics
  reset = wireOrderButton(RESET_BUTTON, 'Reset movement', () => {
    if (reset.eventMode === 'static') onReset()
  })
  syncAccessibleButtonWhenCreated(reset)
  const confirm = wireOrderButton(CONFIRM_BUTTON, 'Confirm order', onConfirm)
  layer.addChild(reset, confirm)
  return reset
}

/** Toggle Reset without replacing its retained hit target during a press. */
export function setResetButtonActive(reset: Graphics, active: boolean): void {
  reset.eventMode = active ? 'static' : 'none'
  reset.cursor = active ? 'pointer' : 'default'
  syncAccessibleButton(reset, reset._accessibleDiv)
}

/** Pixi creates its native accessibility bridge lazily, usually on the first Tab press. */
function syncAccessibleButtonWhenCreated(reset: Graphics): void {
  let bridge = reset._accessibleDiv
  Object.defineProperty(reset, '_accessibleDiv', {
    configurable: true,
    get: () => bridge,
    set: (created) => {
      bridge = created
      syncAccessibleButton(reset, created)
    },
  })
}

function syncAccessibleButton(reset: Graphics, bridge: HTMLElement | null | undefined): void {
  if (typeof HTMLButtonElement !== 'undefined' && bridge instanceof HTMLButtonElement) {
    bridge.disabled = reset.eventMode !== 'static'
    bridge.title = reset.accessibleTitle ?? ''
  }
}

function wireOrderButton(
  control: { x: number; y: number; radius: number },
  title: string,
  callback: () => void,
): Graphics {
  const hit = new Graphics()
  hit.circle(control.x, control.y, control.radius).fill({ color: CRANE_STYLE.activation, alpha: 0 })
  hit.eventMode = 'static'
  hit.cursor = 'pointer'
  hit.accessible = true
  hit.accessibleType = 'button'
  hit.accessibleTitle = title
  hit.on('pointertap', (event) => {
    event.stopPropagation()
    callback()
  })
  return hit
}

/**
 * The fixed reset and confirmation controls. Confirm's gilt perimeter is the move clock, draining
 * clockwise from the top and turning ember in the closing seconds; there is no separate countdown.
 */
export function drawOrderControls(layer: Container, sprite: SpriteFactory, plan: OrderPlan): void {
  drawOrderButton(layer, sprite, RESET_BUTTON, 'glyphReset', plan.order.path.directions.length > 0)
  drawOrderButton(layer, sprite, CONFIRM_BUTTON, 'glyphMove', true, plan.clock)
}

function drawOrderButton(
  layer: Container,
  sprite: SpriteFactory,
  control: { x: number; y: number; radius: number },
  glyphName: CraneAssetName,
  active: boolean,
  clock: MoveClockReading | null = null,
): void {
  const { x, y, radius } = control
  const button = new Graphics()
  button.circle(x, y, radius).fill({ color: CRANE_STYLE.backdrop, alpha: 0.86 })
  button
    .circle(x, y, radius)
    .stroke({
      color: active ? CRANE_STYLE.grid : CRANE_STYLE.mutedText,
      width: 2,
      alpha: active ? 1 : 0.45,
    })
  layer.addChild(button)

  if (clock !== null && clock.fraction > 0) {
    const arc = clockArc(clock.fraction)
    // `arc` continues whatever path is open, so it needs its own object and an explicit start. Left
    // to join the previous subpath it draws a stray line from the origin across the whole board.
    const remaining = new Graphics()
    remaining
      .moveTo(x + radius * Math.cos(arc.start), y + radius * Math.sin(arc.start))
      .arc(x, y, radius, arc.start, arc.end)
      .stroke({ color: clock.ember ? CRANE_STYLE.danger : CRANE_STYLE.activation, width: 4 })
    layer.addChild(remaining)
  }

  const glyph = sprite(glyphName, x, y, radius * 1.1, radius * 1.1)
  if (glyph !== null) {
    glyph.tint = active ? CRANE_STYLE.text : CRANE_STYLE.mutedText
    glyph.alpha = active ? 1 : 0.45
    layer.addChild(glyph)
  }
}

function flatten(corners: ReadonlyArray<Point>): number[] {
  return corners.flatMap((corner) => [corner.x, corner.y])
}
