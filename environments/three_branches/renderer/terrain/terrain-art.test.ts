import { describe, expect, it } from 'vitest'

import { HEARTHSIDE_STYLE } from '../core/presentation.js'
import type { TerrainRoutePlan } from '../core/types.js'
import { planTerrainContours } from './terrain-contours.js'
import { planTerrainRoutes } from './terrain-routes.js'

const names: Readonly<Record<string, string>> = {
  w: 'water',
  g: 'ground',
  e: 'reeds',
  f: 'field',
  r: 'road',
  p: 'path',
  b: 'bridge',
  i: 'interior',
  d: 'doorway',
  x: 'wall',
}

function routePlan(rows: readonly string[]): TerrainRoutePlan {
  return planTerrainRoutes(rows, names, HEARTHSIDE_STYLE.terrain.routes)
}

describe('Three Branches terrain art planning', () => {
  it('plans contours over the natural substrate while retaining bridge water semantics', () => {
    const rows = ['ggggg', 'rrbrr', 'ggpgg']
    const routes = routePlan(rows)
    const contours = planTerrainContours(
      routes.visualRows,
      names,
      HEARTHSIDE_STYLE.terrain.contours,
    )

    expect(routes.visualRows.join('')).not.toContain('r')
    expect(routes.visualRows.join('')).not.toContain('p')
    expect(routes.visualRows[1]?.[2]).toBe('b')
    expect(contours.components.some((component) => component.material === 'road')).toBe(false)
    expect(contours.components.some((component) => component.material === 'path')).toBe(false)
    expect(contours.components.some((component) => component.material === 'water')).toBe(true)
  })
})
