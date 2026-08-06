/**
 * Shared camera arithmetic for renderers that want a movable world below fixed screen UI.
 *
 * Future renderers compose these reducers the way Hearts and Spades compose the shared card table:
 * the renderer owns its layers and feeds the resulting transform to its world container.
 */

/** A point in either world or logical view coordinates, as named by the calling function. */
export interface CameraPoint {
  x: number
  y: number
}

/** The renderer's unscaled logical canvas size. */
export interface CameraSize {
  width: number
  height: number
}

/** The inclusive outer edges of the world that the camera may show. */
export interface CameraBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** The world point at the center of the view and the world-to-view scale. */
export interface CameraView {
  zoom: number
  x: number
  y: number
}

/** The padded world extent and the zoom range derived from it. */
export interface CameraLimits {
  bounds: CameraBounds
  minZoom: number
  maxZoom: number
}

/** Optional configuration for {@link cameraLimits}. */
export interface CameraLimitsOptions {
  padding?: number
  maxZoomFactor?: number
}

/** A two-pointer gesture summarized as its midpoint and separation. */
export interface CameraPinch {
  midpoint: CameraPoint
  distance: number
}

/** Derive the padded extent and usable zoom range for a world and a logical view. */
export function cameraLimits(
  bounds: CameraBounds,
  view: CameraSize,
  { padding = 20, maxZoomFactor = 4 }: CameraLimitsOptions = {},
): CameraLimits {
  const paddedBounds = {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  }
  const fit = Math.min(
    view.width / (paddedBounds.maxX - paddedBounds.minX),
    view.height / (paddedBounds.maxY - paddedBounds.minY),
  )
  return { bounds: paddedBounds, minZoom: fit, maxZoom: fit * maxZoomFactor }
}

/** Return the unique minimum-zoom view, centered on the padded world. */
export function fitCamera(limits: CameraLimits, _view: CameraSize): CameraView {
  return {
    zoom: limits.minZoom,
    x: (limits.bounds.minX + limits.bounds.maxX) / 2,
    y: (limits.bounds.minY + limits.bounds.maxY) / 2,
  }
}

/** Keep a camera inside its zoom range and keep its visible world rectangle inside the padded extent. */
export function clampCamera(
  camera: CameraView,
  limits: CameraLimits,
  view: CameraSize,
): CameraView {
  const zoom = Math.min(limits.maxZoom, Math.max(limits.minZoom, camera.zoom))
  // Fit is the one reset state even when rounding makes an axis appear fractionally pannable.
  if (zoom === limits.minZoom) return fitCamera(limits, view)
  return {
    zoom,
    x: clampCenter(camera.x, limits.bounds.minX, limits.bounds.maxX, view.width / (2 * zoom)),
    y: clampCenter(camera.y, limits.bounds.minY, limits.bounds.maxY, view.height / (2 * zoom)),
  }
}

/** Zoom by a factor while preserving the world point under a logical-view anchor. */
export function zoomCamera(
  camera: CameraView,
  limits: CameraLimits,
  view: CameraSize,
  factor: number,
  anchor: CameraPoint,
): CameraView {
  const world = worldPoint(camera, view, anchor)
  const zoom = Math.min(limits.maxZoom, Math.max(limits.minZoom, camera.zoom * factor))
  return clampCamera(
    {
      zoom,
      x: world.x - (anchor.x - view.width / 2) / zoom,
      y: world.y - (anchor.y - view.height / 2) / zoom,
    },
    limits,
    view,
  )
}

/** Pan by a logical-view drag delta. Moving the pointer right reveals world space to the left. */
export function panCamera(
  camera: CameraView,
  limits: CameraLimits,
  view: CameraSize,
  dx: number,
  dy: number,
): CameraView {
  return clampCamera(
    { zoom: camera.zoom, x: camera.x - dx / camera.zoom, y: camera.y - dy / camera.zoom },
    limits,
    view,
  )
}

/** Apply a midpoint-anchored pinch, including its scale ratio and midpoint movement. */
export function pinchCamera(
  camera: CameraView,
  limits: CameraLimits,
  view: CameraSize,
  before: CameraPinch,
  after: CameraPinch,
): CameraView {
  if (
    !Number.isFinite(before.distance) ||
    !Number.isFinite(after.distance) ||
    before.distance <= 0 ||
    after.distance <= 0
  ) {
    return clampCamera(camera, limits, view)
  }
  const anchor = worldPoint(camera, view, before.midpoint)
  const factor = after.distance / before.distance
  const zoom = Math.min(limits.maxZoom, Math.max(limits.minZoom, camera.zoom * factor))
  return clampCamera(
    {
      zoom,
      x: anchor.x - (after.midpoint.x - view.width / 2) / zoom,
      y: anchor.y - (after.midpoint.y - view.height / 2) / zoom,
    },
    limits,
    view,
  )
}

/** Turn a browser wheel delta into the matching multiplicative zoom factor. */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const normalized = deltaY * (deltaMode === 1 ? 16 : 1)
  return Math.exp(-normalized * 0.0015)
}

/** Convert a camera into the position and scale for its world container. */
export function worldTransform(
  camera: CameraView,
  view: CameraSize,
): {
  x: number
  y: number
  scale: number
} {
  return {
    x: view.width / 2 - camera.x * camera.zoom,
    y: view.height / 2 - camera.y * camera.zoom,
    scale: camera.zoom,
  }
}

/** Project a world point into the logical view. */
export function viewPoint(camera: CameraView, view: CameraSize, world: CameraPoint): CameraPoint {
  return {
    x: (world.x - camera.x) * camera.zoom + view.width / 2,
    y: (world.y - camera.y) * camera.zoom + view.height / 2,
  }
}

/** A compact camera value for renderer probes and browser assertions. */
export function cameraProbeValue(camera: CameraView): string {
  return `${camera.zoom.toFixed(2)}@${Math.round(camera.x)},${Math.round(camera.y)}`
}

function worldPoint(camera: CameraView, view: CameraSize, point: CameraPoint): CameraPoint {
  return {
    x: camera.x + (point.x - view.width / 2) / camera.zoom,
    y: camera.y + (point.y - view.height / 2) / camera.zoom,
  }
}

function clampCenter(value: number, min: number, max: number, halfView: number): number {
  const center = (min + max) / 2
  if (halfView >= (max - min) / 2) return center
  return Math.min(max - halfView, Math.max(min + halfView, value))
}
