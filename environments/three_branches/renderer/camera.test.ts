import { cameraLimits, cameraProbeValue, fitCamera, viewPoint } from '@renderers/base/camera.js'
import { describe, expect, it } from 'vitest'

import { CHROME_HEIGHT } from './chrome.js'
import { WORLD_SCALE, WORLD_SIZE, WORLD_SIZE_METERS } from './geometry.js'
import { decodeStatic } from './overlay.js'
import { header } from './test-helpers.js'

describe('Three Branches camera assumptions', () => {
  it('defines the village as a 100 meter square at sixteen world units per meter', () => {
    expect(WORLD_SCALE).toBe(16)
    expect(WORLD_SIZE_METERS).toBe(100)
    expect(WORLD_SIZE).toBe(1600)
  })

  it('fits the full world below the fixed chrome and retains the shared compact probe format', () => {
    const view = { width: 1200, height: 1000 - CHROME_HEIGHT }
    const limits = cameraLimits({ minX: 0, minY: 0, maxX: WORLD_SIZE, maxY: WORLD_SIZE }, view)
    const camera = fitCamera(limits, view)
    const northwest = viewPoint(camera, view, { x: 0, y: 0 })
    const southeast = viewPoint(camera, view, { x: WORLD_SIZE, y: WORLD_SIZE })
    expect(northwest.x).toBeGreaterThanOrEqual(0)
    expect(northwest.y + CHROME_HEIGHT).toBeGreaterThanOrEqual(CHROME_HEIGHT)
    expect(southeast.x).toBeLessThanOrEqual(view.width)
    expect(southeast.y + CHROME_HEIGHT).toBeLessThanOrEqual(view.height + CHROME_HEIGHT)
    expect(limits.maxZoom).toBe(limits.minZoom * 4)
    expect(cameraProbeValue(camera)).toBe('0.58@800,800')
  })

  it('keeps every decoded layout point inside the camera world bounds', () => {
    const village = decodeStatic(header.overlay_static).village
    const points = [
      village.spawn,
      ...village.buildings.map((building) => building.center),
      ...village.props.map((prop) => prop.position),
      ...village.scenery.map((item) => item.position),
    ]
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(0)
      expect(point.x).toBeLessThanOrEqual(WORLD_SIZE_METERS)
      expect(point.y).toBeGreaterThanOrEqual(0)
      expect(point.y).toBeLessThanOrEqual(WORLD_SIZE_METERS)
    }
  })
})
