import { avalanche, stableHashParts } from '@renderers/base/math.js'

import { shapeTerrainCurve } from './terrain-curves.js'
import { CARDINAL_DIRECTIONS } from './terrain-route-grid.js'
import { cellKey, compareCells, EPSILON, required } from './terrain-helpers.js'

import type {
  TerrainBridgeComponent,
  TerrainRoadGuidePoint,
  TerrainRouteCell,
  TerrainRoutePoint,
  TerrainRouteSettings,
} from './types.js'

interface Run {
  readonly minRow: number
  readonly maxRow: number
  readonly medianRow: number
}

interface GuideState {
  readonly run: Run
  readonly cost: number
  readonly overlap: number
  readonly signature: readonly number[]
  readonly previous?: GuideState
}

/** Build the inset road guide from the road and road-owned bridge mask. */
export function buildRoadGuide(
  rows: readonly string[],
  width: number,
  height: number,
  roadMaskCells: readonly TerrainRouteCell[],
  bridgeForCell: ReadonlyMap<string, TerrainBridgeComponent>,
  settings: TerrainRouteSettings,
): readonly TerrainRoadGuidePoint[] {
  if (roadMaskCells.length === 0) return []
  const fullMask = new Set(roadMaskCells.map((cell) => cellKey(cell.column, cell.row)))
  const spanning = cardinalMaskComponents(roadMaskCells, fullMask).filter((component) =>
    Array.from({ length: width }, (_, column) =>
      component.some((cell) => cell.column === column),
    ).every(Boolean),
  )
  if (spanning.length === 0) {
    const missingColumn = Array.from(
      { length: width },
      (_, column) => !roadMaskCells.some((cell) => cell.column === column),
    ).findIndex(Boolean)
    throw new Error(
      missingColumn >= 0
        ? `The inset road route does not span column ${missingColumn}.`
        : 'The inset road route has no cardinally continuous west-to-east component.',
    )
  }
  const selections = spanning.map((component) => {
    const mask = new Set(component.map((cell) => cellKey(cell.column, cell.row)))
    return { component, mask, ...selectRoadRuns(width, height, mask) }
  })
  selections.sort(
    (first, second) =>
      compareGuideStates(first.state, second.state) ||
      compareCells(
        required(first.component[0], 'Road component is empty.'),
        required(second.component[0], 'Road component is empty.'),
      ),
  )
  const selection = required(selections[0], 'Spanning road selection is missing.')
  const { mask, selected } = selection

  const raw = selected.map((run, column) => {
    const bridges = Array.from(
      new Set(
        Array.from({ length: run.maxRow - run.minRow + 1 }, (_, index) => run.minRow + index)
          .map((row) => bridgeForCell.get(cellKey(column, row)))
          .filter((component): component is TerrainBridgeComponent => component?.owner === 'road'),
      ),
    ).sort((first, second) => first.id.localeCompare(second.id))
    const bridge = bridges[0]
    const rawY = bridge?.orientation === 'horizontal' ? bridge.deck.center.y : run.medianRow + 0.5
    const anchor =
      column === 0 || column === width - 1 ? 'map' : bridge === undefined ? null : 'bridge'
    return {
      x: column + 0.5,
      y: rawY,
      rawX: column + 0.5,
      rawY,
      column,
      locked: anchor !== null,
      anchor,
      fellBack: false,
      widthCells: settings.road.targetWidthCells,
    } satisfies TerrainRoadGuidePoint
  })
  return fairRoadGuide(raw, rows, width, height, mask, settings)
}

function cardinalMaskComponents(
  cells: readonly TerrainRouteCell[],
  mask: ReadonlySet<string>,
): readonly TerrainRouteCell[][] {
  const byKey = new Map(cells.map((cell) => [cellKey(cell.column, cell.row), cell]))
  const visited = new Set<string>()
  const result: TerrainRouteCell[][] = []
  for (const start of [...cells].sort(compareCells)) {
    const startKey = cellKey(start.column, start.row)
    if (visited.has(startKey)) continue
    const component: TerrainRouteCell[] = []
    const queue = [start]
    visited.add(startKey)
    for (let index = 0; index < queue.length; index += 1) {
      const cell = required(queue[index], 'Road component queue entry is missing.')
      component.push(cell)
      for (const [dx, dy] of CARDINAL_DIRECTIONS) {
        const key = cellKey(cell.column + dx, cell.row + dy)
        if (!mask.has(key) || visited.has(key)) continue
        const neighbor = byKey.get(key)
        if (neighbor === undefined) continue
        visited.add(key)
        queue.push(neighbor)
      }
    }
    component.sort(compareCells)
    result.push(component)
  }
  return result
}

