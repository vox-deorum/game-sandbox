import { fireEvent } from '@testing-library/vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  cameraLimits,
  cameraProbeValue,
  centerCamera,
  clampCamera,
  fitCamera,
  panCamera,
  pinchCamera,
  viewPoint,
  wheelZoomFactor,
  worldTransform,
  zoomCamera,
} from '../src/renderers/base/camera.js'
import { type CameraGestures, wireCameraGestures } from '../src/renderers/base/camera-gestures.js'

const view = { width: 1200, height: 860 }
const limits = cameraLimits({ minX: 140, minY: 90, maxX: 1060, maxY: 746 }, view)

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('camera reducers', () => {
  it('fits the padded Crane Reach extent at its center', () => {
    expect(limits.minZoom).toBeCloseTo(860 / 696)
    expect(limits.maxZoom).toBeCloseTo((860 / 696) * 4)
    expect(fitCamera(limits, view)).toEqual({ zoom: limits.minZoom, x: 600, y: 418 })
  })

  it('clamps low zoom and stray pans back to the unique fit view', () => {
    const fit = fitCamera(limits, view)
    expect(clampCamera({ zoom: 0, x: -100, y: -100 }, limits, view)).toEqual(fit)
    expect(clampCamera({ ...fit, x: fit.x + 30, y: fit.y - 30 }, limits, view)).toEqual(fit)
    expect(panCamera(fit, limits, view, 80, -80)).toEqual(fit)
  })

  it('clamps zoom and pan at the padded world edges', () => {
    const fit = fitCamera(limits, view)
    const zoomed = { ...fit, zoom: limits.maxZoom }
    const atEdge = panCamera(zoomed, limits, view, 50_000, 50_000)
    expect(atEdge.x).toBeCloseTo(limits.bounds.minX + view.width / (2 * limits.maxZoom))
    expect(atEdge.y).toBeCloseTo(limits.bounds.minY + view.height / (2 * limits.maxZoom))
    expect(clampCamera({ ...fit, zoom: 50 }, limits, view).zoom).toBe(limits.maxZoom)
  })

  it('centers a world point, clamping at the edges and settling to the fit when zoomed out', () => {
    const fit = fitCamera(limits, view)
    const zoomed = { ...fit, zoom: limits.maxZoom }

    // Zoomed in, the target lands in the middle of the view.
    const centered = centerCamera(zoomed, limits, view, { x: 600, y: 400 })
    expect(centered).toEqual({ zoom: limits.maxZoom, x: 600, y: 400 })

    // A target near the world edge clamps, so the view never leaves the board.
    const corner = centerCamera(zoomed, limits, view, {
      x: limits.bounds.minX,
      y: limits.bounds.minY,
    })
    expect(corner.x).toBeCloseTo(limits.bounds.minX + view.width / (2 * limits.maxZoom))
    expect(corner.y).toBeCloseTo(limits.bounds.minY + view.height / (2 * limits.maxZoom))

    // At the fitted zoom the whole board is already on screen, so following a unit moves nothing.
    expect(centerCamera(fit, limits, view, { x: 200, y: 700 })).toEqual(fit)
  })

  it('keeps the anchor fixed while zooming', () => {
    const camera = { zoom: 1.6, x: 600, y: 408 }
    const anchor = { x: 850, y: 250 }
    const zoomed = zoomCamera(camera, limits, view, 1.4, anchor)
    expectPointClose(viewPoint(zoomed, view, viewPointToWorld(camera, anchor)), anchor)
  })

  it('keeps the moving midpoint anchored while pinching', () => {
    const camera = { zoom: 1.6, x: 600, y: 408 }
    const world = viewPointToWorld(camera, { x: 500, y: 430 })
    const pinched = pinchCamera(
      camera,
      limits,
      view,
      { midpoint: { x: 500, y: 430 }, distance: 80 },
      { midpoint: { x: 700, y: 380 }, distance: 160 },
    )
    expectPointClose(viewPoint(pinched, view, world), { x: 700, y: 380 })
  })

  it('ignores a pinch without usable distances', () => {
    const camera = { zoom: 1.6, x: 600, y: 408 }
    expect(
      pinchCamera(
        camera,
        limits,
        view,
        { midpoint: { x: 500, y: 430 }, distance: 0 },
        { midpoint: { x: 700, y: 380 }, distance: 160 },
      ),
    ).toEqual(camera)
  })

  it('maps wheel deltas in pixel, line, and page modes', () => {
    expect(wheelZoomFactor(-100, 0)).toBeGreaterThan(1)
    expect(wheelZoomFactor(100, 0)).toBeLessThan(1)
    expect(wheelZoomFactor(1, 1)).toBeCloseTo(wheelZoomFactor(16, 0))
    expect(wheelZoomFactor(1, 2)).toBeCloseTo(wheelZoomFactor(384, 0))
  })

  it('projects points in agreement with the world transform', () => {
    const camera = { zoom: 1.24, x: 600, y: 418 }
    const transform = worldTransform(camera, view)
    const world = { x: 712, y: 360 }
    const projected = viewPoint(camera, view, world)
    expect((projected.x - transform.x) / transform.scale).toBeCloseTo(world.x)
    expect((projected.y - transform.y) / transform.scale).toBeCloseTo(world.y)
  })

  it('formats the camera probe value', () => {
    expect(cameraProbeValue({ zoom: 1.24, x: 600, y: 418 })).toBe('1.24@600,418')
  })
})

