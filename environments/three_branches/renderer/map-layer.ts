import {
  createSparseTiledGround,
  createTiledGround,
  type GroundView,
  solidColorTileset,
  type TiledGround,
  type TileGrid,
} from '@renderers/base/tiled-ground.js'
import { Container, Graphics, GraphicsPath } from 'pixi.js'

import { HEARTHSIDE_STYLE, THREE_BRANCHES_PRESENTATION } from './presentation.js'
import { type TerrainArt, transparentUpperGrid } from './terrain-art.js'
import type {
  TerrainContourChain,
  TerrainContourPlan,
  TerrainContourPoint,
  TerrainContourRing,
} from './terrain-contours.js'
import type { StaticScene } from './types.js'

const CONTOURED_MATERIALS = ['field', 'reeds', 'water', 'path', 'road'] as const
const STRUCTURE_NAMES = ['interior', 'doorway', 'wall'] as const

/** The retained owner order for full ground, clipped natural surfaces, structures, and bridge decks. */
export const TERRAIN_LAYER_ORDER = [
  'ground',
  'field',
  'reeds',
  'water',
  'shoreline',
  'path',
  'road',
  'structures',
  'planks',
] as const

type ContouredMaterial = (typeof CONTOURED_MATERIALS)[number]

/** One continuous shoreline stroke. Full-strength spans stay intact at every shared vertex. */
export interface ShorelineStrokeRun {
  readonly points: readonly TerrainContourPoint[]
  readonly alpha: number
  readonly closed: boolean
}

/** Return the configured composite alpha for one sparse natural material surface. */
export function materialLayerAlpha(material: ContouredMaterial): number {
  const treatment = HEARTHSIDE_STYLE.terrain.fills[material]
  if (treatment === undefined) {
    throw new Error(`Three Branches presentation has no ${material} terrain fill.`)
  }
  return treatment.opacity
}

/** Draw the diagnostic fallback or vector-masked Hearthside terrain. */
export function drawMap(layer: Container, scene: StaticScene, art?: TerrainArt): GroundView {
  if (art === undefined) return drawFallbackMap(layer, scene)
  const cellSize = THREE_BRANCHES_PRESENTATION.unitsPerMetre * scene.village.size.cellSize
  const owner = new Container()
  const grounds: GroundView[] = []
  const graphics: Graphics[] = []
  const names = Object.fromEntries(scene.ground.map((ground) => [ground.code, ground.name]))
  const baseCode = sourceCodeForMaterial(scene, 'ground')
  const base = createSparseTiledGround(
    {
      columns: scene.village.size.cellsX,
      rows: scene.topFirstRows.map(() => baseCode.repeat(scene.village.size.cellsX)),
    },
    art.tileset,
    { cellSize, variant: art.variant },
  )
  owner.addChild(base.view)
  grounds.push(base)

  const addMaskedMaterial = (material: ContouredMaterial): void => {
    const ground = createSparseTiledGround(
      materialGridWithHalo(
        scene.topFirstRows,
        names,
        material,
        sourceCodeForMaterial(scene, material),
      ),
      art.tileset,
      { cellSize, variant: art.variant },
    )
    const mask = contourMask(art.contours, material, cellSize)
    ground.view.alpha = materialLayerAlpha(material)
    ground.view.mask = mask
    owner.addChild(ground.view, mask)
    grounds.push(ground)
    graphics.push(mask)
  }

  addMaskedMaterial('field')
  addMaskedMaterial('reeds')
  addMaskedMaterial('water')
  const shoreline = shorelineGraphics(art.contours, cellSize)
  owner.addChild(shoreline)
  graphics.push(shoreline)
  addMaskedMaterial('path')
  addMaskedMaterial('road')

  const structures = createSparseTiledGround(
    exactTerrainGrid(scene.topFirstRows, names, STRUCTURE_NAMES),
    art.tileset,
    { cellSize, variant: art.variant },
  )
  owner.addChild(structures.view)
  grounds.push(structures)

  const planks = createSparseTiledGround(art.plankLayer, art.tileset, {
    cellSize,
    variant: art.variant,
  })
  owner.addChild(planks.view)
  grounds.push(planks)

  layer.addChild(owner)
  return ownedTerrainView(owner, grounds, graphics, base.span)
}

/** Resolve bridge cells to water while keeping every other terrain semantic distinct. */
export function materialForGroundName(name: string): string {
  return name === 'bridge' ? 'water' : name
}

