import { stableHashParts } from '@renderers/base/math.js'

import {
  DisjointSet,
  buildCells,
  buildComponents,
  findSaddles,
  unionCardinalComponents,
  validateInputs,
} from './terrain-contour-grid.js'
import { buildChains, buildGraph } from './terrain-contour-graph.js'
import { buildClearanceIndex, shapeChains } from './terrain-contour-shaping.js'
import {
  assignComponentAndRingIds,
  assignComponentNesting,
  buildRings,
} from './terrain-contour-rings.js'
import {
  repairContourIntersections,
  validateCurveGraph,
  validatePartition,
} from './terrain-contour-validation.js'
import type { TerrainContourPlan, TerrainContourSettings } from './types.js'

export { TERRAIN_EXTERIOR } from './terrain-contour-grid.js'

/**
 * Plan a closed, deterministic shared contour graph from top-first semantic rows.
 *
 * Bridge cells join the water material while remaining bridge-owned in span provenance.
 */
export function planTerrainContours(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  settings: TerrainContourSettings,
  bridgeTaperCells: number,
): TerrainContourPlan {
  const { width, height } = validateInputs(rows, groundNameForCode, settings, bridgeTaperCells)
  const layoutHash = stableHashParts('terrain-layout', width, height, rows.join('\n'))
  const cells = buildCells(rows, groundNameForCode, width, height)
  const components = new DisjointSet(cells.length)
  unionCardinalComponents(cells, width, height, components)
  const saddles = findSaddles(cells, width, height, settings.saddleRadiusCells, components)
  const componentRecords = buildComponents(cells, components)
  const componentKeyForCell = new Map<number, string>()
  for (const component of componentRecords) {
    for (const cell of component.cells) componentKeyForCell.set(cell.index, component.key)
  }

  const graph = buildGraph(cells, width, height, saddles, componentKeyForCell)
  const workingChains = buildChains(graph.nodes, graph.segments)
  const clearanceIndex = buildClearanceIndex(workingChains)
  shapeChains(workingChains, settings, bridgeTaperCells, layoutHash, clearanceIndex)
  repairContourIntersections(workingChains)
  validateCurveGraph(workingChains, settings.maxDeviationCells)

  const workingRings = buildRings(graph.nodes, graph.segments, workingChains)
  assignComponentAndRingIds(componentRecords, workingRings)
  assignComponentNesting(componentRecords, workingRings)
  validatePartition(workingChains, workingRings, componentRecords)

  return {
    width,
    height,
    chains: workingChains.map((chain) => ({
      id: chain.id,
      closed: chain.closed,
      materials: chain.materials,
      leftMaterial: chain.leftMaterial,
      rightMaterial: chain.rightMaterial,
      points: chain.points,
      rawPoints: chain.rawPoints,
      rawLength: chain.rawLength,
      spans: chain.spans,
      shorelineSpans: chain.shorelineSpans,
    })),
    rings: workingRings.map((ring) => ({
      id: ring.id,
      componentId: ring.componentId,
      material: ring.material,
      role: ring.role,
      uses: ring.uses,
      points: ring.points,
      signedArea: ring.signedArea,
    })),
    components: componentRecords.map((component) => ({
      id: component.id,
      material: component.material,
      exterior: component.exterior,
      cellCount: component.cells.length,
      outerRingId: component.outerRingId,
      holeRingIds: component.holeRingIds,
      ...(component.parentComponentId === undefined
        ? {}
        : { parentComponentId: component.parentComponentId }),
      nestingDepth: component.nestingDepth,
    })),
    saddles: saddles.map(({ winnerCells: _winnerCells, ...saddle }) => saddle),
  }
}
