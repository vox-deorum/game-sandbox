/**
 * DOM gesture wiring for shared renderer cameras, deliberately separate from Pixi interaction.
 *
 * Future renderers compose this seam the way Hearts and Spades compose the shared card table: a
 * renderer supplies its coordinate conversion and camera reducers, while this module owns browser
 * listener lifetime and gesture recognition.
 */
import { type CameraPinch, type CameraPoint, wheelZoomFactor } from './camera.js'

/** Renderer callbacks that connect browser gestures to camera state. */
export interface CameraGestureHandlers {
  toView(clientPoint: CameraPoint): CameraPoint
  /**
   * Whether a gesture starting at this view point drives the camera. A renderer that paints its own
   * fixed controls answers false over them, so pressing a control cannot also pan, zoom, or reset.
   * Every point counts when a renderer leaves this out.
   */
  accepts?(view: CameraPoint): boolean
  zoomAt(factor: number, anchor: CameraPoint): void
  panBy(dx: number, dy: number): void
  pinch(before: CameraPinch, after: CameraPinch): void
  reset(): void
}

/** The lifetime handle returned by {@link wireCameraGestures}. */
export interface CameraGestures {
  dragging(): boolean
  detach(): void
}

interface PointerPosition {
  client: CameraPoint
  view: CameraPoint
  pointerType: string
}

interface Tap {
  at: number
  view: CameraPoint
}

const DRAG_THRESHOLD_PX = 4
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_DISTANCE = 30

/**
 * Wire wheel, drag, pinch, and reset gestures to a renderer host.
 *
 * Pointer movement is watched on `window` without pointer capture so Pixi can keep receiving hover
 * transitions while a drag crosses its interactive children.
 */
