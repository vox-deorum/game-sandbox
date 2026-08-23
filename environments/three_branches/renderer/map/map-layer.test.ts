import { Container, FillPattern, type Graphics, Texture } from 'pixi.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEARTHSIDE_STYLE } from '../core/presentation.js'
import type {
  StaticScene,
  TerrainContourPlan,
  TerrainContourPoint,
  TerrainRoutePlan,
} from '../core/types.js'
import { PATTERN_MATERIALS, type TerrainArt } from '../terrain/terrain-art.js'
import { findCurveCrossings } from '../terrain/terrain-contour-validation.js'
import { planTerrainContours } from '../terrain/terrain-contours.js'
import { pointToSegmentDistance } from '../terrain/terrain-helpers.js'
import { planTerrainRoutes } from '../terrain/terrain-routes.js'
import {
  bridgeDeckMask,
  componentPaths,
  drawMap,
  exactTerrainGrid,
  hatchGraphics,
  materialSurface,
  offsetPolyline,
  pathGuideGraphics,
  reedMarksGraphics,
  roadGuideGraphics,
  type SeamStrokeRun,
  seamStrokeRuns,
  signedComponentPath,
} from './map-layer.js'

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

function contourPoint(x: number): TerrainContourPoint {
  return { x, y: 0, rawOffset: x, locked: false }
}

const INK_SPEC = HEARTHSIDE_STYLE.terrain.seams.ink
const canvasContextDescriptor = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  'getContext',
)

function canvasContext(): CanvasRenderingContext2D {
  return {
    clearRect: vi.fn(),
    save: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillRect: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    drawImage: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    createImageData: (width: number, height: number) =>
      ({ data: new Uint8ClampedArray(width * height * 4) }) as ImageData,
    putImageData: vi.fn(),
    fillStyle: '#000000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
  } as unknown as CanvasRenderingContext2D
}

beforeEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: (kind: string) => (kind === '2d' ? canvasContext() : null),
  })
})

afterEach(() => {
  if (canvasContextDescriptor !== undefined) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', canvasContextDescriptor)
  }
  vi.restoreAllMocks()
})

function visibleLength(runs: readonly SeamStrokeRun[]): number {
  return runs.reduce((total, run) => {
    const start = run.points[0]
    const end = run.points.at(-1)
    return start === undefined || end === undefined
      ? total
      : total + (end.rawOffset - start.rawOffset)
  }, 0)
}

function routePlan(rows: readonly string[]): TerrainRoutePlan {
  return planTerrainRoutes(rows, names, HEARTHSIDE_STYLE.terrain.routes)
}

function contourPlan(rows: readonly string[]): TerrainContourPlan {
  return planTerrainContours(rows, names, HEARTHSIDE_STYLE.terrain.contours)
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
  const textures = Object.fromEntries(Object.keys(names).map((code) => [code, Texture.EMPTY]))
  const routes = routePlan(rows)
  const art: TerrainArt = {
    tileset: { tileSize: 1, textures },
    variant: () => 0,
    patterns: {
      ...Object.fromEntries(PATTERN_MATERIALS.map((material) => [material, Texture.WHITE])),
      ink: Texture.WHITE,
    },
    routes,
    contours: planTerrainContours(routes.visualRows, names, HEARTHSIDE_STYLE.terrain.contours),
    bridgeBoards: bridgeBoardsFixture(),
    upperWallTileset: { tileSize: 1, textures: { U: Texture.EMPTY, '.': Texture.EMPTY } },
    upperWallGrid: { columns: 5, rows: ['     ', '     ', '     ', 'UUUUU'] },
    upperWallVariant: () => 0,
  }
  return { scene, art }
}

function bridgeBoardsFixture(): TerrainArt['bridgeBoards'] {
  const board = () => ({
    width: 2,
    height: 2,
    pixels: new Uint8ClampedArray([
      128, 128, 128, 255, 160, 160, 160, 255, 160, 160, 160, 255, 128, 128, 128, 255,
    ]),
  })
  return [board(), board(), board()]
}

