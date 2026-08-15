import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TERRAIN_ROUTE_SETTINGS,
  planTerrainRoutes,
} from './terrain-routes.js'
import { roadMaskWidthAt } from './terrain-route-road.js'
import type { TerrainRoadGuidePoint, TerrainRouteSettings } from './types.js'

const NAMES = {
  g: 'ground',
  f: 'field',
  e: 'reeds',
  r: 'road',
  p: 'path',
  b: 'bridge',
  w: 'water',
  i: 'interior',
  d: 'doorway',
  x: 'wall',
} as const

const SETTINGS: TerrainRouteSettings = DEFAULT_TERRAIN_ROUTE_SETTINGS
const RAW_SETTINGS: TerrainRouteSettings = {
  ...SETTINGS,
  road: {
    ...SETTINGS.road,
    curve: { ...SETTINGS.road.curve, smoothingPasses: 0, octaves: [] },
  },
  path: {
    ...SETTINGS.path,
    curve: { ...SETTINGS.path.curve, smoothingPasses: 0, octaves: [] },
  },
}
const NO_NOISE_SETTINGS: TerrainRouteSettings = {
  ...SETTINGS,
  road: {
    ...SETTINGS.road,
    curve: { ...SETTINGS.road.curve, octaves: [] },
  },
  path: {
    ...SETTINGS.path,
    curve: { ...SETTINGS.path.curve, octaves: [] },
  },
}

