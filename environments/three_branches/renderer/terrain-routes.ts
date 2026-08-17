import { buildBridgeComponents } from './terrain-route-bridges.js'
import { buildCells, cellCoordinate, validateInputs } from './terrain-route-grid.js'
import { buildPathConnectors, buildPathGuides } from './terrain-route-paths.js'
import { buildRoadGuide } from './terrain-route-road.js'
import {
  normalizeDiagonalTouches,
  propagateVisualSubstrate,
  replaceRouteCells,
} from './terrain-route-substrate.js'
import { cellKey } from './terrain-helpers.js'

import type {
  TerrainBridgeComponent,
  TerrainRoutePlan,
  TerrainRouteSettings,
} from './types.js'

/** Default numeric settings for renderer-local terrain route geometry. */
export const DEFAULT_TERRAIN_ROUTE_SETTINGS: TerrainRouteSettings = {
  road: {
    curve: {
      sampleSpacingCells: 0.25,
      cornerRadiusCells: 0.56,
      octaves: [{ wavelengthCells: 6, amplitudeCells: 0.05 }],
    },
    targetWidthCells: 2.1,
    minimumWidthCells: 1.6,
    opacity: 0.82,
  },
  path: {
    curve: {
      sampleSpacingCells: 0.2,
      cornerRadiusCells: 0.53,
      octaves: [{ wavelengthCells: 7, amplitudeCells: 0.04 }],
    },
    widthCells: 0.7,
    opacity: 1,
  },
}

/** Build natural road substrate, the inset road guide, connectors, and bridge deck specifications. */
export function planTerrainRoutes(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  settings: TerrainRouteSettings,
): TerrainRoutePlan {
  const { width, height } = validateInputs(rows, groundNameForCode, settings)
  const cells = buildCells(rows, groundNameForCode, width, height)
  const bridgeComponents = buildBridgeComponents(cells, width, height, settings)
  const bridgeForCell = new Map<string, TerrainBridgeComponent>()
  for (const component of bridgeComponents) {
    for (const cell of component.cells) bridgeForCell.set(cellKey(cell.column, cell.row), component)
  }

  const visualSubstrate = propagateVisualSubstrate(cells, width, height)
  // The substrate records keep the provenance of the cell they replaced, so a cell the following
  // pass rewrites no longer matches its record. Only diagnostics read that provenance.
  const visualRows = normalizeDiagonalTouches(
    replaceRouteCells(rows, visualSubstrate),
    groundNameForCode,
  )
  const roadMaskCells = cells
    .filter(
      (cell) =>
        cell.material === 'road' ||
        (cell.material === 'bridge' &&
          bridgeForCell.get(cellKey(cell.column, cell.row))?.owner === 'road'),
    )
    .map(cellCoordinate)
  const roadGuide = buildRoadGuide(rows, width, height, roadMaskCells, bridgeForCell, settings)
  const pathConnectors = buildPathConnectors(
    cells,
    width,
    height,
    roadMaskCells,
    roadGuide,
    settings.path.widthCells,
  )
  const pathGuides = buildPathGuides(
    cells,
    width,
    height,
    bridgeComponents,
    pathConnectors,
    settings,
    rows,
  )
  return {
    width,
    height,
    visualRows,
    visualSubstrate,
    roadGuide,
    roadMaskCells,
    pathGuides,
    pathConnectors,
    bridgeComponents,
  }
}