/** Build a one-cell Chebyshev texture halo around an exact material source region. */
export function materialGridWithHalo(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  material: string,
  haloCode: string,
): TileGrid {
  const columns = rows[0]?.length ?? 0
  if (columns === 0 || rows.some((row) => row.length !== columns)) {
    throw new Error('Terrain material coverage requires a non-empty rectangular ground grid.')
  }
  if (haloCode.length !== 1) throw new Error('Terrain material halo code must be one character.')
  const result = Array.from({ length: rows.length }, () => Array(columns).fill(' ') as string[])
  const isMaterial = (code: string): boolean =>
    materialForGroundName(groundNameForCode[code] ?? '') === material
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const code = rows[row]?.[column]
      if (code !== undefined && isMaterial(code)) result[row]![column] = code
    }
  }
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const code = rows[row]?.[column]
      if (code === undefined || !isMaterial(code)) continue
      for (let y = Math.max(0, row - 1); y <= Math.min(rows.length - 1, row + 1); y += 1) {
        for (let x = Math.max(0, column - 1); x <= Math.min(columns - 1, column + 1); x += 1) {
          if (result[y]?.[x] === ' ') result[y]![x] = haloCode
        }
      }
    }
  }
  return { columns, rows: result.map((row) => row.join('')) }
}

/** Keep building interiors, thresholds, and walls as exact square texture cells. */
export function exactTerrainGrid(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  names: readonly string[],
): TileGrid {
  const columns = rows[0]?.length ?? 0
  if (columns === 0 || rows.some((row) => row.length !== columns)) {
    throw new Error('Exact terrain coverage requires a non-empty rectangular ground grid.')
  }
  const accepted = new Set(names)
  return {
    columns,
    rows: rows.map((row) =>
      [...row].map((code) => (accepted.has(groundNameForCode[code] ?? '') ? code : ' ')).join(''),
    ),
  }
}

/** Build one signed path for each component, including only its direct hole rings. */
export function contourMask(
  plan: TerrainContourPlan,
  material: string,
  cellSize: number,
): Graphics {
  const mask = new Graphics()
  const rings = new Map(plan.rings.map((ring) => [ring.id, ring]))
  for (const component of plan.components) {
    if (component.exterior || component.material !== material) continue
    const outer = rings.get(component.outerRingId)
    if (outer === undefined) throw new Error(`Terrain component ${component.id} has no outer ring.`)
    const holes = component.holeRingIds.map((holeId) => {
      const hole = rings.get(holeId)
      if (hole === undefined)
        throw new Error(`Terrain component ${component.id} has a missing hole ring.`)
      return hole
    })
    mask.path(signedComponentPath(outer, holes, cellSize)).fill('#ffffff')
  }
  return mask
}

/** Group equal-alpha shoreline segments so full-strength bands never bead at every vertex. */
export function shorelineStrokeRuns(
  chain: Pick<TerrainContourChain, 'closed' | 'points'>,
  opacity: number,
): readonly ShorelineStrokeRun[] {
  const pointCount = chain.points.length
  const segmentCount = chain.closed ? pointCount : Math.max(0, pointCount - 1)
  if (segmentCount === 0) return []
  const alphas = Array.from({ length: segmentCount }, (_, index) => {
    const start = chain.points[index]!
    const end = chain.points[(index + 1) % pointCount]!
    return opacity * Math.min(start.shorelineFactor, end.shorelineFactor)
  })
  const sameAlpha = (first: number, second: number): boolean => Math.abs(first - second) < 1e-9
  if (chain.closed && alphas.every((alpha) => sameAlpha(alpha, alphas[0]!))) {
    const alpha = alphas[0]!
    return alpha <= 0 ? [] : [{ points: chain.points, alpha, closed: true }]
  }
  const pivot = chain.closed
    ? alphas.findIndex(
        (alpha, index) => !sameAlpha(alpha, alphas[(index - 1 + segmentCount) % segmentCount]!),
      )
    : 0
  const order = Array.from(
    { length: segmentCount },
    (_, index) => (index + Math.max(0, pivot)) % segmentCount,
  )
  const runs: ShorelineStrokeRun[] = []
  let points: TerrainContourPoint[] | undefined
  let alpha = 0
  for (const index of order) {
    const nextAlpha = alphas[index]!
    const start = chain.points[index]!
    const end = chain.points[(index + 1) % pointCount]!
    if (nextAlpha <= 0) {
      if (points !== undefined) runs.push({ points, alpha, closed: false })
      points = undefined
      continue
    }
    if (points === undefined || !sameAlpha(alpha, nextAlpha)) {
      if (points !== undefined) runs.push({ points, alpha, closed: false })
      points = [start, end]
      alpha = nextAlpha
    } else {
      points.push(end)
    }
  }
  if (points !== undefined) runs.push({ points, alpha, closed: false })
  return runs
}

