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

const focusZoom = () =>
  Math.min(limits.minZoom * THREE_BRANCHES_PRESENTATION.focusZoomFactor, limits.maxZoom)

describe('Three Branches visitor camera', () => {
  it('allows native-detail inspection at sixteen times the fitted zoom', () => {
    expect(THREE_BRANCHES_PRESENTATION.maxZoomFactor).toBe(16)
    expect(limits.maxZoom).toBe(limits.minZoom * 16)
  })

  it('opens on the visitor at the configurable focused zoom and follows from the start, with no control argument in play', () => {
    const state = initialVisitorCamera(limits, view, { x: 200, y: 600 })
    expect(state.camera.zoom).toBe(focusZoom())
    expect(state.target).toEqual({ x: 200, y: 600 })
    expect(state.following).toBe(true)
  })

  it('recenters on a delivered target while following, and leaves the view alone once follow is suspended', () => {
    let state = initialVisitorCamera(limits, view, { x: 200, y: 600 })
    state = updateVisitorCamera(state, limits, view, { x: 400, y: 600 })
    expect(state.camera.x).toBeGreaterThan(200)

    const prior = state.camera
    state = suspendVisitorFollow(state)
    state = updateVisitorCamera(state, limits, view, { x: 800, y: 600 })
    expect(state.camera).toBe(prior)
    expect(state.target).toEqual({ x: 800, y: 600 })
  })

  it('reset returns to the focus zoom, recenters on the latest target reached while suspended, and resumes following', () => {
    let state = initialVisitorCamera(limits, view, { x: 200, y: 600 })
    state = suspendVisitorFollow(state)
    state = updateVisitorCamera(state, limits, view, { x: 800, y: 600 })
    expect(state.following).toBe(false)

    state = resetVisitorCamera(state, limits, view)

    expect(state.following).toBe(true)
    expect(state.target).toEqual({ x: 800, y: 600 })
    expect(state.camera.zoom).toBe(focusZoom())
    expect(state.camera).toEqual(initialVisitorCamera(limits, view, { x: 800, y: 600 }).camera)
  })
})
