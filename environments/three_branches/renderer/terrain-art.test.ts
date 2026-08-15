import { Container, Graphics, Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import {
  contourMask,
  drawMap,
  exactTerrainGrid,
  materialForGroundName,
  materialGridWithHalo,
  materialLayerAlpha,
  ownedTerrainView,
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

function sparseLayerFixture(): { scene: StaticScene; art: TerrainArt } {
  const rows = ['gfer', 'wpbd', 'xigp']
  const ground = Object.entries(names).map(([code, name]) => ({
    code,
    name,
    color: '#000000',
    passable: true,
    layer: ['interior', 'doorway', 'wall'].includes(name)
      ? ('structure' as const)
      : ('landscape' as const),
  }))
  const scene: StaticScene = {
    village: {
      size: { cellsX: 4, cellsY: 3, cellSize: 1 },
      ground: rows,
      buildings: [],
      props: [],
      scenery: [],
      spawn: { x: 0, y: 0 },
    },
    world: { width: 4, height: 3 },
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
  const art: TerrainArt = {
    tileset: { tileSize: 1, textures },
    variant: () => 0,
    contours: planTerrainContours(rows, names, HEARTHSIDE_STYLE.terrain.contours),
    plankLayer: { columns: 4, rows: ['    ', '    ', '    '] },
    upperWallTileset: { tileSize: 1, textures: { U: Texture.EMPTY, '.': Texture.EMPTY } },
    upperWallGrid: { columns: 4, rows: ['    ', '    ', '    '] },
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

  it('retains the approved terrain draw order', () => {
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
  })

  it('applies the configured opacity to every sparse material layer', () => {
    expect(materialLayerAlpha('field')).toBe(1)
    expect(materialLayerAlpha('reeds')).toBe(1)
    expect(materialLayerAlpha('water')).toBe(1)
    expect(materialLayerAlpha('path')).toBe(1)
    expect(materialLayerAlpha('road')).toBe(0.58)
  })

  it('sets the sparse road container alpha without dimming the base terrain', () => {
    const { scene, art } = sparseLayerFixture()
    const terrain = drawMap(new Container(), scene, art)
    expect([1, 3, 5, 8, 10].map((index) => terrain.view.children[index]?.alpha)).toEqual([
      1, 1, 1, 1, 0.58,
    ])
    expect((terrain.view.children[0] as Container).alpha).toBe(1)
    terrain.destroy()
  })

  it('uses one signed component path for direct holes and a separate nested island', () => {
    const plan = planTerrainContours(
      ['ggggg', 'gwwwg', 'gwgwg', 'gwwwg', 'ggggg'],
      names,
      HEARTHSIDE_STYLE.terrain.contours,
    )
    const outer = plan.components.find(
      (component) => component.material === 'ground' && component.holeRingIds.length === 1,
    )
    const island = plan.components.find(
      (component) => component.material === 'ground' && component.nestingDepth > 0,
    )
    expect(outer).toBeDefined()
    expect(island).toBeDefined()
    expect(island?.parentComponentId).toBeDefined()
    const rings = new Map(plan.rings.map((ring) => [ring.id, ring]))
    const outerRing = rings.get(outer!.outerRingId)!
    const directHole = rings.get(outer!.holeRingIds[0]!)!
    const path = signedComponentPath(outerRing, [directHole], 16)
    expect(path.checkForHoles).toBe(true)
    expect(
      path.instructions.filter((instruction) => instruction.action === 'closePath'),
    ).toHaveLength(2)
    const mask = contourMask(plan, 'ground', 16)
    const fills = mask.context.instructions.filter((instruction) => instruction.action === 'fill')
    expect(fills).toHaveLength(2)
    const closedSubpaths: number[] = []
    for (const instruction of fills) {
      if (instruction.action !== 'fill')
        throw new Error('Contour mask emitted a non-fill instruction.')
      const addedPath = instruction.data.path.instructions.find((path) => path.action === 'addPath')
      if (addedPath === undefined || addedPath.action !== 'addPath') {
        throw new Error('Contour mask did not retain its signed component path.')
      }
      const componentPath = addedPath.data[0] as {
        checkForHoles: boolean
        instructions: readonly { action: string }[]
      }
      expect(componentPath.checkForHoles).toBe(true)
      closedSubpaths.push(
        componentPath.instructions.filter((path) => path.action === 'closePath').length,
      )
    }
    expect(closedSubpaths.sort()).toEqual([1, 2])
    mask.destroy()
  })

  it('keeps full-strength shoreline sections continuous while bridge tapers split into lower-alpha runs', () => {
    const bands = HEARTHSIDE_STYLE.terrain.contours.shoreline.bands
    expect(bands.map((band) => band.tint)).toEqual(['reed', 'silt'])
    for (const band of bands) {
      expect(
        shorelineStrokeRuns(
          {
            closed: false,
            points: [shorelinePoint(0, 1), shorelinePoint(1, 1), shorelinePoint(2, 1)],
          },
          band.opacity,
        ),
      ).toEqual([
        {
          points: [shorelinePoint(0, 1), shorelinePoint(1, 1), shorelinePoint(2, 1)],
          alpha: band.opacity,
          closed: false,
        },
      ])
      const taper = shorelineStrokeRuns(
        {
          closed: false,
          points: [shorelinePoint(0, 1), shorelinePoint(1, 0.5), shorelinePoint(2, 0)],
        },
        band.opacity,
      )
      expect(taper).toHaveLength(1)
      expect(taper[0]).toMatchObject({ alpha: band.opacity * 0.5, closed: false })
    }
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

  it('orients a three-by-three bridge from paired east and west road contacts', () => {
    expect(plankRowsFor(['ggggg', 'gbbbg', 'rbbbr', 'gbbbg', 'ggggg'], names)).toEqual([
      '     ',
      ` ${BRIDGE_PLANK_CODES.horizontal.repeat(3)} `,
      ` ${BRIDGE_PLANK_CODES.horizontal.repeat(3)} `,
      ` ${BRIDGE_PLANK_CODES.horizontal.repeat(3)} `,
      '     ',
    ])
  })

  it('orients a three-by-three bridge from paired north and south path contacts', () => {
    expect(plankRowsFor(['ggpgg', 'gbbbg', 'gbbbg', 'gbbbg', 'ggpgg'], names)).toEqual([
      '     ',
      ` ${BRIDGE_PLANK_CODES.vertical.repeat(3)} `,
      ` ${BRIDGE_PLANK_CODES.vertical.repeat(3)} `,
      ` ${BRIDGE_PLANK_CODES.vertical.repeat(3)} `,
      '     ',
    ])
  })

  it('uses compact as the deterministic fallback for tied bridge components', () => {
    const rows = ['ggrgggg', 'ggbgggg', 'ggrgggg', 'rbrggbg', 'ggggggg']
    const planned = plankRowsFor(rows, names)
    expect(planned).toEqual([
      '       ',
      `  ${BRIDGE_PLANK_CODES.vertical}    `,
      '       ',
      ` ${BRIDGE_PLANK_CODES.horizontal}   ${BRIDGE_PLANK_CODES.compact} `,
      '       ',
    ])
    expect(plankRowsFor(rows, names)).toEqual(planned)
  })

  it('keeps the approved bridge material roles exact', () => {
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
