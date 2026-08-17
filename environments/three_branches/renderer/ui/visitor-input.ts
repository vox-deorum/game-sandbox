/**
 * The visitor's live input layer: the fixed virtual joystick, the keyboard axes, the
 * expression palette, and the once-per-landed-frame send.
 *
 * Everything here exists only while this screen controls `player_0` and the host passed a live
 * `sendAction`. Spectators and replay viewers get an inert controller that wires no listeners and
 * draws no controls. The controller claims presses on the joystick and palette in the capture
 * phase before the shared camera gestures see them. Every other content press remains available
 * for camera inspection and recentering.
 */
import type { RendererTextFactory } from '@renderers/base/PixiRenderer.js'
import { type Container, Graphics } from 'pixi.js'
import { HEARTHSIDE_STYLE, THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import {
  composeWindow,
  expressionActionId,
  hotkeyExpression,
  isTextEntry,
  JOYSTICK_RADIUS,
  joystickMotion,
  keyboardMotion,
  MOVEMENT_KEY_CODES,
  type MotionInput,
  SHIFT_KEY_CODES,
} from './input.js'
import {
  createExpressionPalette,
  EMOTE_PLATES,
  paletteHit,
  plateProbe,
  USE_PLATE_RECT,
} from './palette.js'

const PALETTE = HEARTHSIDE_STYLE.palette

/** The recording player id the human visitor acts for in every plan. */
const VISITOR_PLAYER = 'player_0'
const JOYSTICK_MARGIN = 18

/** Permanent bottom-left joystick center in logical renderer coordinates. */
export const JOYSTICK_CENTER = {
  x: JOYSTICK_MARGIN + JOYSTICK_RADIUS,
  y: THREE_BRANCHES_PRESENTATION.internalSize.height - JOYSTICK_MARGIN - JOYSTICK_RADIUS,
} as const

/** Renderer hooks and host context the controller needs. */
export interface VisitorInputOptions {
  /** The renderer host element, for browser listeners and probes. */
  container: HTMLElement
  /** The stable player ids this screen controls. */
  controlledPlayers: readonly string[]
  /** The live action forwarder, absent outside live human play. */
  sendAction?: (playerId: string, action: unknown) => void
  /** Fixed layer the floating pad draws in. */
  padLayer: Container
  /** Fixed layer the expression palette draws in. */
  paletteLayer: Container
  /** The renderer's crisp text factory. */
  createText: RendererTextFactory
  /** Convert a browser client point into the renderer's logical coordinates. */
  toView(client: { x: number; y: number }): { x: number; y: number }
  /** The visitor's heading on the latest landed state. */
  currentHeading(): number
  /** The current text bake resolution. */
  resolution(): number
  /** The prop a use would select from the latest landed pose, or null. */
  previewTarget(): string | null
  /** The catalog transition of one prop id: toggle, occupancy, timed, or none. */
  targetTransition(propId: string): string
  /** Show or clear the use-preview highlight on the props layer. */
  onPreview(propId: string | null): void
  /** Repaint the frame after a pad or palette change outside a state update. */
  redraw(): void
}

/** The mounted input layer's lifecycle, driven by the renderer. */
export interface VisitorInputController {
  /**
   * Observe one landed frame; a terminal frame ends the session's input for good. `send` gates the
   * once-per-frame action window, so a snap re-presentation keeps terminal and latch handling while
   * composing nothing.
   */
  handleFrame(terminal: boolean, send?: boolean): void
  /** Release every browser listener and the send loop. */
  destroy(): void
}

/** Wire the visitor input layer, or an inert stand-in when this screen has no control. */
export function createVisitorInput(options: VisitorInputOptions): VisitorInputController {
  const sendAction = options.sendAction
  const data = options.container.dataset
  if (sendAction === undefined || !options.controlledPlayers.includes(VISITOR_PLAYER)) {
    data.threeBranchesInput = 'none'
    return { handleFrame() {}, destroy() {} }
  }

  const palette = createExpressionPalette(options.paletteLayer, options.createText)
  const pad = new Graphics()
  options.padLayer.addChild(pad)

  let ended = false
  let queued: string | null = null
  let latched = false
  let latchTarget: string | null = null
  let moving = false
  let useHovered = false
  const heldKeys = new Set<string>()
  let joystick: {
    pointerId: number
    motion: MotionInput | null
  } | null = null

  data.threeBranchesInput = 'ready'
  data.threeBranchesQueued = 'none'
  data.threeBranchesLastAction = 'none'
  data.threeBranchesJoystick = `${JOYSTICK_CENTER.x},${JOYSTICK_CENTER.y}`
  data.threeBranchesUsePreview = 'none'
  data.threeBranchesUseLatch = 'none'
  for (const plate of EMOTE_PLATES) {
    data[emoteProbeKey(plate.token)] = plateProbe(plate.rect)
  }
  data.threeBranchesUseButton = plateProbe(USE_PLATE_RECT)
  paintPad(pad, JOYSTICK_CENTER, JOYSTICK_CENTER)

  /** The window's current motion, mirroring `composeWindow`'s joystick-then-keys resolution. */
  const windowMotion = (): MotionInput | null =>
    joystick !== null ? (joystick.motion ?? null) : keyboardMotion(heldKeys)

  /** Repaint the palette when the moving flag changes, and release any use latch the moment it does. */
  const updateMoving = (): void => {
    const next = windowMotion() !== null
    if (next === moving) return
    moving = next
    if (next) releaseLatch()
    paintPalette()
  }

  const paintPalette = (): void => {
    palette.update(queued, latched, useHovered, moving, options.resolution())
    options.redraw()
  }
  paintPalette()

  const setQueued = (token: string | null): void => {
    if (latched && token !== null) releaseLatch()
    queued = token
    data.threeBranchesQueued = token ?? 'none'
    paintPalette()
  }

  const releaseLatch = (): void => {
    if (!latched) return
    latched = false
    latchTarget = null
    data.threeBranchesUseLatch = 'none'
    paintPalette()
  }

  /** Engage the held use on the currently previewed prop, or toggle a held use back off. */
  const pressUse = (): void => {
    if (ended || moving) return
    if (latched) {
      releaseLatch()
      return
    }
    // Nothing is in reach, so there is no prop to latch; an unlatchable latch would only paint,
    // then drop on the next landed frame before a use could ever send.
    const target = options.previewTarget()
    if (target === null) return
    if (queued !== null) {
      queued = null
      data.threeBranchesQueued = 'none'
    }
    latched = true
    latchTarget = target
    data.threeBranchesUseLatch = target
    paintPalette()
  }

  const setPreview = (propId: string | null): void => {
    data.threeBranchesUsePreview = propId ?? 'none'
    options.onPreview(propId)
  }

  const setUseHover = (hovered: boolean): void => {
    if (useHovered === hovered) return
    useHovered = hovered
    setPreview(hovered ? options.previewTarget() : null)
    paintPalette()
  }

  const releaseJoystick = (): void => {
    if (joystick === null) return
    joystick = null
    paintPad(pad, JOYSTICK_CENTER, JOYSTICK_CENTER)
    updateMoving()
    options.redraw()
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (ended || !isPrimaryPress(event)) return
    const view = options.toView({ x: event.clientX, y: event.clientY })
    const plate = paletteHit(view)
    if (plate !== null) {
      claim(event)
      if (plate === 'use') pressUse()
      else setQueued(plate)
      return
    }
    if (!inJoystick(view)) return
    claim(event)
    if (joystick !== null) return
    joystick = { pointerId: event.pointerId, motion: joystickMotion(JOYSTICK_CENTER, view) }
    paintPad(pad, JOYSTICK_CENTER, view)
    updateMoving()
    options.redraw()
  }

  /** The controls own their double presses too, so they cannot also reset the camera. */
  const onDoubleClick = (event: MouseEvent): void => {
    if (ended) return
    const view = options.toView({ x: event.clientX, y: event.clientY })
    if (paletteHit(view) !== null || inJoystick(view)) claim(event)
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (ended || joystick === null || event.pointerId !== joystick.pointerId) return
    const view = options.toView({ x: event.clientX, y: event.clientY })
    joystick.motion = joystickMotion(JOYSTICK_CENTER, view)
    paintPad(pad, JOYSTICK_CENTER, view)
    updateMoving()
    options.redraw()
  }

  const onPointerUp = (event: PointerEvent): void => {
    if (joystick === null || event.pointerId !== joystick.pointerId) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    releaseJoystick()
  }

  const onHoverMove = (event: PointerEvent): void => {
    if (ended) return
    if (joystick !== null && event.pointerId === joystick.pointerId) return
    const view = options.toView({ x: event.clientX, y: event.clientY })
    setUseHover(paletteHit(view) === 'use')
  }

  const onHoverLeave = (): void => {
    setUseHover(false)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (ended || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
    if (isTextEntry(event.target)) return
    if (MOVEMENT_KEY_CODES.has(event.code)) {
      // Arrows scroll the page by default, and a held key repeats without changing the axes.
      event.preventDefault()
      heldKeys.add(event.code)
      updateMoving()
      return
    }
    if (SHIFT_KEY_CODES.has(event.code)) {
      heldKeys.add(event.code)
      return
    }
    const expression = hotkeyExpression(event.code)
    if (expression === null || event.repeat) return
    event.preventDefault()
    if (expression === 'use') pressUse()
    else setQueued(expression)
  }

  const onKeyUp = (event: KeyboardEvent): void => {
    heldKeys.delete(event.code)
    if (MOVEMENT_KEY_CODES.has(event.code)) updateMoving()
  }

  /** Keys and pointers can be released outside the window, so losing focus drops them all. */
  const onWindowBlur = (): void => {
    heldKeys.clear()
    releaseJoystick()
    updateMoving()
  }

  /** Compose and send exactly once per landed frame: motion first, then a held use or queued emote. */
  const sendWindow = (): void => {
    if (ended) return
    const motion = windowMotion()
    if (latched && motion !== null) releaseLatch()
    const action = composeWindow({
      joystickEngaged: joystick !== null,
      joystickMotion: joystick?.motion ?? null,
      heldKeys,
      queuedAction: latched ? 1 : queued === null ? 0 : expressionActionId(queued),
      currentHeading: options.currentHeading(),
    })
    if (queued !== null) setQueued(null)
    // A latch over a toggle or none prop releases itself after its first send, because one flip is
    // the whole interaction; only occupancy and timed props keep sending use.
    if (latched && action !== null && action.action === 1) {
      const transition = latchTarget === null ? 'none' : options.targetTransition(latchTarget)
      if (transition === 'toggle' || transition === 'none') releaseLatch()
    }
    if (action === null) return
    sendAction(VISITOR_PLAYER, action)
    data.threeBranchesLastAction = `${round(action.heading, 10)},${round(action.speed, 100)},${action.action}`
  }

  options.container.addEventListener('pointerdown', onPointerDown, { capture: true })
  options.container.addEventListener('dblclick', onDoubleClick, { capture: true })
  options.container.addEventListener('pointermove', onHoverMove)
  options.container.addEventListener('pointerleave', onHoverLeave)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onWindowBlur)

  return {
    handleFrame(terminal, send = true) {
      if (ended) return
      // A terminal frame ends the session's input for good, so it composes nothing.
      if (terminal) {
        ended = true
        releaseJoystick()
        releaseLatch()
        moving = false
        options.padLayer.visible = false
        data.threeBranchesJoystick = 'none'
        heldKeys.clear()
        queued = null
        data.threeBranchesQueued = 'none'
        if (useHovered) {
          useHovered = false
          setPreview(null)
        }
        palette.setVisible(false)
        data.threeBranchesInput = 'ended'
        options.redraw()
        return
      }
      // A latched use drops when the landing pose no longer puts a prop in reach.
      if (latched && options.previewTarget() === null) releaseLatch()
      if (send) sendWindow()
      // The landed pose moved, so a held hover re-answers which prop a use would select now.
      if (useHovered) setPreview(options.previewTarget())
    },
    destroy() {
      ended = true
      options.container.removeEventListener('pointerdown', onPointerDown, { capture: true })
      options.container.removeEventListener('dblclick', onDoubleClick, { capture: true })
      options.container.removeEventListener('pointermove', onHoverMove)
      options.container.removeEventListener('pointerleave', onHoverLeave)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onWindowBlur)
    },
  }
}

