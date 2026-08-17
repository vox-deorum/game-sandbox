import { describe, expect, it } from 'vitest'
import { fixtureRecording } from '../core/test-helpers.js'
import { buildStaticScene } from '../map/scene.js'
import { readStatic } from '../ui/overlay.js'
import { contourDebugScene, contourSvg, materialNames, topFirstRows } from './contour-debug.js'

/** A village with a diagonal bank, a pond, and a road crossing it, small enough to reason about. */
function sampleRows(): readonly string[] {
  const size = 24
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => {
      if (row === 12) return 'r'
      if (row > 17 && row < 21 && column > 4 && column < 9) return 'w'
      return column > row + 4 ? 'f' : 'g'
    }).join(''),
  )
}

describe('Three Branches contour debug drawing', () => {
  it('inverts recorded rows the way the scene does', () => {
    // Getting this backwards draws a self-consistent picture of a mirrored village, which reads as
    // plausible for a long time. The scene owns the one inversion, so the tool has to agree with it.
    const recorded = fixtureRecording().header
    const scene = buildStaticScene(readStatic(recorded))
    expect(topFirstRows(readStatic(recorded).ground)).toEqual(scene.topFirstRows)
  })

  it('names materials from the rules the runtime validates against', () => {
    expect(materialNames().g).toBe('ground')
    expect(materialNames().w).toBe('water')
    expect(materialNames().r).toBe('road')
  })

  it('measures the drawn curve of a planned village', () => {
    const scene = contourDebugScene(sampleRows())

    // Road cells never reach the contour pass: the route plan hands them to natural substrate
    // first, which is the whole reason this tool plans routes before contours.
    expect(scene.rows.join('')).not.toContain('r')
    expect(scene.routes.roadGuide.length).toBeGreaterThan(0)

    const measured = scene.measurements
    expect(measured.chains).toBeGreaterThan(0)
    expect(measured.crossings).toBe(0)
    expect(measured.referenceVertices).toBeGreaterThan(measured.onCellCorner)
    expect(measured.turningPerCell).toBeGreaterThan(0)
    expect(measured.wanderMedian).toBeGreaterThan(0)
    expect(measured.wanderP90).toBeGreaterThanOrEqual(measured.wanderMedian)
    expect(measured.worstTubeCells).toBeLessThan(1)
  })

  it('draws every layer inside the window it was asked for', () => {
    const scene = contourDebugScene(sampleRows())
    const svg = contourSvg(scene, { x: 4, y: 4, span: 8, scale: 40, seed: 3 })

    for (const layer of ['cells', 'grid', 'routes', 'raw', 'reference', 'drawn', 'hot', 'report']) {
      expect(svg).toContain(`<g class="${layer}">`)
    }
    expect(svg).toContain('<title>Three Branches contours, seed 3</title>')
    expect(svg).toContain('viewBox="4 ')
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)

    // The window clips the cell fills, and the report band sits above the map rather than over it.
    expect(svg).toContain('<rect x="4" y="4" width="1" height="1"')
    expect(svg).not.toContain('<rect x="20"')
    expect(svg).toMatch(/<text x="[\d.]+" y="[-\d.]+"/)
  })

  it('reports the same numbers it draws', () => {
    const scene = contourDebugScene(sampleRows())
    const svg = contourSvg(scene, { x: 0, y: 0, span: 24, scale: 20, seed: 0 })
    expect(svg).toContain(`turns past 45 deg ${scene.measurements.turnsPast45}`)
    expect(svg).toContain(`crossings ${scene.measurements.crossings}`)
  })
})