/** Draw quiet water bands from the planner's bridge-suppressed, already-tapered contour points. */
export function shorelineGraphics(plan: TerrainContourPlan, cellSize: number): Graphics {
  const shoreline = new Graphics()
  for (const band of HEARTHSIDE_STYLE.terrain.contours.shoreline.bands) {
    for (const chain of plan.chains) {
      if (chain.shorelineSpans.length === 0) continue
      for (const run of shorelineStrokeRuns(chain, band.opacity)) {
        const first = run.points[0]
        if (first === undefined) continue
        shoreline.moveTo(first.x * cellSize, first.y * cellSize)
        for (const point of run.points.slice(1))
          shoreline.lineTo(point.x * cellSize, point.y * cellSize)
        if (run.closed) shoreline.closePath()
        shoreline.stroke({
          color: HEARTHSIDE_STYLE.palette[band.tint],
          width: band.widthCells * cellSize,
          alpha: run.alpha,
          cap: 'round',
          join: 'round',
        })
      }
    }
  }
  return shoreline
}

/** Draw the configured ground as the unchanged dense, solid-color pre-art fallback. */
function drawFallbackMap(layer: Container, scene: StaticScene): TiledGround {
  const baseCode = scene.ground.find((item) => item.layer === 'base')?.code
  if (baseCode === undefined) throw new Error('Three Branches rules do not define a fill ground.')
  const rowsFor = (wanted: 'landscape' | 'structure'): string[] =>
    scene.topFirstRows.map((row) =>
      [...row].map((code) => (scene.groundByCode[code]?.layer === wanted ? code : ' ')).join(''),
    )
  const baseRows = scene.topFirstRows.map(() => baseCode.repeat(scene.village.size.cellsX))
  const colors = Object.fromEntries(scene.ground.map((ground) => [ground.code, ground.color]))
  const ground = createTiledGround(
    { columns: scene.village.size.cellsX, rows: baseRows },
    solidColorTileset(colors),
    {
      cellSize: THREE_BRANCHES_PRESENTATION.unitsPerMetre * scene.village.size.cellSize,
      layers: [
        { columns: scene.village.size.cellsX, rows: rowsFor('landscape') },
        { columns: scene.village.size.cellsX, rows: rowsFor('structure') },
      ],
    },
  )
  layer.addChild(ground.view)
  return ground
}

/** Draw only the configured wall ground into the layer that sits above characters. */
export function drawUpperWalls(layer: Container, scene: StaticScene, art: TerrainArt): TiledGround {
  const ground = createTiledGround(
    transparentUpperGrid(scene.village.size.cellsX, scene.village.size.cellsY),
    art.upperWallTileset,
    {
      cellSize: THREE_BRANCHES_PRESENTATION.unitsPerMetre * scene.village.size.cellSize,
      layers: [art.upperWallGrid],
      variant: art.upperWallVariant,
    },
  )
  layer.addChild(ground.view)
  return ground
}

function sourceCodeForMaterial(scene: StaticScene, material: string): string {
  const source = scene.ground.find((ground) => ground.name === material)
  const bridge =
    material === 'water' ? scene.ground.find((ground) => ground.name === 'bridge') : undefined
  const code = source?.code ?? bridge?.code
  if (code === undefined) throw new Error(`Three Branches rules do not define ${material} terrain.`)
  return code
}

/** Combine the planner's signed outer and direct-hole rings in one Pixi signed path. */
export function signedComponentPath(
  outer: TerrainContourRing,
  holes: readonly TerrainContourRing[],
  cellSize: number,
): GraphicsPath {
  const path = new GraphicsPath(undefined, true)
  appendRing(path, outer, cellSize)
  for (const hole of holes) appendRing(path, hole, cellSize)
  return path
}

function appendRing(path: GraphicsPath, ring: TerrainContourRing, cellSize: number): void {
  const first = ring.points[0]
  if (first === undefined) throw new Error(`Terrain ring ${ring.id} has no points.`)
  path.moveTo(first.x * cellSize, first.y * cellSize)
  for (const point of ring.points.slice(1)) path.lineTo(point.x * cellSize, point.y * cellSize)
  path.closePath()
}

export function ownedTerrainView(
  owner: Container,
  grounds: readonly GroundView[],
  graphics: readonly Graphics[],
  span: GroundView['span'],
): GroundView {
  let destroyed = false
  return {
    view: owner,
    span,
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const ground of grounds) ground.destroy()
      for (const graphic of graphics) graphic.destroy()
      owner.destroy({ children: false })
    },
  }
}