export function wireCameraGestures(
  target: HTMLElement,
  handlers: CameraGestureHandlers,
): CameraGestures {
  const pointers = new Map<number, PointerPosition>()
  // Empty string is the "not set" value detach must restore. Reading an unset property yields
  // undefined outside a real browser, and assigning that back would leave the literal string
  // "undefined" as the host's touch-action.
  const initialTouchAction = target.style.touchAction ?? ''
  let primaryPointerId: number | null = null
  let dragStart: PointerPosition | null = null
  let dragPrevious: PointerPosition | null = null
  let pinchPrevious: CameraPinch | null = null
  let lastTap: Tap | null = null
  let isDragging = false

  target.style.touchAction = 'none'

  const acceptsView = (view: CameraPoint): boolean => handlers.accepts?.(view) ?? true
  const acceptsClient = (client: CameraPoint): boolean => acceptsView(handlers.toView(client))

  const clearPointers = (): void => {
    pointers.clear()
    primaryPointerId = null
    dragStart = null
    dragPrevious = null
    pinchPrevious = null
    isDragging = false
  }

  const onWheel = (event: WheelEvent): void => {
    const anchor = handlers.toView({ x: event.clientX, y: event.clientY })
    if (!acceptsView(anchor)) return
    event.preventDefault()
    handlers.zoomAt(wheelZoomFactor(event.deltaY, event.deltaMode), anchor)
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (!acceptsClient({ x: event.clientX, y: event.clientY })) return
    // Cancel the mouse defaults so a drag past the canvas cannot select page text. Click and
    // double-click still fire for a canceled pointerdown, so the reset gesture keeps working.
    event.preventDefault()
    const pointer = pointerPosition(event, handlers)
    pointers.set(event.pointerId, pointer)
    if (pointers.size === 1) {
      primaryPointerId = event.pointerId
      dragStart = pointer
      dragPrevious = pointer
      isDragging = false
      return
    }
    // A pinch moves the world too, so Pixi taps from either finger must not inspect a unit.
    isDragging = true
    pinchPrevious = pinchFor(pointers)
  }

  const onPointerMove = (event: PointerEvent): void => {
    const previous = pointers.get(event.pointerId)
    if (previous === undefined) return
    const pointer = pointerPosition(event, handlers)
    pointers.set(event.pointerId, pointer)
    if (pointers.size >= 2) {
      const pinch = pinchFor(pointers)
      if (pinchPrevious !== null) handlers.pinch(pinchPrevious, pinch)
      pinchPrevious = pinch
      return
    }
    if (event.pointerId !== primaryPointerId || dragStart === null || dragPrevious === null) return
    if (!isDragging) {
      const distance = Math.hypot(
        pointer.client.x - dragStart.client.x,
        pointer.client.y - dragStart.client.y,
      )
      if (distance < DRAG_THRESHOLD_PX) return
      isDragging = true
    }
    handlers.panBy(pointer.view.x - dragPrevious.view.x, pointer.view.y - dragPrevious.view.y)
    dragPrevious = pointer
  }

  const onPointerUp = (event: PointerEvent): void => {
    const pointer = pointers.get(event.pointerId)
    if (pointer === undefined) return
    const wasTap = !isDragging && pointers.size === 1 && pointer.pointerType === 'touch'
    pointers.delete(event.pointerId)
    if (wasTap) rememberTap(pointer.view)
    if (pointers.size === 0) {
      clearPointers()
      return
    }
    const remaining = firstPointer(pointers)
    primaryPointerId = remaining.id
    dragStart = remaining.position
    dragPrevious = remaining.position
    pinchPrevious = pointers.size >= 2 ? pinchFor(pointers) : null
  }

  const onPointerCancel = (): void => clearPointers()
  const onDoubleClick = (event: MouseEvent): void => {
    if (!acceptsClient({ x: event.clientX, y: event.clientY })) return
    handlers.reset()
  }

  const rememberTap = (view: CameraPoint): void => {
    const now = Date.now()
    if (
      lastTap !== null &&
      now - lastTap.at <= DOUBLE_TAP_MS &&
      Math.hypot(view.x - lastTap.view.x, view.y - lastTap.view.y) <= DOUBLE_TAP_DISTANCE
    ) {
      handlers.reset()
      lastTap = null
      return
    }
    lastTap = { at: now, view }
  }

  // Capture before Pixi sees the canvas event so its interaction manager cannot stop the wheel
  // before the renderer host applies the camera gesture.
  target.addEventListener('wheel', onWheel, { passive: false, capture: true })
  target.addEventListener('pointerdown', onPointerDown)
  target.addEventListener('dblclick', onDoubleClick)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
  window.addEventListener('blur', clearPointers)

  return {
    dragging: () => isDragging,
    detach: () => {
      target.removeEventListener('wheel', onWheel, true)
      target.removeEventListener('pointerdown', onPointerDown)
      target.removeEventListener('dblclick', onDoubleClick)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('blur', clearPointers)
      target.style.touchAction = initialTouchAction
      clearPointers()
    },
  }
}

function pointerPosition(event: PointerEvent, handlers: CameraGestureHandlers): PointerPosition {
  const client = { x: event.clientX, y: event.clientY }
  return { client, view: handlers.toView(client), pointerType: event.pointerType }
}

function pinchFor(pointers: Map<number, PointerPosition>): CameraPinch {
  const first = firstPointer(pointers).position
  const second = secondPointer(pointers)
  return {
    midpoint: { x: (first.view.x + second.view.x) / 2, y: (first.view.y + second.view.y) / 2 },
    distance: Math.hypot(first.view.x - second.view.x, first.view.y - second.view.y),
  }
}

function firstPointer(pointers: Map<number, PointerPosition>): {
  id: number
  position: PointerPosition
} {
  const first = pointers.entries().next().value
  if (first === undefined) throw new Error('A pointer gesture needs at least one pointer.')
  return { id: first[0], position: first[1] }
}

function secondPointer(pointers: Map<number, PointerPosition>): PointerPosition {
  const iterator = pointers.values()
  iterator.next()
  const second = iterator.next().value
  if (second === undefined) throw new Error('A pinch gesture needs at least two pointers.')
  return second
}
