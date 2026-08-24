import { stableHashParts } from '@renderers/base/math.js'
import type { TerrainContourPlan, TerrainContourSettings } from '../core/types.js'
import { buildChains, buildGraph } from './terrain-contour-graph.js'
import { buildCells, buildComponents, validateInputs } from './terrain-contour-grid.js'
import { referenceOf } from './terrain-contour-reference.js'
import { assignComponentAndRingIds, buildRings } from './terrain-contour-rings.js'
import { buildContourReferences, shapeChains } from './terrain-contour-shaping.js'
import { repairCurveGraph, validatePartition } from './terrain-contour-validation.js'

/**
 * Plan a closed, deterministic shared contour graph from top-first semantic rows.
 *
 * Bridge cells join the water material while retaining their semantic provenance.
 */
export function planTerrainContours(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  settings: TerrainContourSettings,
): TerrainContourPlan {
  const { width, height } = validateInputs(rows, groundNameForCode)
  const layoutHash = stableHashParts('terrain-layout', width, height, rows.join('\n'))
  const cells = buildCells(rows, groundNameForCode, width, height)
  const componentRecords = buildComponents(cells)
  const componentKeyForCell = new Map<number, string>()
  for (const component of componentRecords) {
    for (const cell of component.cells) componentKeyForCell.set(cell.index, component.key)
  }

  const graph = buildGraph(cells, width, height, componentKeyForCell)
  const workingChains = buildChains(graph.nodes, graph.segments)
  buildContourReferences(workingChains, settings)
  shapeChains(workingChains, settings, layoutHash)
  repairCurveGraph(workingChains)

  const workingRings = buildRings(graph.nodes, graph.segments, workingChains)
  assignComponentAndRingIds(componentRecords, workingRings)
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
      referencePoints: referenceOf(chain).points,
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
    })),
    components: componentRecords.map((component) => ({
      id: component.id,
      material: component.material,
      exterior: component.exterior,
      cellCount: component.cells.length,
      outerRingId: component.outerRingId,
      holeRingIds: component.holeRingIds,
    })),
  }
}
