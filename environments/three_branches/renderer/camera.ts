import {
  type CameraLimits,
  type CameraPoint,
  type CameraSize,
  type CameraView,
  centerCamera,
  clampCamera,
  fitCamera,
} from '@renderers/base/camera.js'

import { THREE_BRANCHES_PRESENTATION } from './presentation.js'

/** Camera reducer state plus the Three Branches visitor-follow policy. */
export interface VisitorCameraState {
  /** Shared camera reducer state. */
  camera: CameraView
  /** Whether new visitor positions automatically recenter the view. */
  following: boolean
  /** Latest known visitor position, including while follow is suspended. */
  target: CameraPoint
}

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
    target,
  }
}

/** Suspend follow after a deliberate manual camera gesture. */
export function suspendVisitorFollow(state: VisitorCameraState): VisitorCameraState {
  return { ...state, following: false }
}

/** Restore the visitor-focused zoom, recenter on the latest known target, and resume follow. */
export function resetVisitorCamera(
  state: VisitorCameraState,
  limits: CameraLimits,
  view: CameraSize,
): VisitorCameraState {
  return initialVisitorCamera(limits, view, state.target)
}
