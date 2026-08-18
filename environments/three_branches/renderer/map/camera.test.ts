import { cameraLimits, centerCamera } from '@renderers/base/camera.js'
import { describe, expect, it } from 'vitest'
import { THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import {
  advanceVisitorReturn,
  beginVisitorReturn,
  initialVisitorCamera,
  recenterVisitorCamera,
  suspendVisitorFollow,
  updateVisitorCamera,
} from './camera.js'

const view = { width: 1200, height: 946 }
const limits = cameraLimits({ minX: 0, minY: 0, maxX: 1600, maxY: 1200 }, view, {
  padding: THREE_BRANCHES_PRESENTATION.cameraPadding,
  maxZoomFactor: THREE_BRANCHES_PRESENTATION.maxZoomFactor,
})

const focusZoom = () =>
  Math.min(limits.minZoom * THREE_BRANCHES_PRESENTATION.focusZoomFactor, limits.maxZoom)

describe('Three Branches visitor camera', () => {
  it('opens on the visitor at the configurable focused zoom and follows from the start, with no control argument in play', () => {
    const state = initialVisitorCamera(limits, view, { x: 200, y: 600 })
    expect(state.camera.zoom).toBe(focusZoom())
    expect(state.target).toEqual({ x: 200, y: 600 })
    expect(state.following).toBe(true)
    expect(state.returning).toBe(false)
  })

  it('recenters on a delivered target while following, and leaves the view alone once follow is suspended', () => {
    let state = initialVisitorCamera(limits, view, { x: 200, y: 600 })
    state = updateVisitorCamera(state, limits, view, { x: 400, y: 600 })
    expect(state.camera.x).toBeGreaterThan(200)

    const prior = state.camera
    state = suspendVisitorFollow(state)
    expect(state.returning).toBe(false)
    state = updateVisitorCamera(state, limits, view, { x: 800, y: 600 })
    expect(state.camera).toBe(prior)
    expect(state.target).toEqual({ x: 800, y: 600 })
  })

  it('Recenter preserves the inspected zoom, centers on the latest target, and resumes following', () => {
    let state = initialVisitorCamera(limits, view, { x: 200, y: 600 })
    state = suspendVisitorFollow(state)
    state = updateVisitorCamera(state, limits, view, { x: 800, y: 600 })
    const inspectedZoom = state.camera.zoom * 2
    state = { ...state, camera: { ...state.camera, zoom: inspectedZoom } }
    expect(state.following).toBe(false)

    state = recenterVisitorCamera(state, limits, view)

    expect(state.following).toBe(true)
    expect(state.returning).toBe(false)
    expect(state.target).toEqual({ x: 800, y: 600 })
    expect(state.camera.zoom).toBe(inspectedZoom)
    expect(state.camera).toEqual(
      centerCamera({ ...state.camera, x: 0, y: 0 }, limits, view, { x: 800, y: 600 }),
    )
  })

  it('eases back at the inspected zoom, then resumes direct follow', () => {
    let state = initialVisitorCamera(limits, view, { x: 200, y: 600 })
    state = suspendVisitorFollow(state)
    state = updateVisitorCamera(state, limits, view, { x: 800, y: 600 })
    const inspectedZoom = state.camera.zoom
    const startDistance = Math.abs(state.target.x - state.camera.x)

    state = beginVisitorReturn(state)
    expect(state.following).toBe(false)
    expect(state.returning).toBe(true)

    state = advanceVisitorReturn(state, limits, view, 16)
    expect(state.camera.zoom).toBe(inspectedZoom)
    expect(Math.abs(state.target.x - state.camera.x)).toBeLessThan(startDistance)
    expect(state.following).toBe(false)
    expect(state.returning).toBe(true)

    const destination = centerCamera(state.camera, limits, view, state.target)
    state = advanceVisitorReturn(state, limits, view, 10_000)
    expect(state.camera).toEqual(destination)
    expect(state.following).toBe(true)
    expect(state.returning).toBe(false)
  })

  it('cancels an in-progress return when manual inspection resumes', () => {
    let state = initialVisitorCamera(limits, view, { x: 200, y: 600 })
    state = suspendVisitorFollow(state)
    state = beginVisitorReturn(state)

    state = suspendVisitorFollow(state)

    expect(state.following).toBe(false)
    expect(state.returning).toBe(false)
  })
})