function selectRoadRuns(
  width: number,
  height: number,
  mask: ReadonlySet<string>,
): { readonly selected: readonly Run[]; readonly state: GuideState } {
  const runsByColumn = Array.from({ length: width }, (_, column) =>
    columnRuns(column, height, mask),
  )
  let states = required(runsByColumn[0], 'First road-run column is missing.').map<GuideState>(
    (run) => ({
      run,
      cost: 0,
      overlap: 0,
      signature: [run.medianRow, run.minRow, run.maxRow],
    }),
  )
  for (let column = 1; column < width; column += 1) {
    const next: GuideState[] = []
    for (const run of required(runsByColumn[column], 'Road-run column is missing.')) {
      const candidates = states
        .filter((previous) => runOverlap(previous.run, run) > 0)
        .map<GuideState>((previous) => ({
          run,
          cost: previous.cost + (run.medianRow - previous.run.medianRow) ** 2,
          overlap: previous.overlap + runOverlap(previous.run, run),
          signature: [...previous.signature, run.medianRow, run.minRow, run.maxRow],
          previous,
        }))
      candidates.sort(compareGuideStates)
      if (candidates[0] !== undefined) next.push(candidates[0])
    }
    states = next
  }
  states.sort(compareGuideStates)
  const state = required(states[0], 'Cardinal road component has no reachable west-to-east run.')
  const selected: Run[] = []
  for (let item: GuideState | undefined = state; item !== undefined; item = item.previous) {
    selected.push(item.run)
  }
  selected.reverse()
  return { selected, state }
}

function columnRuns(column: number, height: number, mask: ReadonlySet<string>): readonly Run[] {
  const result: Run[] = []
  let start: number | null = null
  for (let row = 0; row <= height; row += 1) {
    if (row < height && mask.has(cellKey(column, row))) {
      if (start === null) start = row
      continue
    }
    if (start === null) continue
    const maxRow = row - 1
    result.push({ minRow: start, maxRow, medianRow: (start + maxRow) / 2 })
    start = null
  }
  return result
}

function runOverlap(first: Run, second: Run): number {
  return Math.max(
    0,
    Math.min(first.maxRow, second.maxRow) - Math.max(first.minRow, second.minRow) + 1,
  )
}

function compareGuideStates(first: GuideState, second: GuideState): number {
  return (
    first.cost - second.cost ||
    second.overlap - first.overlap ||
    compareNumberArrays(first.signature, second.signature)
  )
}

function compareNumberArrays(first: readonly number[], second: readonly number[]): number {
  for (let index = 0; index < Math.min(first.length, second.length); index += 1) {
    const difference =
      required(first[index], 'Road guide signature value is missing.') -
      required(second[index], 'Road guide signature value is missing.')
    if (difference !== 0) return difference
  }
  return first.length - second.length
}

function fairRoadGuide(
  raw: readonly TerrainRoadGuidePoint[],
  rows: readonly string[],
  width: number,
  height: number,
  mask: ReadonlySet<string>,
  settings: TerrainRouteSettings,
): readonly TerrainRoadGuidePoint[] {
  const layoutHash = avalanche(stableHashParts('road-route', width, height, ...rows))
  const shaped = shapeTerrainCurve(
    raw.map((point) => ({ x: point.rawX, y: point.rawY, locked: point.locked })),
    false,
    settings.road.curve,
    layoutHash,
  )
  return shaped.map((point, index) => {
    const source = roadSourceAtOffset(raw, point.sourceOffset)
    const previous = shaped[index - 1]
    const next = shaped[index + 1]
    const candidateWidth = roadWidthAt(point, mask, width, height, settings.road.targetWidthCells)
    const valid =
      point.x >= 0 &&
      point.y >= 0 &&
      point.x < width &&
      point.y < height &&
      mask.has(cellKey(Math.floor(point.x), Math.floor(point.y))) &&
      candidateWidth + EPSILON >= settings.road.minimumWidthCells &&
      (previous === undefined || point.x > previous.x + EPSILON) &&
      (next === undefined || point.x < next.x - EPSILON)
    const chosen = valid ? point : { x: source.rawX, y: source.rawY }
    const availableWidth = roadWidthAt(chosen, mask, width, height, settings.road.targetWidthCells)
    const widthCells = Math.max(settings.road.minimumWidthCells, availableWidth)
    const footprintFallback = availableWidth + EPSILON < settings.road.minimumWidthCells
    return valid
      ? { ...source, x: point.x, y: point.y, widthCells }
      : {
          ...source,
          x: source.rawX,
          y: source.rawY,
          fellBack: !source.locked || footprintFallback,
          widthCells,
        }
  })
}

function roadSourceAtOffset(
  raw: readonly TerrainRoadGuidePoint[],
  sourceOffset: number,
): TerrainRoadGuidePoint {
  const location = sourceAtOffset(raw, sourceOffset)
  const exact = location.exact
  return {
    x: location.point.x,
    y: location.point.y,
    rawX: location.point.x,
    rawY: location.point.y,
    column: Math.min(
      required(raw.at(-1), 'Raw road guide is empty.').column,
      Math.max(required(raw[0], 'Raw road guide is empty.').column, Math.floor(location.point.x)),
    ),
    locked: exact?.locked ?? false,
    anchor: exact?.anchor ?? null,
    fellBack: false,
    widthCells: exact?.widthCells ?? required(raw[0], 'Raw road guide is empty.').widthCells,
  }
}