describe('Three Branches map layer', () => {
  it('keeps architectural cells exact and out of natural sparse coverage', () => {
    expect(exactTerrainGrid(['gidwx', 'gixdg'], names, ['interior', 'doorway', 'wall'])).toEqual({
      columns: 5,
      rows: [' id x', ' ixd '],
    })
  })

  it('draws deterministic reed mark strokes only where the ground grid has reeds', () => {
    const strokeCount = (graphic: Graphics): number =>
      graphic.context.instructions.filter((instruction) => instruction.action === 'stroke').length
    const reedRows = ['ggggg', 'geeeg', 'geeeg', 'geeeg', 'ggggg']

    const withReeds = reedMarksGraphics(contourPlan(reedRows), reedRows, names, 16)
    const withReedsAgain = reedMarksGraphics(contourPlan(reedRows), reedRows, names, 16)
    expect(strokeCount(withReeds)).toBeGreaterThan(0)
    expect(strokeCount(withReeds)).toBe(strokeCount(withReedsAgain))
    expect(withReeds.getLocalBounds()).toEqual(withReedsAgain.getLocalBounds())
    withReeds.destroy()
    withReedsAgain.destroy()

    const plainRows = ['ggggg', 'ggggg']
    const withoutReeds = reedMarksGraphics(contourPlan(plainRows), plainRows, names, 16)
    expect(strokeCount(withoutReeds)).toBe(0)
    withoutReeds.destroy()
  })

  it('draws reed marks on the reed surface rather than on the reed cells', () => {
    const strokeCount = (graphic: Graphics): number =>
      graphic.context.instructions.filter((instruction) => instruction.action === 'stroke').length
    // The surface, not the grid, decides where a stalk may go. A reed cell the surface never
    // reaches carries no marks, and a cell the surface does reach carries them without being a
    // reed cell, so the stalks follow the drawn bank in both directions.
    const reedRows = ['ggggg', 'geeeg', 'geeeg', 'geeeg', 'ggggg']
    const plainRows = ['ggggg', 'ggggg', 'ggggg', 'ggggg', 'ggggg']

    const gated = reedMarksGraphics(contourPlan(plainRows), reedRows, names, 16)
    expect(strokeCount(gated)).toBe(0)
    gated.destroy()

    const reached = reedMarksGraphics(contourPlan(reedRows), plainRows, names, 16)
    expect(strokeCount(reached)).toBeGreaterThan(0)
    reached.destroy()
  })

  it('reports the drawn surface of a material, holes excluded', () => {
    const plan = contourPlan(['ggggg', 'gwwwg', 'gwgwg', 'gwwwg', 'ggggg'])
    const onWater = materialSurface(plan, 'water')
    expect(onWater(1.5, 1.5)).toBe(true)
    expect(onWater(2.5, 2.5)).toBe(false)
    expect(onWater(0.2, 0.2)).toBe(false)
    expect(materialSurface(plan, 'reeds')(1.5, 1.5)).toBe(false)
  })

  it('uses one signed component path for direct holes and a separate island', () => {
    const plan = planTerrainContours(
      ['ggggg', 'gwwwg', 'gwgwg', 'gwwwg', 'ggggg'],
      names,
      HEARTHSIDE_STYLE.terrain.contours,
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
    const points = Array.from({ length: 41 }, (_, index) => contourPoint(index))
    const chain = { id: 'bank', closed: false, rawLength: 40, points }
    const first = seamStrokeRuns(chain, INK_SPEC, 'seam-ink')
    const second = seamStrokeRuns(chain, INK_SPEC, 'seam-ink')

    expect(first).toEqual(second)
    expect(first.length).toBeGreaterThan(1)
    expect(visibleLength(first)).toBeGreaterThan(0)
    expect(visibleLength(first)).toBeLessThan(chain.rawLength)
  })

  it('leaves no gap longer than the configured maximum and never overlaps two runs', () => {
    for (const id of ['bank', 'reed-edge', 'shore', 'field-line', 'pond']) {
      const points = Array.from({ length: 61 }, (_, index) => contourPoint(index / 2))
      const chain = { id, closed: false, rawLength: 30, points }
      const spans = seamStrokeRuns(chain, INK_SPEC, 'seam-ink').map((run) => ({
        start: run.points[0]!.rawOffset,
        end: run.points.at(-1)!.rawOffset,
      }))

      let covered = 0
      for (const [index, span] of spans.entries()) {
        const previousEnd = index === 0 ? 0 : spans[index - 1]!.end
        expect(span.start).toBeGreaterThanOrEqual(previousEnd - 1e-9)
        expect(span.start - previousEnd).toBeLessThanOrEqual(INK_SPEC.gapLengthCells[1] + 1e-9)
        covered = span.end
      }
      expect(chain.rawLength - covered).toBeLessThanOrEqual(INK_SPEC.gapLengthCells[1] + 1e-9)
    }
  })

  it('draws a chain shorter than one run in full rather than dropping it into a gap', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      for (const rawLength of [0.5, 2, 3.5]) {
        const points = [contourPoint(0), contourPoint(rawLength)]
        const chain = { id, closed: false, rawLength, points }
        expect(visibleLength(seamStrokeRuns(chain, INK_SPEC, 'seam-ink'))).toBeCloseTo(rawLength, 9)
      }
    }
  })

  it('holds full opacity on land and shoreline seams', () => {
    const spec = {
      opacity: 0.2,
      runLengthCells: [2, 2] as [number, number],
      gapLengthCells: [0.5, 0.5] as [number, number],
    }
    const flatChain = {
      id: 'land-land',
      closed: false,
      rawLength: 10,
      points: Array.from({ length: 11 }, (_, x) => contourPoint(x)),
    }
    const flatRuns = seamStrokeRuns(flatChain, spec, 'seam-ink')
    expect(flatRuns.length).toBeGreaterThan(0)
    expect(flatRuns.every((run) => run.alpha === 0.2)).toBe(true)

    const varyingSourcePoints = {
      id: 'varying-source-points',
      closed: false,
      rawLength: 10,
      points: [
        contourPoint(0),
        contourPoint(4),
        contourPoint(5),
        contourPoint(6),
        contourPoint(10),
      ],
    }
    const varyingRuns = seamStrokeRuns(varyingSourcePoints, spec, 'seam-ink')
    expect(varyingRuns.every((run) => run.alpha === 0.2)).toBe(true)
  })

  it('offsets a straight run into an exact parallel line', () => {
    const run = Array.from({ length: 5 }, (_, index) => contourPoint(index))
    expect(offsetPolyline(run, -0.55)).toEqual([run.map((point) => ({ x: point.x, y: -0.55 }))])
  })

  it('keeps the hatch offset its full distance out where the bank bends tighter than the offset', () => {
    // A bank that turns tighter than the offset used to fold the hatch line into a bowtie, which
    // strokes as a small dark triangle sitting out on the water.
    const bank = Array.from({ length: 121 }, (_, index) => {
      const x = index / 20
      return { x, y: 4 + 0.6 * Math.cos(x * 2), rawOffset: x, locked: false }
    })
    const offset = 1.05
    const lines = offsetPolyline(bank, -offset)
    const hatch = lines.flat()

    for (const [index, line] of lines.entries()) {
      expect(findCurveCrossings([{ id: `bank-${index}`, closed: false, points: line }])).toEqual([])
    }
    expect(hatch.length).toBeGreaterThan(60)
    for (const point of hatch) {
      const nearest = Math.min(
        ...bank
          .slice(0, -1)
          .map((start, index) => pointToSegmentDistance(point, start, bank[index + 1]!)),
      )
      expect(nearest).toBeGreaterThan(offset - 0.06)
    }
  })

  it('draws every water hatch of a bending river without a folded loop', () => {
    const rows = [
      'gggggggggg',
      'gwwwggwwwg',
      'gggwggwggg',
      'ggwwggwwgg',
      'ggwgggggwg',
      'gwwggwwwwg',
      'gwggggwggg',
      'gwwwwwwggg',
      'gggggggggg',
    ]
    const plan = contourPlan(rows)
    const drawn = plan.chains.filter((chain) => chain.shorelineSpans.length > 0)
    const folded: string[] = []
    // A boundary runs as one chain from junction to junction, so this river network is a couple of
    // long chains rather than many short ones. Hold the length of what gets swept, since an empty
    // sweep would report no folds for the wrong reason.
    expect(drawn.flatMap((chain) => chain.points).length).toBeGreaterThan(200)
    for (const chain of drawn) {
      const sign = chain.leftMaterial === 'water' ? 1 : -1
      for (const offsetCells of HEARTHSIDE_STYLE.terrain.seams.waterHatch.offsetsCells) {
        for (const points of offsetPolyline(chain.points, sign * offsetCells)) {
          for (const [first] of findCurveCrossings([{ id: chain.id, closed: false, points }])) {
            folded.push(
              `${chain.id} at ${offsetCells} near ` +
                `(${first.start.x.toFixed(2)}, ${first.start.y.toFixed(2)})`,
            )
          }
          // Each run stops where the offset ran out of room, so none of them carries a chord over
          // the gap. The samples the runs are built from sit a quarter cell apart.
          for (let index = 0; index + 1 < points.length; index += 1) {
            const step = points[index + 1]!
            const from = points[index]!
            expect(Math.hypot(step.x - from.x, step.y - from.y)).toBeLessThan(1)
          }
        }
      }
    }
    expect(folded).toEqual([])
  })

  it('keeps bridge-water hatching beneath the shared route and deck cover', () => {
    const { scene, art } = sparseLayerFixture()
    const bridgeShore = art.contours.chains.find((chain) =>
      chain.shorelineSpans.some((span) => span.waterSemantics.includes('bridge')),
    )
    const hatch = hatchGraphics(art.contours, 16)

    expect(bridgeShore).toBeDefined()
    expect(
      hatch.context.instructions.filter((instruction) => instruction.action === 'stroke'),
    ).not.toHaveLength(0)
    hatch.destroy()

    const view = drawMap(scene, art)
    const hatchLayer = required(
      view.naturalView.children.find((child) => child.label === 'terrain-seam-hatch') as
        | Graphics
        | undefined,
      'Terrain hatch layer is missing.',
    )
    const cover = required(
      view.naturalView.children.find((child) => child.label === 'terrain-seam-cover') as
        | Graphics
        | undefined,
      'Terrain seam cover is missing.',
    )
    expect(art.routes.bridgeComponents).not.toHaveLength(0)
    expect(hatchLayer.mask).toBe(cover)
    view.destroy()
  })

  it('puts one mipmapped deck sprite and its mask after the structure layer for each bridge', () => {
    const { scene, art } = sparseLayerFixture()
    const view = drawMap(scene, art)
    const structures = view.architectureView.children.find(
      (child) => child.label === 'terrain-structures',
    )
    const decks = required(
      view.architectureView.children.find((child) => child.label === 'terrain-bridge-decks'),
      'Component-wide bridge layer is missing.',
    ) as Container

    expect(view.architectureView.children.indexOf(decks)).toBeGreaterThan(
      view.architectureView.children.indexOf(required(structures, 'Structure layer is missing.')),
    )
    expect(decks.children).toHaveLength(art.routes.bridgeComponents.length)
    const component = required(decks.children[0], 'Bridge deck component is missing.') as Container
    expect(component.label).toBe(`terrain-bridge-deck:${art.routes.bridgeComponents[0]?.id}`)
    expect(
      component.children.filter((child) => child.label === 'terrain-bridge-deck-sprite'),
    ).toHaveLength(1)
    expect(
      component.children.filter((child) => child.label?.startsWith('terrain-bridge-deck-mask:')),
    ).toHaveLength(1)
    view.destroy()
    view.destroy()
  })

  it('rolls back map containers and generated decks when a later bridge cannot be composed', () => {
    const { scene, art } = sparseLayerFixture()
    const first = required(art.routes.bridgeComponents[0], 'Bridge fixture is missing.')
    const second = {
      ...first,
      id: 'bridge-later-failure',
      orientation: 'vertical' as const,
      cells: [{ column: 4, row: 2 }],
      bounds: { minColumn: 4, maxColumn: 4, minRow: 2, maxRow: 2 },
      deck: {
        kind: 'axis' as const,
        widthCells: first.deck.widthCells,
        cap: 'butt' as const,
        center: { x: 4.5, y: 2.5 },
        axis: [
          { x: 4.5, y: 2 },
          { x: 4.5, y: 3 },
        ] as const,
      },
    }
    art.routes = { ...art.routes, bridgeComponents: [first, second] }
    const originalTextureFrom = Texture.from
    let calls = 0
    const textureFrom = vi.spyOn(Texture, 'from').mockImplementation((input) => {
      if (calls === 1) throw new Error('second bridge texture failed')
      calls += 1
      return originalTextureFrom(input)
    })
    const destroyContainer = vi.spyOn(Container.prototype, 'destroy')

    expect(() => drawMap(scene, art)).toThrow('second bridge texture failed')

    const generated = textureFrom.mock.results[0]?.value as Texture | undefined
    expect(generated?.destroyed).toBe(true)
    expect(generated?.source).toBeNull()
    const destroyedLabels = destroyContainer.mock.contexts.map(
      (container) => (container as Container).label,
    )
    expect(destroyedLabels).toContain('terrain-structures')
    expect(destroyedLabels).toContain('terrain-bridge-decks')
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

  it('leaves the route beneath the outer landing while preserving compact bridge masks', () => {
    const roadRoutes = routePlan(['ggggg', 'rrbrr', 'ggpgg'])
    const pathRoutes = routePlan(['rrrrr', 'ggpgg', 'ggbgg', 'ggpgg'])
    const compactRoutes = routePlan(['rrrrr', 'ggpgg', 'gpbpg', 'ggpgg'])
    const roadBridge = required(roadRoutes.bridgeComponents[0], 'Road bridge is missing.')
    const pathBridge = required(pathRoutes.bridgeComponents[0], 'Path bridge is missing.')
    const compactBridge = required(compactRoutes.bridgeComponents[0], 'Compact bridge is missing.')

    const mask = bridgeDeckMask([roadBridge, pathBridge, compactBridge], 16)
    expect(
      mask.context.instructions.filter((instruction) => instruction.action === 'stroke'),
    ).toHaveLength(0)
    expect(
      mask.context.instructions.filter((instruction) => instruction.action === 'fill'),
    ).toHaveLength(3)
    const baseMask = bridgeDeckMask([roadBridge], 16)
    const fadedMask = bridgeDeckMask([roadBridge], 16, 0.2)
    const base = baseMask.getLocalBounds()
    const faded = fadedMask.getLocalBounds()
    const underlap = Math.max(
      0,
      HEARTHSIDE_STYLE.terrain.planks.portalOverlapCells -
        HEARTHSIDE_STYLE.terrain.planks.portalMaskInsetCells,
    )
    expect(base.x).toBeCloseTo((2 - underlap) * 16, 10)
    expect(base.width).toBeCloseTo((1 + underlap * 2) * 16, 10)
    expect(faded.x).toBeCloseTo(base.x, 10)
    expect(faded.y).toBeCloseTo(base.y - 1.6, 10)
    expect(faded.width).toBeCloseTo(base.width, 10)
    expect(faded.height).toBeCloseTo(base.height + 3.2, 10)
    baseMask.destroy()
    fadedMask.destroy()
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
})

function required<Value>(value: Value | null | undefined, message: string): Value {
  if (value === undefined || value === null) throw new Error(message)
  return value
}
