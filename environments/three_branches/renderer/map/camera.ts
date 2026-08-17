import {
  type CameraLimits,
  type CameraPoint,
  type CameraSize,
  type CameraView,
  centerCamera,
  clampCamera,
  fitCamera,
} from '@renderers/base/camera.js'

import { THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'

/** Camera reducer state plus the Three Branches visitor-follow policy. */
export interface VisitorCameraState {
  /** Shared camera reducer state. */
  camera: CameraView
  /** Whether new visitor positions automatically recenter the view. */
  following: boolean
  /** Whether live play is easing an inspected view back to the visitor. */
  returning: boolean
  /** Latest known visitor position, including while follow is suspended. */
  target: CameraPoint
}

const RETURN_SPEED_PX_PER_MS = 0.8
const RETURN_SNAP_DISTANCE_PX = 0.5

/**
 * Open on the visitor at a configurable focused scale instead of binding the camera to one map
 * size, and start following: the camera always follows the visitor by default, regardless of
 * who controls it.
 */
export function initialVisitorCamera(
  limits: CameraLimits,
  view: CameraSize,
  spawn: CameraPoint,
): VisitorCameraState {
  const fit = fitCamera(limits, view)
  const focused = clampCamera(
    { ...fit, zoom: fit.zoom * THREE_BRANCHES_PRESENTATION.focusZoomFactor },
    limits,
    view,
  )
  return {
    camera: centerCamera(focused, limits, view, spawn),
    following: true,
    returning: false,
    target: spawn,
  }
}

/** Follow a new visitor position while the camera is following, or unconditionally when forced. */
export function updateVisitorCamera(
  state: VisitorCameraState,
  limits: CameraLimits,
  view: CameraSize,
  target: CameraPoint,
  force = false,
): VisitorCameraState {
  return {
    camera:
      state.following || force ? centerCamera(state.camera, limits, view, target) : state.camera,
    following: state.following,
    returning: state.returning,
    target,
  }
}

/** Suspend follow after a deliberate manual camera gesture. */
export function suspendVisitorFollow(state: VisitorCameraState): VisitorCameraState {
  return { ...state, following: false, returning: false }
}

/** Mark a suspended live-play camera to ease back to its latest visitor target. */
export function beginVisitorReturn(state: VisitorCameraState): VisitorCameraState {
  if (state.following || state.returning) return state
  return { ...state, returning: true }
}

/** Ease a returning camera toward the visitor at a fixed screen-space speed. */
export function advanceVisitorReturn(
  state: VisitorCameraState,
  limits: CameraLimits,
  view: CameraSize,
  dtMs: number,
): VisitorCameraState {
  if (!state.returning) return state
  const destination = centerCamera(state.camera, limits, view, state.target)
  const dx = destination.x - state.camera.x
  const dy = destination.y - state.camera.y
  const distancePx = Math.hypot(dx, dy) * state.camera.zoom
  const elapsedMs = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0
  const stepPx = elapsedMs * RETURN_SPEED_PX_PER_MS
  if (distancePx <= Math.max(RETURN_SNAP_DISTANCE_PX, stepPx)) {
    return {
      ...state,
      camera: destination,
      following: true,
      returning: false,
    }
  }
  const progress = stepPx / distancePx
  return {
    ...state,
    camera: {
      ...state.camera,
      x: state.camera.x + dx * progress,
      y: state.camera.y + dy * progress,
    },
  }
}

/** Recenter on the latest visitor target at the current zoom and resume follow. */
export function recenterVisitorCamera(
  state: VisitorCameraState,
  limits: CameraLimits,
  view: CameraSize,
): VisitorCameraState {
  return {
    ...state,
    camera: centerCamera(state.camera, limits, view, state.target),
    following: true,
    returning: false,
  }
}