/** Locate the authored source point at a shaped-guide arc offset. */
export function sourceAtOffset<Value extends TerrainRoutePoint>(
  source: readonly Value[],
  targetOffset: number,
): {
  readonly point: TerrainRoutePoint
  readonly exact?: Value
  readonly segmentStart?: Value
  readonly segmentEnd?: Value
} {
  let offset = 0
  for (let index = 0; index < source.length; index += 1) {
    const start = required(source[index], 'Route curve source point is missing.')
    if (Math.abs(targetOffset - offset) <= EPSILON) return { point: start, exact: start }
    const end = source[index + 1]
    if (end === undefined) return { point: start, exact: start }
    const length = Math.hypot(end.x - start.x, end.y - start.y)
    if (targetOffset <= offset + length + EPSILON) {
      const amount = length <= EPSILON ? 0 : (targetOffset - offset) / length
      return {
        point: {
          x: start.x + (end.x - start.x) * amount,
          y: start.y + (end.y - start.y) * amount,
        },
        segmentStart: start,
        segmentEnd: end,
        ...(Math.abs(targetOffset - (offset + length)) <= EPSILON ? { exact: end } : {}),
      }
    }
    offset += length
  }
  const last = required(source.at(-1), 'Route curve source is empty.')
  return { point: last, exact: last }
}

function roadWidthAt(
  point: TerrainRoutePoint,
  mask: ReadonlySet<string>,
  width: number,
  height: number,
  targetWidth: number,
): number {
  let clearance = Number.POSITIVE_INFINITY
  for (const key of mask) {
    const [columnText, rowText] = key.split(':')
    const column = Number(columnText)
    const row = Number(rowText)
    const exposed = [
      { dx: 0, dy: -1, start: { x: column, y: row }, end: { x: column + 1, y: row } },
      {
        dx: 1,
        dy: 0,
        start: { x: column + 1, y: row },
        end: { x: column + 1, y: row + 1 },
      },
      {
        dx: 0,
        dy: 1,
        start: { x: column + 1, y: row + 1 },
        end: { x: column, y: row + 1 },
      },
      { dx: -1, dy: 0, start: { x: column, y: row + 1 }, end: { x: column, y: row } },
    ] as const
    for (const edge of exposed) {
      if (mask.has(cellKey(column + edge.dx, row + edge.dy))) continue
      const onMapPortal =
        (edge.dx === -1 && column === 0) ||
        (edge.dx === 1 && column === width - 1) ||
        (edge.dy === -1 && row === 0) ||
        (edge.dy === 1 && row === height - 1)
      if (onMapPortal) continue
      clearance = Math.min(clearance, distanceToSegment(point, edge.start, edge.end))
    }
  }
  return Math.min(targetWidth, clearance * 2)
}

function distanceToSegment(
  point: TerrainRoutePoint,
  start: TerrainRoutePoint,
  end: TerrainRoutePoint,
): number {
  const closest = closestPointOnSegment(point, start, end)
  return Math.hypot(point.x - closest.x, point.y - closest.y)
}

/** Return the width guaranteed by the segment strokes used by roadGuideMask. */
export function roadMaskWidthAt(
  point: TerrainRoutePoint,
  guide: readonly TerrainRoadGuidePoint[],
): number {
  let width = required(guide[0], 'Road guide is empty.').widthCells
  let closestDistance = Number.POSITIVE_INFINITY
  for (let index = 1; index < guide.length; index += 1) {
    const start = required(guide[index - 1], 'Road guide segment start is missing.')
    const end = required(guide[index], 'Road guide segment end is missing.')
    const dx = end.x - start.x
    const dy = end.y - start.y
    const lengthSquared = dx * dx + dy * dy
    const amount =
      lengthSquared <= EPSILON
        ? 0
        : Math.max(
            0,
            Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
          )
    const candidate = { x: start.x + dx * amount, y: start.y + dy * amount }
    const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2
    if (distance + EPSILON >= closestDistance) continue
    closestDistance = distance
    width = Math.min(start.widthCells, end.widthCells)
  }
  return width
}

/** Find the nearest point on a road guide. */
export function closestPointOnGuide(
  point: TerrainRoutePoint,
  guide: readonly TerrainRoadGuidePoint[],
): TerrainRoutePoint {
  let closest: TerrainRoutePoint = required(guide[0], 'Road guide is empty.')
  let closestDistance = Number.POSITIVE_INFINITY
  for (let index = 1; index < guide.length; index += 1) {
    const candidate = closestPointOnSegment(
      point,
      required(guide[index - 1], 'Previous road guide point is missing.'),
      required(guide[index], 'Road guide point is missing.'),
    )
    const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2
    if (distance + EPSILON < closestDistance) {
      closest = candidate
      closestDistance = distance
    }
  }
  return closest
}

function closestPointOnSegment(
  point: TerrainRoutePoint,
  start: TerrainRoutePoint,
  end: TerrainRoutePoint,
): TerrainRoutePoint {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return start
  const amount = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  )
  return { x: start.x + dx * amount, y: start.y + dy * amount }
}
