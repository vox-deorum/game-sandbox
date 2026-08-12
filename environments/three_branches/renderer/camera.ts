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

/** Open at a configurable visitor-focused scale instead of binding the camera to one map size. */
export function initialVisitorCamera(
  limits: CameraLimits,
  view: CameraSize,
  spawn: CameraPoint,
  humanControlled: boolean,
): VisitorCameraState {
  const fit = fitCamera(limits, view)
  const focused = clampCamera(
    { ...fit, zoom: fit.zoom * THREE_BRANCHES_PRESENTATION.focusZoomFactor },
    limits,
    view,
  )
  return {
    camera: centerCamera(focused, limits, view, spawn),
    following: humanControlled,
    target: spawn,
  }
}

/** Follow a new visitor position only while live human control still owns camera focus. */
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

/** Restore the visitor-focused zoom and resume follow only for live human control. */
export function resetVisitorCamera(
  state: VisitorCameraState,
  limits: CameraLimits,
  view: CameraSize,
  humanControlled: boolean,
): VisitorCameraState {
  const reset = initialVisitorCamera(limits, view, state.target, humanControlled)
  return { ...reset, following: humanControlled }
}
