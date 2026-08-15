import { Container, Graphics, Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import {
  bridgeDeckMask,
  contourMask,
  drawMap,
  exactTerrainGrid,
  landContourMask,
  materialForGroundName,
  materialGridWithHalo,
  materialLayerAlpha,
  ownedTerrainView,
  pathGuideMask,
  plannedRouteTextureGrid,
  roadGuideMask,
  shorelineStrokeRuns,
  signedComponentPath,
  TERRAIN_LAYER_ORDER,
} from './map-layer.js'
import { HEARTHSIDE_STYLE } from './presentation.js'
import { BRIDGE_PLANK_CODES, plankRowsFor, type TerrainArt } from './terrain-art.js'
import {
  planTerrainContours,
  type TerrainContourPoint,
  terrainVariant,
} from './terrain-contours.js'
import { planTerrainRoutes, type TerrainRoutePlan } from './terrain-routes.js'
import type { StaticScene } from './types.js'

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
    routes,
    contours: planTerrainContours(
      routes.visualRows,
      names,
      HEARTHSIDE_STYLE.terrain.contours,
      HEARTHSIDE_STYLE.terrain.contours.shoreline.bridgeTaperCells,
    ),
    plankLayer: { columns: 5, rows: plankRowsFor(routes) },
    upperWallTileset: { tileSize: 1, textures: { U: Texture.EMPTY, '.': Texture.EMPTY } },
    upperWallGrid: { columns: 5, rows: ['     ', '     ', '     ', 'UUUUU'] },
    upperWallVariant: () => 0,
  }
  return { scene, art }
}