/** Stop a claimed press before the camera gestures and the browser defaults see it. */
function claim(event: Event): void {
  event.preventDefault()
  event.stopImmediatePropagation()
}

/**
 * Whether a press is the engaging primary press: the primary pointer, and for a mouse, its main
 * (left) button. A secondary finger or a non-left mouse button falls through untouched, so it
 * still reaches the camera gestures and the browser's own context menu.
 */
function isPrimaryPress(event: PointerEvent): boolean {
  return event.isPrimary && (event.pointerType !== 'mouse' || event.button === 0)
}

/** Whether a view point sits inside the fixed joystick ring. */
function inJoystick(view: { x: number; y: number }): boolean {
  return Math.hypot(view.x - JOYSTICK_CENTER.x, view.y - JOYSTICK_CENTER.y) <= JOYSTICK_RADIUS
}

/** Draw the fixed pad ring and the knob at the clamped drag point. */
function paintPad(
  pad: Graphics,
  center: { x: number; y: number },
  point: { x: number; y: number },
): void {
  const dx = point.x - center.x
  const dy = point.y - center.y
  const length = Math.hypot(dx, dy)
  const scale = length > JOYSTICK_RADIUS ? JOYSTICK_RADIUS / length : 1
  pad
    .clear()
    .circle(center.x, center.y, JOYSTICK_RADIUS)
    .fill({ color: PALETTE.parchment, alpha: 0.2 })
    .stroke({ color: PALETTE.ink, width: 2, alpha: 0.6 })
    .circle(center.x + dx * scale, center.y + dy * scale, 16)
    .fill({ color: PALETTE.timber, alpha: 0.9 })
    .stroke({ color: PALETTE.ink, width: 1 })
}

/** The dataset key behind `data-three-branches-emote-<token>` for one emote plate. */
export function emoteProbeKey(token: string): string {
  const camel = token
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  return `threeBranchesEmote${camel}`
}

function round(value: number, factor: number): number {
  return Math.round(value * factor) / factor
}
