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
import { terrainHash } from './terrain-contours.js'
import type { TerrainBridgeComponent, TerrainRoutePlan } from './terrain-routes.js'
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

/** One deterministic visible portion of a broken land-side shoreline treatment. */
export interface ShorelineStrokeRun {
  readonly points: readonly TerrainContourPoint[]
  readonly alpha: number
  readonly closed: boolean
}

/** Return the configured composite alpha for one sparse natural material surface. */
export function materialLayerAlpha(material: ContouredMaterial): number {
  if (material === 'road') return HEARTHSIDE_STYLE.terrain.routes.road.opacity
  if (material === 'path') return HEARTHSIDE_STYLE.terrain.routes.path.opacity
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
  base.view.label = 'terrain-ground'
  owner.addChild(base.view)
  grounds.push(base)

  const addMaskedMaterial = (
    material: Exclude<ContouredMaterial, 'road'>,
    rows = art.routes.visualRows,
  ): void => {
    const ground = createSparseTiledGround(
      materialGridWithHalo(rows, names, material, sourceCodeForMaterial(scene, material)),
      art.tileset,
      { cellSize, variant: art.variant },
    )
    const mask = contourMask(art.contours, material, cellSize)
    ground.view.label = `terrain-${material}`
    mask.label = `terrain-${material}-mask`
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
  const landMask = landContourMask(art.contours, cellSize)
  shoreline.label = 'terrain-shoreline'
  landMask.label = 'terrain-shoreline-land-mask'
  shoreline.mask = landMask
  owner.addChild(shoreline, landMask)
  graphics.push(shoreline, landMask)

  const path = createSparseTiledGround(plannedRouteTextureGrid(art.routes, 'path'), art.tileset, {
    cellSize,
    variant: art.variant,
  })
  const pathClip = pathGuideMask(art.routes, cellSize)
  path.view.label = 'terrain-path'
  pathClip.label = 'terrain-path-mask'
  path.view.alpha = materialLayerAlpha('path')
  path.view.mask = pathClip
  owner.addChild(path.view, pathClip)
  grounds.push(path)
  graphics.push(pathClip)

  const road = createSparseTiledGround(plannedRouteTextureGrid(art.routes, 'road'), art.tileset, {
    cellSize,
    variant: art.variant,
  })
  const roadClip = roadGuideMask(art.routes, cellSize)
  road.view.label = 'terrain-road'
  roadClip.label = 'terrain-road-mask'
  road.view.alpha = art.routes.roadStroke.opacity
  road.view.mask = roadClip
  owner.addChild(road.view, roadClip)
  grounds.push(road)
  graphics.push(roadClip)

  const structures = createSparseTiledGround(
    exactTerrainGrid(scene.topFirstRows, names, STRUCTURE_NAMES),
    art.tileset,
    { cellSize, variant: art.variant },
  )
  structures.view.label = 'terrain-structures'
  owner.addChild(structures.view)
  grounds.push(structures)

  const planks = createSparseTiledGround(art.plankLayer, art.tileset, {
    cellSize,
    variant: art.variant,
  })
  const deckClip = bridgeDeckMask(art.routes.bridgeComponents, cellSize)
  planks.view.label = 'terrain-planks'
  deckClip.label = 'terrain-planks-mask'
  planks.view.mask = deckClip
  owner.addChild(planks.view, deckClip)
  grounds.push(planks)
  graphics.push(deckClip)

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
      const target = result[row]
      if (code !== undefined && target !== undefined && isMaterial(code)) target[column] = code
    }
  }
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const code = rows[row]?.[column]
      if (code === undefined || !isMaterial(code)) continue
      for (let y = Math.max(0, row - 1); y <= Math.min(rows.length - 1, row + 1); y += 1) {
        for (let x = Math.max(0, column - 1); x <= Math.min(columns - 1, column + 1); x += 1) {
          const target = result[y]
          if (target?.[x] === ' ') target[x] = haloCode
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

/** Build the union mask that clips centered shoreline strokes to their land-facing half. */
export function landContourMask(plan: TerrainContourPlan, cellSize: number): Graphics {
  const mask = new Graphics()
  const rings = new Map(plan.rings.map((ring) => [ring.id, ring]))
  for (const component of plan.components) {
    if (component.exterior || component.material === 'water') continue
    const outer = rings.get(component.outerRingId)
    if (outer === undefined) throw new Error(`Terrain component ${component.id} has no outer ring.`)
    const holes = component.holeRingIds.map((holeId) => {
      const hole = rings.get(holeId)
      if (hole === undefined) {
        throw new Error(`Terrain component ${component.id} has a missing hole ring.`)
      }
      return hole
    })
    mask.path(signedComponentPath(outer, holes, cellSize)).fill('#ffffff')
  }
  return mask
}

/** Return a planner-owned route texture halo which always leaves bridge cells transparent. */
export function plannedRouteTextureGrid(
  routes: TerrainRoutePlan,
  route: 'road' | 'path',
): TileGrid {
  return {
    columns: routes.width,
    rows: route === 'road' ? routes.roadTextureRows : routes.pathTextureRows,
  }
}

/** Stroke every canonical path chain, including short road-contact extensions. */
export function pathGuideMask(routes: TerrainRoutePlan, cellSize: number): Graphics {
  const mask = new Graphics()
  for (const guide of routes.pathGuides) {
    const first = guide.points[0]
    if (first === undefined) continue
    if (guide.points.length === 1) {
      mask
        .circle(first.x * cellSize, first.y * cellSize, (guide.widthCells * cellSize) / 2)
        .fill('#ffffff')
      continue
    }
    mask.moveTo(first.x * cellSize, first.y * cellSize)
    for (const point of guide.points.slice(1)) {
      mask.lineTo(point.x * cellSize, point.y * cellSize)
    }
    if (guide.closed) mask.closePath()
    mask.stroke({
      color: '#ffffff',
      width: guide.widthCells * cellSize,
      cap: 'round',
      join: 'round',
    })
  }
  return mask
}

/** Stroke the inset road guide while its sparse texture grid excludes bridge cells. */
export function roadGuideMask(routes: TerrainRoutePlan, cellSize: number): Graphics {
  const mask = new Graphics()
  for (let index = 1; index < routes.roadGuide.length; index += 1) {
    const previous = routes.roadGuide[index - 1]
    const point = routes.roadGuide[index]
    if (previous === undefined || point === undefined) continue
    mask
      .moveTo(previous.x * cellSize, previous.y * cellSize)
      .lineTo(point.x * cellSize, point.y * cellSize)
      .stroke({
        color: '#ffffff',
        width: Math.min(previous.widthCells, point.widthCells) * cellSize,
        cap: 'round',
        join: 'round',
      })
  }
  for (const point of routes.roadGuide) {
    mask
      .circle(point.x * cellSize, point.y * cellSize, (point.widthCells * cellSize) / 2)
      .fill('#ffffff')
  }
  return mask
}

/** Clip repeated plank tiles to one route-width deck for each bridge component. */
export function bridgeDeckMask(
  components: readonly TerrainBridgeComponent[],
  cellSize: number,
): Graphics {
  const mask = new Graphics()
  for (const component of components) {
    const { deck } = component
    if (deck.kind === 'compact') {
      if (component.cells.length > 1) {
        for (const cell of component.cells) {
          mask.rect(cell.column * cellSize, cell.row * cellSize, cellSize, cellSize).fill('#ffffff')
        }
        continue
      }
      const size = deck.widthCells * cellSize
      mask
        .roundRect(
          deck.center.x * cellSize - size / 2,
          deck.center.y * cellSize - size / 2,
          size,
          size,
          size / 4,
        )
        .fill('#ffffff')
      continue
    }
    const axis = deck.axis
    if (axis === undefined) throw new Error(`Bridge component ${component.id} has no deck axis.`)
    mask
      .moveTo(axis[0].x * cellSize, axis[0].y * cellSize)
      .lineTo(axis[1].x * cellSize, axis[1].y * cellSize)
      .stroke({
        color: '#ffffff',
        width: deck.widthCells * cellSize,
        cap: 'square',
        join: 'round',
      })
  }
  return mask
}

/** Split one shoreline into deterministic visible arc intervals with bridge taper alpha. */
export function shorelineStrokeRuns(
  chain: Pick<TerrainContourChain, 'id' | 'closed' | 'points' | 'rawLength'>,
  band: {
    readonly opacity: number
    readonly density: number
    readonly runLengthCells: readonly [number, number]
  },
  bandIndex = 0,
): readonly ShorelineStrokeRun[] {
  const runs: ShorelineStrokeRun[] = []
  if (chain.points.length < 2 || chain.rawLength <= 0 || band.density <= 0) return runs
  const [minimumRun, maximumRun] = band.runLengthCells
  const averageRun = (minimumRun + maximumRun) / 2
  const cycleLength = averageRun / Math.min(1, band.density)
  const phase = hashUnit(terrainHash('shoreline-phase', chain.id, bandIndex)) * cycleLength
  const firstCycle = Math.floor(phase / cycleLength) - 1
  const lastCycle = Math.ceil((chain.rawLength + phase) / cycleLength)
  for (let cycle = firstCycle; cycle <= lastCycle; cycle += 1) {
    const runLength =
      minimumRun +
      hashUnit(terrainHash('shoreline-run', chain.id, bandIndex, cycle)) * (maximumRun - minimumRun)
    const cycleStart = cycle * cycleLength - phase
    const startOffset = Math.max(0, cycleStart)
    const endOffset = Math.min(chain.rawLength, cycleStart + runLength)
    if (endOffset - startOffset <= 1e-9) continue
    appendTaperedShorelineRuns(runs, chain, startOffset, endOffset, band.opacity)
  }
  return runs
}

/** Draw broken centered water bands, later clipped to the land contour union. */
export function shorelineGraphics(plan: TerrainContourPlan, cellSize: number): Graphics {
  const shoreline = new Graphics()
  for (const [bandIndex, band] of HEARTHSIDE_STYLE.terrain.contours.shoreline.bands.entries()) {
    for (const chain of plan.chains) {
      if (chain.shorelineSpans.length === 0) continue
      for (const run of shorelineStrokeRuns(chain, band, bandIndex)) {
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

function appendTaperedShorelineRuns(
  result: ShorelineStrokeRun[],
  chain: Pick<TerrainContourChain, 'closed' | 'points' | 'rawLength'>,
  startOffset: number,
  endOffset: number,
  opacity: number,
): void {
  const points = pointsForArcInterval(chain, startOffset, endOffset)
  let active: TerrainContourPoint[] | undefined
  let activeAlpha = 0
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]
    const end = points[index]
    if (start === undefined || end === undefined) continue
    const alpha = opacity * Math.min(start.shorelineFactor, end.shorelineFactor)
    if (alpha <= 0) {
      if (active !== undefined) result.push({ points: active, alpha: activeAlpha, closed: false })
      active = undefined
      continue
    }
    if (active === undefined || Math.abs(activeAlpha - alpha) > 1e-9) {
      if (active !== undefined) result.push({ points: active, alpha: activeAlpha, closed: false })
      active = [start, end]
      activeAlpha = alpha
    } else {
      active.push(end)
    }
  }
  if (active !== undefined) result.push({ points: active, alpha: activeAlpha, closed: false })
}

function pointsForArcInterval(
  chain: Pick<TerrainContourChain, 'closed' | 'points' | 'rawLength'>,
  startOffset: number,
  endOffset: number,
): TerrainContourPoint[] {
  const result = [pointAtRawOffset(chain, startOffset)]
  for (const point of chain.points) {
    if (point.rawOffset > startOffset + 1e-9 && point.rawOffset < endOffset - 1e-9) {
      result.push(point)
    }
  }
  result.push(pointAtRawOffset(chain, endOffset))
  return result
}

function pointAtRawOffset(
  chain: Pick<TerrainContourChain, 'closed' | 'points' | 'rawLength'>,
  offset: number,
): TerrainContourPoint {
  const pointCount = chain.points.length
  const segmentCount = chain.closed ? pointCount : pointCount - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const start = chain.points[index]
    const end = chain.points[(index + 1) % pointCount]
    if (start === undefined || end === undefined) continue
    const endOffset = chain.closed && index === pointCount - 1 ? chain.rawLength : end.rawOffset
    if (offset < start.rawOffset - 1e-9 || offset > endOffset + 1e-9) continue
    const span = endOffset - start.rawOffset
    const amount = span <= 1e-9 ? 0 : (offset - start.rawOffset) / span
    return {
      x: start.x + (end.x - start.x) * amount,
      y: start.y + (end.y - start.y) * amount,
      rawOffset: offset,
      locked: start.locked && end.locked,
      shorelineFactor:
        start.shorelineFactor + (end.shorelineFactor - start.shorelineFactor) * amount,
    }
  }
  const fallback = chain.points.at(-1)
  if (fallback === undefined) throw new Error('Shoreline chain has no points.')
  return { ...fallback, rawOffset: offset }
}

function hashUnit(hash: number): number {
  return hash / 0xffffffff
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