describe('camera gestures', () => {
  const attached: CameraGestures[] = []

  afterEach(() => {
    for (const gestures of attached.splice(0)) {
      gestures.detach()
    }
  })

  function wire() {
    const target = document.createElement('div')
    document.body.append(target)
    const handlers = {
      toView: vi.fn((point: { x: number; y: number }) => ({ x: point.x - 10, y: point.y - 20 })),
      zoomAt: vi.fn(),
      panBy: vi.fn(),
      pinch: vi.fn(),
      reset: vi.fn(),
    }
    const gestures = wireCameraGestures(target, handlers)
    attached.push(gestures)
    return { target, handlers, gestures }
  }

  it('zooms at the converted wheel point and blocks page scroll', () => {
    const { target, handlers } = wire()
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -40 })
    target.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)
    expect(handlers.zoomAt).toHaveBeenCalledWith(wheelZoomFactor(-40, 0), { x: -10, y: -20 })
  })

  it('cancels pointer down so a drag cannot select page text', () => {
    const { target } = wire()
    const down = pointer(target, 'pointerdown', 1, 100, 100)
    expect(down.defaultPrevented).toBe(true)
  })

  it('pans only after the drag threshold', () => {
    const { target, handlers, gestures } = wire()
    pointer(target, 'pointerdown', 1, 100, 100)
    pointer(window, 'pointermove', 1, 103, 100)
    expect(gestures.dragging()).toBe(false)
    expect(handlers.panBy).not.toHaveBeenCalled()
    pointer(window, 'pointermove', 1, 105, 100)
    expect(gestures.dragging()).toBe(true)
    expect(handlers.panBy).toHaveBeenLastCalledWith(5, 0)
  })

  it('keeps the drag flag through the target pointerup and clears it afterward', () => {
    const { target, gestures } = wire()
    let draggingDuringTargetPointerUp = false
    target.addEventListener('pointerup', () => {
      draggingDuringTargetPointerUp = gestures.dragging()
    })
    pointer(target, 'pointerdown', 1, 100, 100)
    pointer(window, 'pointermove', 1, 110, 100)
    pointer(target, 'pointerup', 1, 110, 100)
    expect(draggingDuringTargetPointerUp).toBe(true)
    expect(gestures.dragging()).toBe(false)
  })

  it('treats two touches as a pinch and never as a tap', () => {
    const { target, handlers, gestures } = wire()
    pointer(target, 'pointerdown', 6, 50, 50, 'touch')
    pointer(target, 'pointerdown', 7, 100, 50, 'touch')
    expect(gestures.dragging()).toBe(true)
    pointer(window, 'pointermove', 7, 120, 50, 'touch')
    expect(handlers.pinch).toHaveBeenCalledWith(
      { midpoint: { x: 65, y: 30 }, distance: 50 },
      { midpoint: { x: 75, y: 30 }, distance: 70 },
    )
    pointer(window, 'pointerup', 6, 50, 50, 'touch')
    pointer(window, 'pointerup', 7, 100, 50, 'touch')
    expect(gestures.dragging()).toBe(false)
    expect(handlers.reset).not.toHaveBeenCalled()
  })

  it('resets on double click', () => {
    const { target, handlers } = wire()
    fireEvent.dblClick(target)
    expect(handlers.reset).toHaveBeenCalledTimes(1)
  })

  it('resets on a touch double tap', () => {
    const { target, handlers } = wire()
    pointer(target, 'pointerdown', 2, 100, 100, 'touch')
    pointer(window, 'pointerup', 2, 100, 100, 'touch')
    expect(handlers.reset).not.toHaveBeenCalled()
    pointer(target, 'pointerdown', 3, 105, 102, 'touch')
    pointer(window, 'pointerup', 3, 105, 102, 'touch')
    expect(handlers.reset).toHaveBeenCalledTimes(1)
  })

  it('claims touch-action while attached and restores the host on detach', () => {
    const { target, gestures } = wire()
    expect(target.style.touchAction).toBe('none')
    gestures.detach()
    expect(target.style.touchAction).toBe('')
  })

  it('stops listening after detach', () => {
    const { target, handlers, gestures } = wire()
    gestures.detach()
    target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -40 }))
    fireEvent.dblClick(target)
    pointer(target, 'pointerdown', 1, 100, 100)
    pointer(window, 'pointermove', 1, 200, 200)
    expect(handlers.zoomAt).not.toHaveBeenCalled()
    expect(handlers.reset).not.toHaveBeenCalled()
    expect(handlers.panBy).not.toHaveBeenCalled()
  })
})

function pointer(
  target: EventTarget,
  type: string,
  pointerId: number,
  clientX: number,
  clientY: number,
  pointerType = 'mouse',
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    clientY: { value: clientY },
    pointerType: { value: pointerType },
  })
  target.dispatchEvent(event)
  return event
}

function expectPointClose(
  actual: { x: number; y: number },
  expected: { x: number; y: number },
): void {
  expect(actual.x).toBeCloseTo(expected.x)
  expect(actual.y).toBeCloseTo(expected.y)
}

function viewPointToWorld(
  camera: { zoom: number; x: number; y: number },
  point: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: camera.x + (point.x - view.width / 2) / camera.zoom,
    y: camera.y + (point.y - view.height / 2) / camera.zoom,
  }
}
