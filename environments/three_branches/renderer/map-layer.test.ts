import { AlphaFilter, Container, FillPattern, Graphics, Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import {
  bridgeDeckMask,
  componentPaths,
  drawMap,
  exactTerrainGrid,
  materialLayerAlpha,
  ownedTerrainView,
  pathGuideGraphics,
  reedMarksGraphics,
  roadGuideGraphics,
  seamStrokeRuns,
  signedComponentPath,
} from './map-layer.js'
import { HEARTHSIDE_STYLE } from './presentation.js'
import {
  BRIDGE_PLANK_CODES,
  PATTERN_MATERIALS,
  plankRowsFor,
  type TerrainArt,
} from './terrain-art.js'
import {
  planTerrainContours,
} from './terrain-contours.js'
import { planTerrainRoutes } from './terrain-routes.js'
import type { StaticScene, TerrainContourPoint, TerrainRoutePlan } from './types.js'

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

function shorelinePoint(x: number, factor: number): TerrainContourPoint {
  return { x, y: 0, rawOffset: x, locked: false, shorelineFactor: factor }
}

function routePlan(rows: readonly string[]): TerrainRoutePlan {
  return planTerrainRoutes(rows, names, HEARTHSIDE_STYLE.terrain.routes)
}

function sparseLayerFixture(): { scene: StaticScene; art: TerrainArt } {
  const rows = ['ggggg', 'rrbrr', 'fepdi', 'xxxxx']
  const ground = Object.entries(names).map(([code, name]) => ({
    code,
    name,
    color: '#000000',
    passable: true,
    layer:
      name === 'ground'
        ? ('base' as const)
        : ['interior', 'doorway', 'wall'].includes(name)
          ? ('structure' as const)
          : ('landscape' as const),
  }))
  const scene: StaticScene = {
    village: {
      size: { cellsX: 5, cellsY: 4, cellSize: 1 },
      ground: rows,
      buildings: [],
      props: [],
      scenery: [],
      spawn: { x: 0, y: 0 },
    },
    world: { width: 5, height: 4 },
    spawn: { x: 0, y: 0 },
    ground,
    groundByCode: Object.fromEntries(ground.map((item) => [item.code, item])),
    topFirstRows: rows,
    buildings: [],
    props: [],
    scenery: [],
  }
  const textures = Object.fromEntries(
    [...Object.keys(names), ...Object.values(BRIDGE_PLANK_CODES)].map((code) => [
      code,
      Texture.EMPTY,
    ]),
  )
  const routes = routePlan(rows)
  const art: TerrainArt = {
    tileset: { tileSize: 1, textures },
    variant: () => 0,
    patterns: {
      ...Object.fromEntries(PATTERN_MATERIALS.map((material) => [material, Texture.WHITE])),
      ink: Texture.WHITE,
    },
    routes,
    contours: planTerrainContours(
      routes.visualRows,
      names,
      HEARTHSIDE_STYLE.terrain.contours,
      HEARTHSIDE_STYLE.terrain.seams.waterHatch.bridgeTaperCells,
    ),
    plankLayer: { columns: 5, rows: plankRowsFor(routes) },
    upperWallTileset: { tileSize: 1, textures: { U: Texture.EMPTY, '.': Texture.EMPTY } },
    upperWallGrid: { columns: 5, rows: ['     ', '     ', '     ', 'UUUUU'] },
    upperWallVariant: () => 0,
  }
  return { scene, art }
}

describe('Three Branches map layer', () => {
  it('keeps architectural cells exact and out of natural sparse coverage', () => {
    expect(exactTerrainGrid(['gidwx', 'gixdg'], names, ['interior', 'doorway', 'wall'])).toEqual({
      columns: 5,
      rows: [' id x', ' ixd '],
    })
  })

  it('retains the configured terrain layer alpha', () => {
    expect(materialLayerAlpha('field')).toBe(1)
    expect(materialLayerAlpha('reeds')).toBe(1)
    expect(materialLayerAlpha('water')).toBe(1)
    expect(materialLayerAlpha('path')).toBe(1)
    expect(materialLayerAlpha('road')).toBe(0.82)
  })

  it('owns ordered named surfaces at each configured layer alpha', () => {
    const { scene, art } = sparseLayerFixture()
    const terrain = drawMap(new Container(), scene, art)
    const labels = terrain.view.children.map((child) => child.label)
    const expectedLabels = [
      'terrain-ground',
      'terrain-field',
      'terrain-reeds',
      'terrain-water',
      'terrain-seam-pooling',
      'terrain-reed-marks',
      'terrain-seam-ink',
      'terrain-seam-hatch',
      'terrain-seam-cover',
      'terrain-path',
      'terrain-road',
      'terrain-structures',
      'terrain-planks',
    ]

    expect(labels.filter((label) => label !== undefined && !label.endsWith('-mask'))).toEqual(
      expectedLabels,
    )
    const cover = required(
      terrain.view.getChildByLabel('terrain-seam-cover'),
      'Seam cover is missing.',
    )
    for (const label of [
      'terrain-seam-pooling',
      'terrain-reed-marks',
      'terrain-seam-ink',
      'terrain-seam-hatch',
    ] as const) {
      const seam = required(terrain.view.getChildByLabel(label), `${label} layer is missing.`)
      expect(seam.mask).toBe(cover)
    }
    expect(
      required(terrain.view.getChildByLabel('terrain-ground'), 'Ground layer is missing.').alpha,
    ).toBe(1)
    for (const material of ['field', 'reeds', 'water'] as const) {
      expect(
        required(
          terrain.view.getChildByLabel(`terrain-${material}`),
          `${material} layer is missing.`,
        ).alpha,
      ).toBe(materialLayerAlpha(material))
    }
    expect(
      required(terrain.view.getChildByLabel('terrain-path'), 'Path layer is missing.').alpha,
    ).toBe(materialLayerAlpha('path'))

    const road = required(
      terrain.view.getChildByLabel('terrain-road'),
      'Road layer is missing.',
    ) as Graphics
    expect(road.alpha).toBe(1)
    const roadFilters = (road.filters ?? []) as AlphaFilter[]
    expect(roadFilters).toHaveLength(1)
    expect(roadFilters[0]).toBeInstanceOf(AlphaFilter)
    expect(roadFilters[0]?.alpha).toBe(materialLayerAlpha('road'))
    terrain.destroy()
  })

  it('draws deterministic reed mark strokes only where the ground grid has reeds', () => {
    const strokeCount = (graphic: Graphics): number =>
      graphic.context.instructions.filter((instruction) => instruction.action === 'stroke').length

    const withReeds = reedMarksGraphics(['ge', 'gg'], names, 16)
    const withReedsAgain = reedMarksGraphics(['ge', 'gg'], names, 16)
    expect(strokeCount(withReeds)).toBeGreaterThan(0)
    expect(strokeCount(withReeds)).toBe(strokeCount(withReedsAgain))
    expect(withReeds.getLocalBounds()).toEqual(withReedsAgain.getLocalBounds())
    withReeds.destroy()
    withReedsAgain.destroy()

    const withoutReeds = reedMarksGraphics(['gg', 'gg'], names, 16)
    expect(strokeCount(withoutReeds)).toBe(0)
    withoutReeds.destroy()
  })

  it('uses one signed component path for direct holes and a separate island', () => {
    const plan = planTerrainContours(
      ['ggggg', 'gwwwg', 'gwgwg', 'gwwwg', 'ggggg'],
      names,
      HEARTHSIDE_STYLE.terrain.contours,
      HEARTHSIDE_STYLE.terrain.seams.waterHatch.bridgeTaperCells,
    )
    const outer = required(
      plan.components.find(
        (component) => component.material === 'ground' && component.holeRingIds.length === 1,
      ),
      'Outer ground component is missing.',
    )
    const island = required(
      plan.components.find(
        (component) => component.material === 'ground' && component.cellCount === 1,
      ),
      'Ground island is missing.',
    )
    const rings = new Map(plan.rings.map((ring) => [ring.id, ring]))
    const outerRing = required(rings.get(outer.outerRingId), 'Outer ring is missing.')
    const directHole = required(
      rings.get(required(outer.holeRingIds[0], 'Hole id is missing.')),
      'Direct hole ring is missing.',
    )
    const path = signedComponentPath(outerRing, [directHole], 16)
    expect(path.checkForHoles).toBe(true)
    expect(
      path.instructions.filter((instruction) => instruction.action === 'closePath'),
    ).toHaveLength(2)

    const paths = componentPaths(plan, 'ground', 16)
    const closeCounts = paths
      .map(
        (entry) =>
          entry.instructions.filter((instruction) => instruction.action === 'closePath').length,
      )
      .sort()
    expect(paths).toHaveLength(2)
    expect(closeCounts).toEqual([1, 2])
    expect(paths.every((entry) => entry.checkForHoles)).toBe(true)
  })

  it('breaks a seam into deterministic runs that repeat for the same chain and tag', () => {
    const points = Array.from({ length: 11 }, (_, x) => shorelinePoint(x, 1))
    const chain = { id: 'bank', closed: false, rawLength: 10, points, shorelineSpans: [] }
    const spec = { opacity: 0.7, density: 0.85, runLengthCells: [4, 9] as [number, number] }
    const first = seamStrokeRuns(chain, spec, 'seam-ink')
    const second = seamStrokeRuns(chain, spec, 'seam-ink')
    const visibleLength = first.reduce((total, run) => {
      const start = run.points[0]
      const end = run.points.at(-1)
      return start === undefined || end === undefined
        ? total
        : total + (end.rawOffset - start.rawOffset)
    }, 0)

    expect(first).toEqual(second)
    expect(first.length).toBeGreaterThan(1)
    expect(visibleLength).toBeGreaterThan(0)
    expect(visibleLength).toBeLessThan(chain.rawLength)
  })

  it('holds full opacity on a land-land seam and tapers only where the chain has shoreline spans', () => {
    const spec = { opacity: 0.2, density: 1, runLengthCells: [2, 2] as [number, number] }
    const flatChain = {
      id: 'land-land',
      closed: false,
      rawLength: 10,
      points: Array.from({ length: 11 }, (_, x) => shorelinePoint(x, 1)),
      shorelineSpans: [],
    }
    const flatRuns = seamStrokeRuns(flatChain, spec, 'seam-ink')
    expect(flatRuns.length).toBeGreaterThan(0)
    expect(flatRuns.every((run) => run.alpha === 0.2)).toBe(true)

    const taperedChain = {
      id: 'taper',
      closed: false,
      rawLength: 10,
      points: [
        shorelinePoint(0, 1),
        shorelinePoint(4, 0.5),
        shorelinePoint(5, 0),
        shorelinePoint(6, 0.5),
        shorelinePoint(10, 1),
      ],
      shorelineSpans: [{ startOffset: 0, endOffset: 10, waterSemantics: [], suppressed: false }],
    }
    const taperRuns = seamStrokeRuns(taperedChain, spec, 'seam-ink')
    expect(taperRuns.every((run) => run.alpha > 0 && run.alpha <= 0.2)).toBe(true)
    expect(taperRuns.some((run) => run.alpha < 0.2)).toBe(true)
  })

  it('strokes the road and path guides with their configured pattern fills', () => {
    const { art } = sparseLayerFixture()
    const fill = new FillPattern(Texture.WHITE, 'repeat')
    const road = roadGuideGraphics(art.routes, 16, fill)
    const path = pathGuideGraphics(art.routes, 16, fill)

    expect(road.context.instructions.some((instruction) => instruction.action === 'stroke')).toBe(
      true,
    )
    expect(path.context.instructions.some((instruction) => instruction.action === 'stroke')).toBe(
      true,
    )
    road.destroy()
    path.destroy()
  })

  it('renders opposite path terminals as one continuous stroke beneath the road', () => {
    const routes = routePlan(['gggpggg', 'gggpggg', 'rrrrrrr', 'rrrrrrr', 'gggpggg', 'gggpggg'])
    const fill = new FillPattern(Texture.WHITE, 'repeat')
    const path = pathGuideGraphics(routes, 16, fill)
    const strokes = path.context.instructions.filter(
      (instruction) => instruction.action === 'stroke',
    )

    expect(routes.pathConnectors).toHaveLength(1)
    expect(routes.pathGuides).toHaveLength(1)
    expect(strokes).toHaveLength(1)
    path.destroy()
  })

  it('renders an offset two-sided road crossing without a separate contact lobe', () => {
    const routes = routePlan([
      'ggpgggg',
      'ggpgggg',
      'rrprrrr',
      'rrrrrrr',
      'rrrrrrr',
      'gggppgg',
      'gggpggg',
      'gggpggg',
    ])
    const fill = new FillPattern(Texture.WHITE, 'repeat')
    const path = pathGuideGraphics(routes, 16, fill)
    const strokes = path.context.instructions.filter(
      (instruction) => instruction.action === 'stroke',
    )

    expect(routes.pathConnectors).toHaveLength(1)
    expect(routes.pathConnectors[0]?.absorbedPathCells).toEqual([{ column: 4, row: 5 }])
    expect(routes.pathGuides).toHaveLength(1)
    expect(strokes).toHaveLength(1)
    path.destroy()
  })

  it('clips oriented and compact bridge components to their configured deck widths', () => {
    const roadRoutes = routePlan(['ggggg', 'rrbrr', 'ggpgg'])
    const pathRoutes = routePlan(['rrrrr', 'ggpgg', 'ggbgg', 'ggpgg'])
    const compactRoutes = routePlan(['rrrrr', 'ggpgg', 'gpbpg', 'ggpgg'])
    const roadBridge = required(roadRoutes.bridgeComponents[0], 'Road bridge is missing.')
    const pathBridge = required(pathRoutes.bridgeComponents[0], 'Path bridge is missing.')
    const compactBridge = required(compactRoutes.bridgeComponents[0], 'Compact bridge is missing.')

    const mask = bridgeDeckMask([roadBridge, pathBridge, compactBridge], 16)
    expect(
      mask.context.instructions.filter((instruction) => instruction.action === 'stroke'),
    ).toHaveLength(2)
    expect(
      mask.context.instructions.filter((instruction) => instruction.action === 'fill'),
    ).toHaveLength(1)
    mask.destroy()
  })
  it('covers every cell of a tied multi-cell compact bridge mask', () => {
    const routes = routePlan(['rrrrrr', 'ggppgg', 'gpbbpg', 'gpbbpg', 'ggppgg', 'gggggg'])
    const bridge = required(routes.bridgeComponents[0], 'Tied bridge is missing.')
    const mask = bridgeDeckMask([bridge], 16)
    const fills = mask.context.instructions.filter((instruction) => instruction.action === 'fill')
    const bounds = mask.getLocalBounds()

    expect(bridge.orientation).toBe('compact')
    expect(fills).toHaveLength(4)
    expect(bounds).toMatchObject({ x: 32, y: 32, width: 32, height: 32 })
    mask.destroy()
  })

  it('releases each terrain child and graphic at most once', () => {
    const owner = new Container()
    const child = new Container()
    const graphic = new Graphics()
    let releases = 0
    owner.addChild(child, graphic)
    const terrain = ownedTerrainView(
      owner,
      [
        {
          view: child,
          span: { width: 16, height: 16 },
          destroy() {
            releases += 1
            child.destroy({ children: true })
          },
        },
      ],
      [graphic],
      { width: 16, height: 16 },
    )
    terrain.destroy()
    terrain.destroy()
    expect(releases).toBe(1)
    expect(graphic.destroyed).toBe(true)
  })

})

function required<Value>(value: Value | null | undefined, message: string): Value {
  if (value === undefined || value === null) throw new Error(message)
  return value
}