describe('terrain route planner', () => {
  it('propagates the nearest natural substrate through road cells with canonical tie breaks', () => {
    const plan = planTerrainRoutes(['ggggg', 'rrrrr', 'fffff'], NAMES, SETTINGS)
    const roadSubstrate = plan.visualSubstrate.filter(
      (cell) => cell.replacedMaterial === 'road',
    )

    expect(plan.visualRows).toEqual(['ggggg', 'ggggg', 'fffff'])
    expect(roadSubstrate).toHaveLength(5)
    expect(roadSubstrate.every((cell) => cell.sourceMaterial === 'ground')).toBe(true)
    expect(roadSubstrate.map((cell) => cell.distance)).toEqual([1, 1, 1, 1, 1])
    expect(new Set(roadSubstrate.map((cell) => cell.sourceComponentId))).toEqual(
      new Set(['substrate-0-0-ground']),
    )
  })

  it('propagates only through each eight-neighbor road component', () => {
    const plan = planTerrainRoutes(
      ['ggggggg', 'rrrrrrr', 'wwwwwww', 'eeerrre', 'eeeeeee'],
      NAMES,
      SETTINGS,
    )

    expect(plan.visualRows[1]).toBe('ggggggg')
    expect(plan.visualRows[3]).toBe('eeeeeee')
    expect(
      plan.visualSubstrate
        .filter((cell) => cell.replacedMaterial === 'road' && cell.row === 3)
        .every((cell) => cell.sourceMaterial === 'reeds'),
    ).toBe(true)
  })

  it('propagates natural substrate through paths while retaining bridge water semantics', () => {
    const rows = ['ggggg', 'rrrrr', 'ppbpp', 'fffff']
    const plan = planTerrainRoutes(rows, NAMES, SETTINGS)

    expect(plan.visualRows[2]).toBe('ffbff')
    expect(plan.visualRows.join('')).not.toContain('p')
    expect(plan.visualRows.join('')).toContain('b')
    expect(plan.visualSubstrate.filter((cell) => cell.replacedMaterial === 'path')).toHaveLength(4)
  })

  it('chooses the smooth northern road run after cost and overlap ties', () => {
    const plan = planTerrainRoutes(
      ['gggggg', 'rrrrrr', 'gggggg', 'gggggg', 'rrrrrr', 'ffffff'],
      NAMES,
      SETTINGS,
    )

    expect(plan.roadGuide.every((point) => point.rawY === 1.5)).toBe(true)
    expect(plan.roadGuide[0]).toMatchObject({ locked: true, anchor: 'map', x: 0.5, y: 1.5 })
    expect(plan.roadGuide.at(-1)).toMatchObject({ locked: true, anchor: 'map', x: 5.5, y: 1.5 })
  })

  it('uses overlap as the second road-run decision after squared movement', () => {
    const plan = planTerrainRoutes(
      ['ggrrg', 'rrrrr', 'rrrrr', 'rrrrr', 'rrrrr', 'ggrrg', 'fffff'],
      NAMES,
      RAW_SETTINGS,
    )

    expect(plan.roadGuide.every((point) => point.rawY === 3)).toBe(true)
  })

  it('rejects diagonal-only road runs even when every column contains a road cell', () => {
    expect(() =>
      planTerrainRoutes(
        ['rgggg', 'grggg', 'ggrrg', 'gggrg', 'ggggr', 'fffff'],
        NAMES,
        RAW_SETTINGS,
      ),
    ).toThrow('no cardinally continuous west-to-east component')
  })

  it('keeps map entrances and horizontal bridge axes exact while fairing free points', () => {
    const plan = planTerrainRoutes(['ggggggg', 'rrrbbrr', 'ggggggg'], NAMES, NO_NOISE_SETTINGS)

    expect(plan.roadGuide[0]).toMatchObject({ anchor: 'map', locked: true, x: 0.5, y: 1.5 })
    expect(plan.roadGuide.filter((point) => point.anchor === 'bridge')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ locked: true, x: 3.5, y: 1.5 }),
        expect.objectContaining({ locked: true, x: 4.5, y: 1.5 }),
      ]),
    )
    expect(plan.roadGuide.at(-1)).toMatchObject({ anchor: 'map', locked: true, x: 6.5, y: 1.5 })
  })

  it('fairs a bent route deterministically and retains every point inside its source footprint', () => {
    const rows = roadBandRows([3, 3, 3, 2, 2, 2, 3, 3, 3], 7)
    const first = planTerrainRoutes(rows, NAMES, SETTINGS)
    expect(first.roadGuide.some((point) => !point.locked && point.y !== point.rawY)).toBe(true)
    for (const point of first.roadGuide) {
      expect(first.roadMaskCells).toContainEqual({
        column: Math.floor(point.x),
        row: Math.floor(point.y),
      })
    }
  })

  it('falls back locally to the raw guide when fairing leaves a narrow source run', () => {
    const plan = planTerrainRoutes(roadBandRows([1, 1, 1, 1, 1], 3, 1), NAMES, NO_NOISE_SETTINGS)

    expect(plan.roadGuide.some((point) => point.fellBack)).toBe(true)
    expect(
      plan.roadGuide.every((point) => point.widthCells >= SETTINGS.road.minimumWidthCells),
    ).toBe(true)
    for (const point of plan.roadGuide.filter((point) => point.fellBack)) {
      expect(point).toMatchObject({ x: point.rawX, y: point.rawY })
    }
  })

  it('classifies mixed horizontal bridge contacts as road-owned', () => {
    const plan = planTerrainRoutes(['rrrrr', 'ggggg', 'grbpg', 'ggpgg', 'ggggg'], NAMES, SETTINGS)
    const bridge = only(plan.bridgeComponents)

    expect(bridge).toMatchObject({
      owner: 'road',
      orientation: 'horizontal',
      portals: [
        { x: 2, y: 2.5 },
        { x: 3, y: 2.5 },
      ],
      deck: { kind: 'axis', widthCells: 2.1, cap: 'square' },
    })
    expect(bridge.contacts.map((contact) => contact.owner).sort()).toEqual(['path', 'path', 'road'])
  })

  it('makes a vertical path bridge narrow with exact portal endpoints', () => {
    const plan = planTerrainRoutes(['rrrrr', 'ggpgg', 'ggbgg', 'ggpgg', 'ggggg'], NAMES, SETTINGS)
    const bridge = only(plan.bridgeComponents)

    expect(bridge.owner).toBe('path')
    expect(bridge.orientation).toBe('vertical')
    expect(bridge.portals).toEqual([
      { x: 2.5, y: 2 },
      { x: 2.5, y: 3 },
    ])
    expect(bridge.deck).toMatchObject({ kind: 'axis', widthCells: 0.7, cap: 'square' })
  })

  it('uses a centered rounded compact deck for a tied component', () => {
    const plan = planTerrainRoutes(['rrrrr', 'ggpgg', 'gpbpg', 'ggpgg', 'ggggg'], NAMES, SETTINGS)
    const bridge = only(plan.bridgeComponents)

    expect(bridge.orientation).toBe('compact')
    expect(bridge.owner).toBe('path')
    expect(bridge.portals).toEqual([])
    expect(bridge.deck).toEqual({
      kind: 'compact',
      widthCells: 0.7,
      cap: 'round',
      center: { x: 2.5, y: 2.5 },
    })
  })

  it('derives deck widths from their authoritative route widths', () => {
    const settings: TerrainRouteSettings = {
      ...SETTINGS,
      road: { ...SETTINGS.road, targetWidthCells: 1.9 },
      path: { ...SETTINGS.path, widthCells: 0.6 },
    }
    const roadBridge = only(
      planTerrainRoutes(['rrrrr', 'rrbrr', 'ggggg'], NAMES, settings).bridgeComponents,
    )
    const pathBridge = only(
      planTerrainRoutes(['rrrrr', 'ggpgg', 'ggbgg', 'ggpgg'], NAMES, settings).bridgeComponents,
    )

    expect(roadBridge.deck.widthCells).toBe(1.9)
    expect(pathBridge.deck.widthCells).toBe(0.6)
  })

  it('keeps a tied two-by-two bridge as one complete compact component', () => {
    const plan = planTerrainRoutes(
      ['rrrrrr', 'ggppgg', 'gpbbpg', 'gpbbpg', 'ggppgg', 'gggggg'],
      NAMES,
      SETTINGS,
    )
    const bridge = only(plan.bridgeComponents)

    expect(bridge.orientation).toBe('compact')
    expect(bridge.cells).toEqual([
      { column: 2, row: 2 },
      { column: 3, row: 2 },
      { column: 2, row: 3 },
      { column: 3, row: 3 },
    ])
  })

  it('connects every cardinal path contact to the faired road guide at path width', () => {
    const plan = planTerrainRoutes(['ggggg', 'ggpgg', 'rrrrr', 'ggggg'], NAMES, NO_NOISE_SETTINGS)

    expect(plan.pathConnectors).toHaveLength(1)
    expect(plan.pathConnectors[0]).toMatchObject({
      id: 'path-connector-0',
      pathCell: { column: 2, row: 1 },
      roadCell: { column: 2, row: 2 },
      start: { x: 2.5, y: 1.5 },
      end: { x: 2.5, y: 2.95 },
      widthCells: 0.7,
    })
    expect(plan.roadGuide.find((point) => point.column === 2)?.widthCells).toBeCloseTo(1.6)
  })

  it('uses the rendered segment minimum across a long road-width transition', () => {
    const guide = [roadPoint(0, 1.6), roadPoint(8, 2.1)] satisfies readonly TerrainRoadGuidePoint[]

    expect(roadMaskWidthAt({ x: 4, y: 2 }, guide)).toBe(1.6)
    expect(roadMaskWidthAt({ x: 7.5, y: 2 }, guide)).toBe(1.6)
  })

  it('splits a branched path graph into deterministic junction chains', () => {
    const rows = ['rrrrrrr', 'ggggggg', 'gggpggg', 'ggpppgg', 'gggpggg', 'ggggggg']
    const first = planTerrainRoutes(rows, NAMES, SETTINGS)
    expect(first.pathGuides).toHaveLength(4)
    expect(
      first.pathGuides.every((guide) =>
        guide.points.some((point) => point.anchor === 'junction' && point.locked),
      ),
    ).toBe(true)
  })

  it('emits a canonical closed guide for a path cycle', () => {
    const plan = planTerrainRoutes(
      ['rrrrrr', 'gggggg', 'gppppg', 'gpggpg', 'gppppg', 'gggggg'],
      NAMES,
      SETTINGS,
    )
    const cycle = only(plan.pathGuides)

    expect(cycle.closed).toBe(true)
    expect(cycle.points.length).toBeGreaterThan(8)
    expect(cycle.points[0]).not.toMatchObject(cycle.points.at(-1) ?? {})
  })

  it('locks a path-owned bridge axis into its traversing guide', () => {
    const plan = planTerrainRoutes(['rrrrr', 'ggpgg', 'ggbgg', 'ggpgg', 'ggggg'], NAMES, SETTINGS)
    const bridgePoints = plan.pathGuides
      .flatMap((guide) => guide.points)
      .filter((point) => point.anchor === 'bridge')

    expect(bridgePoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x: 2.5, y: 2, locked: true }),
        expect.objectContaining({ x: 2.5, y: 3, locked: true }),
      ]),
    )
  })

  it('collapses a two-cell corner contact onto its aligned road terminal', () => {
    const plan = planTerrainRoutes(
      ['ggggg', 'gpggg', 'gppgg', 'rrrrr', 'ggggg'],
      NAMES,
      NO_NOISE_SETTINGS,
    )
    const connector = only(plan.pathConnectors)

    expect(connector.pathCell).toEqual({ column: 1, row: 2 })
    expect(connector.absorbedPathCells).toEqual([{ column: 2, row: 2 }])
    expect(connector.start).toEqual({ x: 1.5, y: 2.5 })
    expect(connector.end.y).toBeCloseTo(3.95)
    expect(connector.end.y).toBeGreaterThan(3.5)
  })

  it('uses one aligned terminal through an orthogonal inside road corner', () => {
    const plan = planTerrainRoutes(
      ['gggpggg', 'gggpggg', 'rrrprrr', 'rrrrrrr', 'ggggggg'],
      NAMES,
      NO_NOISE_SETTINGS,
    )
    const connector = only(plan.pathConnectors)
    const center = verticalGuideIntersection(connector.start.x, plan.roadGuide)
    const incoming = { x: 0, y: 1 }
    const terminal = {
      x: connector.end.x - connector.start.x,
      y: connector.end.y - connector.start.y,
    }

    expect(connector.roadCell).toEqual({ column: 3, row: 3 })
    expect(terminal.x * incoming.y - terminal.y * incoming.x).toBeCloseTo(0)
    expect(terminal.x * incoming.x + terminal.y * incoming.y).toBeGreaterThan(0)
    expect(connector.end.x).toBeCloseTo(connector.start.x)
    const localRoadPoint = plan.roadGuide.find(
      (point) => point.column === connector.roadCell.column,
    )
    expect(localRoadPoint).toBeDefined()
    const localRoadWidth = localRoadPoint?.widthCells ?? Number.NaN
    expect(connector.end.y - center.y).toBeCloseTo(
      localRoadWidth / 2 - SETTINGS.path.widthCells / 2,
    )
    expect(connector.end.y - center.y + SETTINGS.path.widthCells / 2).toBeCloseTo(
      localRoadWidth / 2,
    )
  })

  it('joins opposite path terminals into one straight road crossing', () => {
    const rows = ['gggpggg', 'gggpggg', 'rrrrrrr', 'rrrrrrr', 'gggpggg', 'gggpggg']
    const plan = planTerrainRoutes(rows, NAMES, SETTINGS)
    const connector = only(plan.pathConnectors)
    const guide = only(plan.pathGuides)
    const crossingPoints = guide.points.filter((point) => point.y >= 1.5 && point.y <= 4.5)

    expect(connector).toMatchObject({
      pathCell: { column: 3, row: 1 },
      oppositePathCell: { column: 3, row: 4 },
      start: { x: 3.5, y: 1.5 },
      end: { x: 3.5, y: 4.5 },
    })
    expect(crossingPoints.length).toBeGreaterThan(2)
    expect(crossingPoints.every((point) => point.x === 3.5 && point.anchor === 'road')).toBe(true)
  })

  it('joins offset opposite terminals and absorbs a redundant contact lobe', () => {
    const rows = [
      'ggpgggg',
      'ggpgggg',
      'rrprrrr',
      'rrrrrrr',
      'rrrrrrr',
      'gggppgg',
      'gggpggg',
      'gggpggg',
    ]
    const plan = planTerrainRoutes(rows, NAMES, SETTINGS)
    const connector = only(plan.pathConnectors)
    const guide = only(plan.pathGuides)
    const firstVia = connector.via?.[0]
    const lastVia = connector.via?.at(-1)

    expect(connector).toMatchObject({
      pathCell: { column: 2, row: 2 },
      oppositePathCell: { column: 3, row: 5 },
      absorbedPathCells: [{ column: 4, row: 5 }],
    })
    expect(firstVia?.x).toBe(connector.start.x)
    expect(lastVia?.x).toBe(connector.end.x)
    expect(
      guide.points.some(
        (point) => Math.abs(point.x - 4.5) < 1e-9 && Math.abs(point.y - 5.5) < 1e-9,
      ),
    ).toBe(false)
    expect(
      guide.points
        .filter((point) => point.y >= connector.start.y && point.y <= connector.end.y)
        .every((point) => point.anchor === 'road' && point.locked),
    ).toBe(true)
  })

  it('keeps disconnected bridge components canonical and deterministic', () => {
    const rows = ['rrrrrrr', 'gbgggbg', 'gpgggpg', 'ggggggg']
    const first = planTerrainRoutes(rows, NAMES, SETTINGS)
    const second = planTerrainRoutes(rows, NAMES, SETTINGS)

    expect(first).toEqual(second)
    expect(first.bridgeComponents.map((component) => component.id)).toEqual([
      'bridge-1-1',
      'bridge-1-5',
    ])
  })

  it('rejects a disconnected road which cannot produce a west-east guide', () => {
    expect(() => planTerrainRoutes(['ggrgg', 'ggrgg', 'ggrgg', 'fffff'], NAMES, SETTINGS)).toThrow(
      'inset road route does not span column 0',
    )
  })

  it('rejects a road component without a natural substrate source', () => {
    expect(() => planTerrainRoutes(['rrrrr', 'wwwww'], NAMES, SETTINGS)).toThrow(
      'has no ground, field, or reeds substrate source',
    )
  })

  it('supports terrain with no road and emits empty route artifacts', () => {
    const plan = planTerrainRoutes(['ggg', 'gpg', 'gbg'], NAMES, SETTINGS)

    expect(plan.visualSubstrate.filter((cell) => cell.replacedMaterial === 'road')).toEqual([])
    expect(plan.roadGuide).toEqual([])
    expect(plan.roadMaskCells).toEqual([])
    expect(plan.pathConnectors).toEqual([])
    expect(plan.pathGuides).toHaveLength(1)
    expect(plan.visualRows).toEqual(['ggg', 'ggg', 'gbg'])
  })

  it('validates rectangular inputs and complete semantic mappings', () => {
    expect(() => planTerrainRoutes([], NAMES, SETTINGS)).toThrow('non-empty rectangular')
    expect(() => planTerrainRoutes(['gg', 'g'], NAMES, SETTINGS)).toThrow('non-empty rectangular')
    expect(() => planTerrainRoutes(['q'], NAMES, SETTINGS)).toThrow('has no ground name')
  })
})