describe('Three Branches terrain art planning', () => {
  it('selects fill variants from stable ground code and coordinates', () => {
    expect(terrainVariant(4, 'g', 12, 7)).toBe(terrainVariant(4, 'g', 12, 7))
    expect(terrainVariant(4, 'g', 12, 7)).toBeLessThan(4)
    expect(terrainVariant(1, 'g', 99, 4)).toBe(0)
  })

  it('does not repeat fill variants on a four-cell lattice', () => {
    const grid = Array.from({ length: 8 }, (_, row) =>
      Array.from({ length: 8 }, (_, column) => terrainVariant(4, 'g', column, row)),
    )
    expect(new Set(grid.flat())).toEqual(new Set([0, 1, 2, 3]))
    expect(grid.slice(0, 4)).not.toEqual(grid.slice(4))
    expect(grid.every((row) => row.slice(0, 4).join('') !== row.slice(4).join(''))).toBe(true)
  })

  it('plans contours over the natural substrate while retaining bridge water semantics', () => {
    const rows = ['ggggg', 'rrbrr', 'ggpgg']
    const routes = routePlan(rows)
    const contours = planTerrainContours(
      routes.visualRows,
      names,
      HEARTHSIDE_STYLE.terrain.contours,
      HEARTHSIDE_STYLE.terrain.contours.shoreline.bridgeTaperCells,
    )

    expect(routes.visualRows.join('')).not.toContain('r')
    expect(routes.visualRows.join('')).not.toContain('p')
    expect(routes.visualRows[1]?.[2]).toBe('b')
    expect(contours.components.some((component) => component.material === 'road')).toBe(false)
    expect(contours.components.some((component) => component.material === 'path')).toBe(false)
    expect(contours.components.some((component) => component.material === 'water')).toBe(true)
  })

  it('uses one-cell Chebyshev halos while preserving source material codes', () => {
    const grid = materialGridWithHalo(['ggggg', 'ggbgg', 'ggggg'], names, 'water', 'w')
    expect(materialForGroundName('bridge')).toBe('water')
    expect(grid).toEqual({ columns: 5, rows: [' www ', ' wbw ', ' www '] })
  })

  it('keeps architectural cells exact and out of natural sparse coverage', () => {
    expect(exactTerrainGrid(['gidwx', 'gixdg'], names, ['interior', 'doorway', 'wall'])).toEqual({
      columns: 5,
      rows: [' id x', ' ixd '],
    })
    expect(materialGridWithHalo(['gidwx', 'gixdg'], names, 'water', 'w').rows).toEqual([
      '  www',
      '  www',
    ])
  })

  it('retains the approved terrain draw order and route alpha', () => {
    expect(TERRAIN_LAYER_ORDER).toEqual([
      'ground',
      'field',
      'reeds',
      'water',
      'shoreline',
      'path',
      'road',
      'structures',
      'planks',
    ])
    expect(materialLayerAlpha('field')).toBe(1)
    expect(materialLayerAlpha('reeds')).toBe(1)
    expect(materialLayerAlpha('water')).toBe(1)
    expect(materialLayerAlpha('path')).toBe(1)
    expect(materialLayerAlpha('road')).toBe(0.82)
  })

  it('owns ordered named surfaces without dimming the base terrain', () => {
    const { scene, art } = sparseLayerFixture()
    const terrain = drawMap(new Container(), scene, art)
    const surfaces = terrain.view.children
      .map((child) => child.label)
      .filter((label) => label !== undefined && !label.endsWith('-mask'))

    expect(surfaces).toEqual(TERRAIN_LAYER_ORDER.map((name) => `terrain-${name}`))
    expect(
      required(terrain.view.getChildByLabel('terrain-ground'), 'Ground layer is missing.').alpha,
    ).toBe(1)
    expect(
      required(terrain.view.getChildByLabel('terrain-road'), 'Road layer is missing.').alpha,
    ).toBe(0.82)
    terrain.destroy()
  })

  it('uses one signed component path for direct holes and a separate nested island', () => {
    const plan = planTerrainContours(
      ['ggggg', 'gwwwg', 'gwgwg', 'gwwwg', 'ggggg'],
      names,
      HEARTHSIDE_STYLE.terrain.contours,
      HEARTHSIDE_STYLE.terrain.contours.shoreline.bridgeTaperCells,
    )
    const outer = required(
      plan.components.find(
        (component) => component.material === 'ground' && component.holeRingIds.length === 1,
      ),
      'Outer ground component is missing.',
    )
    const island = required(
      plan.components.find(
        (component) => component.material === 'ground' && component.nestingDepth > 0,
      ),
      'Nested ground island is missing.',
    )
    expect(island.parentComponentId).toBeDefined()
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
    const mask = contourMask(plan, 'ground', 16)
    const fills = mask.context.instructions.filter((instruction) => instruction.action === 'fill')
    expect(fills).toHaveLength(2)
    mask.destroy()
  })

  it('builds the shoreline land mask from every non-water component', () => {
    const plan = planTerrainContours(
      ['ggggg', 'gwwwg', 'gwfwg', 'gwwwg', 'ggggg'],
      names,
      HEARTHSIDE_STYLE.terrain.contours,
      HEARTHSIDE_STYLE.terrain.contours.shoreline.bridgeTaperCells,
    )
    const mask = landContourMask(plan, 16)
    const fills = mask.context.instructions.filter((instruction) => instruction.action === 'fill')
    const landComponents = plan.components.filter(
      (component) => !component.exterior && component.material !== 'water',
    )

    expect(fills).toHaveLength(landComponents.length)
    mask.destroy()
  })

  it('breaks banks deterministically by arc offset and applies point taper alpha', () => {
    const points = Array.from({ length: 11 }, (_, x) => shorelinePoint(x, 1))
    const chain = { id: 'bank', closed: false, rawLength: 10, points }
    const band = HEARTHSIDE_STYLE.terrain.contours.shoreline.bands[0]
    const first = shorelineStrokeRuns(chain, band, 0)
    const second = shorelineStrokeRuns(chain, band, 0)
    const visibleLength = first.reduce((total, run) => {
      const start = run.points[0]
      const end = run.points.at(-1)
      return start === undefined || end === undefined
        ? total
        : total + end.rawOffset - start.rawOffset
    }, 0)

    expect(first).toEqual(second)
    expect(first.length).toBeGreaterThan(1)
    expect(visibleLength).toBeGreaterThan(0)
    expect(visibleLength).toBeLessThan(chain.rawLength)

    const taperRuns = shorelineStrokeRuns(
      {
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
      },
      { opacity: 0.2, density: 1, runLengthCells: [2, 2] },
    )
    expect(taperRuns.every((run) => run.alpha > 0 && run.alpha <= 0.2)).toBe(true)
    expect(taperRuns.some((run) => run.alpha < 0.2)).toBe(true)
  })

  it('strokes the road and path guides through repeated sparse textures', () => {
    const { art } = sparseLayerFixture()
    const road = roadGuideMask(art.routes, 16)
    const path = pathGuideMask(art.routes, 16)
    const pathGrid = plannedRouteTextureGrid(art.routes, 'path')

    expect(road.context.instructions.some((instruction) => instruction.action === 'stroke')).toBe(
      true,
    )
    expect(path.context.instructions.some((instruction) => instruction.action === 'stroke')).toBe(
      true,
    )
    for (const connector of art.routes.pathConnectors) {
      expect(pathGrid.rows[connector.pathCell.row]?.[connector.pathCell.column]).toBe('p')
      expect(pathGrid.rows[connector.roadCell.row]?.[connector.roadCell.column]).toBe(' ')
    }
    road.destroy()
    path.destroy()
  })

  it('renders opposite path terminals as one continuous stroke beneath the road', () => {
    const routes = routePlan(['gggpggg', 'gggpggg', 'rrrrrrr', 'rrrrrrr', 'gggpggg', 'gggpggg'])
    const mask = pathGuideMask(routes, 16)
    const strokes = mask.context.instructions.filter(
      (instruction) => instruction.action === 'stroke',
    )

    expect(routes.pathConnectors).toHaveLength(1)
    expect(routes.pathGuides).toHaveLength(1)
    expect(strokes).toHaveLength(1)
    expect(routes.pathTextureRows[2]?.slice(2, 5)).toBe('ppp')
    expect(routes.pathTextureRows[3]?.slice(2, 5)).toBe('ppp')
    mask.destroy()
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
    const mask = pathGuideMask(routes, 16)
    const strokes = mask.context.instructions.filter(
      (instruction) => instruction.action === 'stroke',
    )

    expect(routes.pathConnectors).toHaveLength(1)
    expect(routes.pathConnectors[0]?.absorbedPathCells).toEqual([{ column: 4, row: 5 }])
    expect(routes.pathGuides).toHaveLength(1)
    expect(strokes).toHaveLength(1)
    mask.destroy()
  })

  it('keeps bridge cells water-backed and absent from the road texture grid', () => {
    const { scene, art } = sparseLayerFixture()
    const road = exactTerrainGrid(scene.topFirstRows, names, ['road'])
    const water = materialGridWithHalo(art.routes.visualRows, names, 'water', 'w')

    expect(road.rows[1]).toBe('rr rr')
    expect(water.rows[1]?.[2]).toBe('b')
    expect(art.plankLayer.rows[1]?.[2]).toBe(BRIDGE_PLANK_CODES.horizontal)
  })

  it('clips oriented and compact plank components to their configured deck widths', () => {
    const roadRoutes = routePlan(['ggggg', 'rrbrr', 'ggpgg'])
    const pathRoutes = routePlan(['rrrrr', 'ggpgg', 'ggbgg', 'ggpgg'])
    const compactRoutes = routePlan(['rrrrr', 'ggpgg', 'gpbpg', 'ggpgg'])
    const roadBridge = required(roadRoutes.bridgeComponents[0], 'Road bridge is missing.')
    const pathBridge = required(pathRoutes.bridgeComponents[0], 'Path bridge is missing.')
    const compactBridge = required(compactRoutes.bridgeComponents[0], 'Compact bridge is missing.')

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

  it('keeps the approved bridge material and frame roles exact', () => {
    expect(HEARTHSIDE_STYLE.terrain.fills.bridge).toEqual({
      frames: ['rippleA', 'rippleB', 'rippleC', 'rippleD'],
      tint: 'water',
      opacity: 1,
    })
    expect(HEARTHSIDE_STYLE.terrain.planks).toEqual({
      horizontal: 'bridgeA',
      vertical: 'bridgeB',
      compact: 'bridgeC',
      tint: 'timber',
    })
  })
})

function required<Value>(value: Value | null | undefined, message: string): Value {
  if (value === undefined || value === null) throw new Error(message)
  return value
}
