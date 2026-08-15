import { describe, expect, it } from 'vitest'

import { HEARTHSIDE_STYLE } from './presentation.js'
import { BRIDGE_PLANK_CODES, plankRowsFor } from './terrain-art.js'
import { planTerrainContours } from './terrain-contours.js'
import { planTerrainRoutes } from './terrain-routes.js'
import type { TerrainRoutePlan } from './types.js'

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
      HEARTHSIDE_STYLE.terrain.seams.waterHatch.bridgeTaperCells,
    )

    expect(routes.visualRows.join('')).not.toContain('r')
    expect(routes.visualRows.join('')).not.toContain('p')
    expect(routes.visualRows[1]?.[2]).toBe('b')
    expect(contours.components.some((component) => component.material === 'road')).toBe(false)
    expect(contours.components.some((component) => component.material === 'path')).toBe(false)
    expect(contours.components.some((component) => component.material === 'water')).toBe(true)
  })

  it('maps bridge components to their semantic plank frames', () => {
    const roadRoutes = routePlan(['ggggg', 'rrbrr', 'ggpgg'])
    const pathRoutes = routePlan(['rrrrr', 'ggpgg', 'ggbgg', 'ggpgg'])
    const compactRoutes = routePlan(['rrrrr', 'ggpgg', 'gpbpg', 'ggpgg'])
    const roadBridge = roadRoutes.bridgeComponents[0]!
    const pathBridge = pathRoutes.bridgeComponents[0]!
    const compactBridge = compactRoutes.bridgeComponents[0]!

    expect(roadBridge).toMatchObject({
      owner: 'road',
      orientation: 'horizontal',
      deck: { kind: 'axis', widthCells: 2.1, cap: 'square' },
    })
    expect(pathBridge).toMatchObject({
      owner: 'path',
      orientation: 'vertical',
      deck: { kind: 'axis', widthCells: 0.7, cap: 'square' },
    })
    expect(compactBridge).toMatchObject({
      orientation: 'compact',
      deck: { kind: 'compact', widthCells: 0.7, cap: 'round' },
    })
    expect(plankRowsFor(roadRoutes)[1]?.[2]).toBe(BRIDGE_PLANK_CODES.horizontal)
    expect(plankRowsFor(pathRoutes)[2]?.[2]).toBe(BRIDGE_PLANK_CODES.vertical)
    expect(plankRowsFor(compactRoutes)[2]?.[2]).toBe(BRIDGE_PLANK_CODES.compact)
  })
})