function roadBandRows(centers: readonly number[], height: number, width = 3): readonly string[] {
  const rows = Array.from({ length: height }, () => Array(centers.length).fill('g') as string[])
  centers.forEach((center, column) => {
    const radius = Math.floor(width / 2)
    for (let row = center - radius; row <= center + radius; row += 1) {
      const target = rows[row]
      if (target === undefined) throw new Error('Road test band leaves its fixture.')
      target[column] = 'r'
    }
  })
  return rows.map((row) => row.join(''))
}

function only<Value>(values: readonly Value[]): Value {
  expect(values).toHaveLength(1)
  const value = values[0]
  if (value === undefined) throw new Error('Expected one test value.')
  return value
}

function roadPoint(x: number, widthCells: number): TerrainRoadGuidePoint {
  return {
    x,
    y: 2,
    rawX: x,
    rawY: 2,
    column: x,
    locked: false,
    anchor: null,
    fellBack: false,
    widthCells,
  }
}

function verticalGuideIntersection(
  x: number,
  guide: readonly { readonly x: number; readonly y: number }[],
): { readonly x: number; readonly y: number } {
  for (let index = 1; index < guide.length; index += 1) {
    const start = guide[index - 1]
    const end = guide[index]
    if (start === undefined || end === undefined) continue
    if (x < Math.min(start.x, end.x) || x > Math.max(start.x, end.x)) continue
    const amount = end.x === start.x ? 0 : (x - start.x) / (end.x - start.x)
    return { x, y: start.y + (end.y - start.y) * amount }
  }
  throw new Error('Expected the vertical terminal ray to intersect the road guide.')
}
