import { cameraLimits } from '@renderers/base/camera.js'
import { describe, expect, it } from 'vitest'

import {
  initialVisitorCamera,
  resetVisitorCamera,
  suspendVisitorFollow,
  updateVisitorCamera,
} from './camera.js'
import { THREE_BRANCHES_PRESENTATION } from './presentation.js'

const view = { width: 1200, height: 946 }
const limits = cameraLimits({ minX: 0, minY: 0, maxX: 1600, maxY: 1200 }, view, {
  padding: THREE_BRANCHES_PRESENTATION.cameraPadding,
  maxZoomFactor: THREE_BRANCHES_PRESENTATION.maxZoomFactor,
})

describe('Three Branches visitor camera', () => {
  it('opens on the visitor at the configurable focused zoom', () => {
    const state = initialVisitorCamera(limits, view, { x: 200, y: 600 }, false)
    expect(state.camera.zoom).toBe(
      Math.min(limits.minZoom * THREE_BRANCHES_PRESENTATION.focusZoomFactor, limits.maxZoom),
    )
    expect(state.target).toEqual({ x: 200, y: 600 })
    expect(state.following).toBe(false)
  })

  it('corrects the first target and follows later positions only for human control', () => {
    let state = initialVisitorCamera(limits, view, { x: 200, y: 600 }, true)
    state = updateVisitorCamera(state, limits, view, { x: 400, y: 600 }, true)
    expect(state.camera.x).toBeGreaterThan(200)
    const prior = state.camera
    state = suspendVisitorFollow(state)
    state = updateVisitorCamera(state, limits, view, { x: 800, y: 600 })
    expect(state.camera).toBe(prior)
    expect(state.target).toEqual({ x: 800, y: 600 })
  })

  it('reset recenters and resumes only when the visitor is controlled', () => {
    const suspended = suspendVisitorFollow(
      initialVisitorCamera(limits, view, { x: 800, y: 600 }, true),
    )
    expect(resetVisitorCamera(suspended, limits, view, true).following).toBe(true)
    expect(resetVisitorCamera(suspended, limits, view, false).following).toBe(false)
  })
})
