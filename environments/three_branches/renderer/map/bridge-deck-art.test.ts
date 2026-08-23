import { type Sprite, Texture } from 'pixi.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HEARTHSIDE_STYLE } from '../core/presentation.js'
import type { TerrainBridgeComponent } from '../core/types.js'
import {
  BRIDGE_DECK_SOURCE_CELLS,
  createBridgeDeckLayer,
  deckBounds,
  planBridgeBoards,
} from './bridge-deck-art.js'

function bridge(
  orientation: TerrainBridgeComponent['orientation'],
  cells: readonly { column: number; row: number }[],
  deck: TerrainBridgeComponent['deck'],
  id = `bridge-${orientation}`,
): TerrainBridgeComponent {
  const columns = cells.map((cell) => cell.column)
  const rows = cells.map((cell) => cell.row)
  return {
    id,
    cells,
    contacts: [],
    owner: 'path',
    orientation,
    bounds: {
      minColumn: Math.min(...columns),
      maxColumn: Math.max(...columns),
      minRow: Math.min(...rows),
      maxRow: Math.max(...rows),
    },
    portals: deck.axis === undefined ? [] : [...deck.axis],
    deck,
  }
}

const treatment = HEARTHSIDE_STYLE.terrain.planks
const canvasContextDescriptor = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  'getContext',
)

interface CanvasCommand {
  readonly name: string
  readonly args: readonly unknown[]
}

interface RecordedCanvas {
  readonly canvas: HTMLCanvasElement
  readonly commands: CanvasCommand[]
}

let recordedCanvases: RecordedCanvas[] = []

function recordedContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const commands: CanvasCommand[] = []
  recordedCanvases.push({ canvas, commands })
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      commands.push({ name, args })
  let fillStyle: string | CanvasGradient | CanvasPattern = '#000000'
  let globalAlpha = 1
  let composite: GlobalCompositeOperation = 'source-over'
  const context = {
    clearRect: record('clearRect'),
    save: record('save'),
    beginPath: record('beginPath'),
    rect: record('rect'),
    clip: record('clip'),
    fillRect: record('fillRect'),
    drawImage: record('drawImage'),
    restore: record('restore'),
    translate: record('translate'),
    scale: record('scale'),
    createLinearGradient: (...args: unknown[]) => {
      commands.push({ name: 'createLinearGradient', args })
      return {
        addColorStop: (...stopArgs: unknown[]) =>
          commands.push({ name: 'addColorStop', args: stopArgs }),
      } as unknown as CanvasGradient
    },
    createImageData: (width: number, height: number) =>
      ({ data: new Uint8ClampedArray(width * height * 4) }) as ImageData,
    putImageData: record('putImageData'),
  } as unknown as CanvasRenderingContext2D
  Object.defineProperties(context, {
    fillStyle: {
      get: () => fillStyle,
      set: (value: string | CanvasGradient | CanvasPattern) => {
        fillStyle = value
        commands.push({ name: 'fillStyle', args: [value] })
      },
    },
    globalAlpha: {
      get: () => globalAlpha,
      set: (value: number) => {
        globalAlpha = value
        commands.push({ name: 'globalAlpha', args: [value] })
      },
    },
    globalCompositeOperation: {
      get: () => composite,
      set: (value: GlobalCompositeOperation) => {
        composite = value
        commands.push({ name: 'composite', args: [value] })
      },
    },
  })
  return context
}

beforeEach(() => {
  recordedCanvases = []
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value(this: HTMLCanvasElement, kind: string) {
      return kind === '2d' ? recordedContext(this) : null
    },
  })
})

afterEach(() => {
  if (canvasContextDescriptor !== undefined) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', canvasContextDescriptor)
  }
  vi.restoreAllMocks()
})

function boardSources(): readonly [
  ReturnType<typeof board>,
  ReturnType<typeof board>,
  ReturnType<typeof board>,
] {
  return [board(), board(), board()]
}

function board() {
  return {
    width: 2,
    height: 2,
    pixels: new Uint8ClampedArray([
      128, 128, 128, 255, 160, 160, 160, 255, 160, 160, 160, 255, 128, 128, 128, 255,
    ]),
  }
}

function directionalBoard() {
  const transparentRow = Array.from({ length: 2 }, () => [0, 0, 0, 0]).flat()
  return {
    width: 2,
    height: 5,
    pixels: new Uint8ClampedArray([
      ...transparentRow,
      ...[1, 2, 3, 4, 5, 6].flatMap((red) => [red, 0, 0, 255]),
      ...transparentRow,
    ]),
  }
}

function horizontalBridge(id = 'bridge-horizontal'): TerrainBridgeComponent {
  return bridge(
    'horizontal',
    [
      { column: 4, row: 7 },
      { column: 5, row: 7 },
    ],
    {
      kind: 'axis',
      widthCells: 0.7,
      cap: 'butt',
      center: { x: 5, y: 7.5 },
      axis: [
        { x: 4, y: 7.5 },
        { x: 6, y: 7.5 },
      ],
    },
    id,
  )
}

function required<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new Error(message)
  return value
}

describe('component bridge deck planning', () => {
  it('extends horizontal portals while normalizing deterministic board widths without gaps', () => {
    const component = bridge(
      'horizontal',
      [
        { column: 4, row: 7 },
        { column: 5, row: 7 },
      ],
      {
        kind: 'axis',
        widthCells: 0.7,
        cap: 'butt',
        center: { x: 5, y: 7.5 },
        axis: [
          { x: 4, y: 7.5 },
          { x: 6, y: 7.5 },
        ],
      },
    )
    const first = planBridgeBoards(component, treatment)
    const second = planBridgeBoards(component, treatment)
    const sourceOverlap = treatment.portalOverlapCells + treatment.portalMaskInsetCells

    expect(first).toEqual(second)
    expect(first.bounds).toMatchObject({ runAxis: 'horizontal' })
    expect(first.bounds.minX).toBeCloseTo(4 - sourceOverlap, 10)
    expect(first.bounds.maxX).toBeCloseTo(6 + sourceOverlap, 10)
    expect(first.bounds.minY).toBeCloseTo(7.1, 10)
    expect(first.bounds.maxY).toBeCloseTo(7.9, 10)
    expect(first.boards).toHaveLength(6)
    expect(first.boards[0]?.x).toBe(4 - sourceOverlap)
    const last = required(first.boards.at(-1), 'Horizontal bridge has no final board.')
    expect(last.x + last.width).toBeCloseTo(6 + sourceOverlap, 10)
    for (const [index, board] of first.boards.slice(1).entries()) {
      const previous = required(first.boards[index], 'Horizontal bridge has no previous board.')
      expect(board.x).toBeCloseTo(previous.x + previous.width, 10)
    }
    expect(
      first.boards.every(
        (board) => board.y === first.bounds.minY && board.y + board.height === first.bounds.maxY,
      ),
    ).toBe(true)
    expect(
      first.boards.every((board) => Math.abs(board.crossAxisPhase) <= treatment.sourcePhaseCells),
    ).toBe(true)
  })

  it('rotates vertical planning while preserving its centered cross width', () => {
    const component = bridge(
      'vertical',
      [
        { column: 2, row: 1 },
        { column: 2, row: 2 },
      ],
      {
        kind: 'axis',
        widthCells: 0.7,
        cap: 'butt',
        center: { x: 2.5, y: 2 },
        axis: [
          { x: 2.5, y: 1 },
          { x: 2.5, y: 3 },
        ],
      },
    )
    const plan = planBridgeBoards(component, treatment)
    const sourceOverlap = treatment.portalOverlapCells + treatment.portalMaskInsetCells

    expect(plan.bounds).toEqual({
      minX: 2.1,
      maxX: 2.9,
      minY: 1 - sourceOverlap,
      maxY: 3 + sourceOverlap,
      runAxis: 'vertical',
    })
    expect(plan.boards).toHaveLength(6)
    expect(plan.boards[0]?.y).toBe(1 - sourceOverlap)
    const last = required(plan.boards.at(-1), 'Vertical bridge has no final board.')
    expect(last.y + last.height).toBeCloseTo(3 + sourceOverlap, 10)
    expect(
      plan.boards.every(
        (board) => board.x === plan.bounds.minX && board.x + board.width === plan.bounds.maxX,
      ),
    ).toBe(true)
  })

  it('uses the centered deck square for a single compact bridge', () => {
    const component = bridge('compact', [{ column: 3, row: 4 }], {
      kind: 'compact',
      widthCells: 0.7,
      cap: 'round',
      center: { x: 3.5, y: 4.5 },
    })

    expect(deckBounds(component)).toMatchObject({
      minX: 3.15,
      maxX: 3.85,
      minY: 4.15,
      maxY: 4.85,
    })
  })

  it('rotates compact material samples when the board run is vertical', () => {
    const component = bridge(
      'compact',
      [
        { column: 2, row: 1 },
        { column: 2, row: 2 },
      ],
      {
        kind: 'compact',
        widthCells: 0.7,
        cap: 'round',
        center: { x: 2.5, y: 2 },
      },
    )

    const plan = planBridgeBoards(component, treatment)

    expect(plan.bounds.runAxis).toBe('vertical')
  })

  it('uses every multi-cell compact bounding rectangle and leaves final coverage to the union mask', () => {
    const square = bridge(
      'compact',
      [
        { column: 2, row: 2 },
        { column: 3, row: 2 },
        { column: 2, row: 3 },
        { column: 3, row: 3 },
      ],
      {
        kind: 'compact',
        widthCells: 0.7,
        cap: 'round',
        center: { x: 3, y: 3 },
      },
      'compact-square',
    )
    const elbow = bridge(
      'compact',
      [
        { column: 2, row: 2 },
        { column: 3, row: 2 },
        { column: 2, row: 3 },
      ],
      {
        kind: 'compact',
        widthCells: 0.7,
        cap: 'round',
        center: { x: 3, y: 3 },
      },
      'compact-elbow',
    )

    expect(deckBounds(square)).toMatchObject({
      minX: 2,
      maxX: 4,
      minY: 2,
      maxY: 4,
    })
    expect(deckBounds(elbow)).toMatchObject({
      minX: 2,
      maxX: 4,
      minY: 2,
      maxY: 4,
    })
    expect(planBridgeBoards(elbow, treatment).boards).toHaveLength(6)
  })
})

describe('component bridge deck rendering', () => {
  it('keeps vertical source pixels for horizontal runs and quarter-turns them for vertical runs', () => {
    const source = directionalBoard()
    const sources = [source, source, source] as const
    const horizontalLayer = createBridgeDeckLayer(
      { bridgeBoards: sources },
      [horizontalBridge()],
      16,
      treatment,
    )
    const horizontalSource = required(recordedCanvases[1], 'Horizontal source canvas is missing.')
    const horizontalImage = required(
      horizontalSource.commands.find((command) => command.name === 'putImageData')?.args[0],
      'Horizontal source pixels are missing.',
    ) as ImageData
    expect({
      width: horizontalSource.canvas.width,
      height: horizontalSource.canvas.height,
    }).toEqual({
      width: 2,
      height: 3,
    })
    expect(Array.from(horizontalImage.data).filter((_, index) => index % 4 === 0)).toEqual([
      1, 2, 3, 4, 5, 6,
    ])
    horizontalLayer.destroy()

    recordedCanvases = []
    const vertical = bridge('vertical', [{ column: 8, row: 4 }], {
      kind: 'axis',
      widthCells: 0.7,
      cap: 'butt',
      center: { x: 8.5, y: 4.5 },
      axis: [
        { x: 8.5, y: 4 },
        { x: 8.5, y: 5 },
      ],
    })
    const verticalLayer = createBridgeDeckLayer(
      { bridgeBoards: sources },
      [vertical],
      16,
      treatment,
    )
    const verticalSource = required(recordedCanvases[1], 'Vertical source canvas is missing.')
    const verticalImage = required(
      verticalSource.commands.find((command) => command.name === 'putImageData')?.args[0],
      'Vertical source pixels are missing.',
    ) as ImageData
    expect({
      width: verticalSource.canvas.width,
      height: verticalSource.canvas.height,
    }).toEqual({
      width: 3,
      height: 2,
    })
    expect(Array.from(verticalImage.data).filter((_, index) => index % 4 === 0)).toEqual([
      5, 3, 1, 6, 4, 2,
    ])
    verticalLayer.destroy()
  })

  it('builds one visual-bound 128-pixel-per-cell mipmapped sprite', () => {
    const textureFrom = vi.spyOn(Texture, 'from')
    const layer = createBridgeDeckLayer(
      { bridgeBoards: boardSources() },
      [horizontalBridge()],
      16,
      treatment,
    )
    const component = required(layer.view.children[0], 'Bridge component container is missing.')
    const sprite = required(
      component.children.find((child) => child.label === 'terrain-bridge-deck-sprite'),
      'Bridge deck sprite is missing.',
    ) as Sprite
    const mask = required(
      component.children.find(
        (child) => child.label === 'terrain-bridge-deck-mask:bridge-horizontal',
      ),
      'Bridge deck mask is missing.',
    )
    const textureInput = textureFrom.mock.calls[0]?.[0] as
      | { resource?: HTMLCanvasElement; autoGenerateMipmaps?: boolean }
      | undefined
    const canvas = required(textureInput?.resource, 'Bridge texture canvas is missing.')
    const sourceOverlap = treatment.portalOverlapCells + treatment.portalMaskInsetCells

    expect(canvas.width).toBe(Math.round((2 + sourceOverlap * 2) * BRIDGE_DECK_SOURCE_CELLS))
    expect(canvas.height).toBe(Math.round(0.8 * BRIDGE_DECK_SOURCE_CELLS))
    expect(textureInput?.autoGenerateMipmaps).toBe(true)
    expect(sprite.position.x).toBeCloseTo((4 - sourceOverlap) * 16, 10)
    expect(sprite.position.y).toBeCloseTo(7.1 * 16, 10)
    expect(sprite.scale.x).toBe(16 / BRIDGE_DECK_SOURCE_CELLS)
    expect(sprite.scale.y).toBe(16 / BRIDGE_DECK_SOURCE_CELLS)
    const maskBounds = mask.getLocalBounds()
    expect(maskBounds.minX).toBeCloseTo((4 - treatment.portalOverlapCells) * 16, 10)
    expect(maskBounds.minY).toBeCloseTo(7.1 * 16, 10)
    expect(maskBounds.maxX).toBeCloseTo((6 + treatment.portalOverlapCells) * 16, 10)
    expect(maskBounds.maxY).toBeCloseTo(7.9 * 16, 10)
    layer.destroy()
  })

  it('draws internal seam underlays before the overscanned full-color boards', () => {
    const component = horizontalBridge()
    const plan = planBridgeBoards(component, treatment)
    const layer = createBridgeDeckLayer(
      { bridgeBoards: boardSources() },
      [component],
      16,
      treatment,
    )
    const final = required(recordedCanvases[0], 'Final bridge canvas was not recorded.')
    const indexOf = (name: string, value?: unknown): number =>
      final.commands.findIndex(
        (command) => command.name === name && (value === undefined || command.args[0] === value),
      )
    const firstBoard = indexOf('drawImage')
    const seams = final.commands
      .slice(0, firstBoard)
      .filter((command) => command.name === 'fillRect')
    const expectedSeamWidth = 0.025 * BRIDGE_DECK_SOURCE_CELLS

    expect(final.commands[0]).toEqual({
      name: 'fillStyle',
      args: [HEARTHSIDE_STYLE.palette[treatment.seam.tint]],
    })
    expect(firstBoard).toBeGreaterThan(indexOf('fillRect'))
    expect(seams).toHaveLength(plan.boards.length - 1)
    expect(seams.every((command) => command.args[2] === expectedSeamWidth)).toBe(true)
    expect(seams.every((command) => (command.args[0] as number) > 0)).toBe(true)
    expect(
      seams.every(
        (command) => (command.args[0] as number) + (command.args[2] as number) < final.canvas.width,
      ),
    ).toBe(true)
    expect(
      final.commands.slice(0, firstBoard).some((command) => command.name === 'composite'),
    ).toBe(false)
    const shadowWidth = treatment.edgeShadow.widthCells * BRIDGE_DECK_SOURCE_CELLS
    const lastBoard = final.commands.map((command) => command.name).lastIndexOf('drawImage')
    const shadows = final.commands
      .slice(lastBoard + 1)
      .filter((command) => command.name === 'fillRect')
    expect(shadows.map((command) => command.args)).toEqual([
      [0, 0, final.canvas.width, shadowWidth],
      [0, final.canvas.height - shadowWidth, final.canvas.width, shadowWidth],
    ])
    expect(
      final.commands.some(
        (command) => command.name === 'composite' && command.args[0] === 'source-atop',
      ),
    ).toBe(true)
    layer.destroy()
  })

  it('phases the narrow source axis without moving deck bounds and overscans both cross edges', () => {
    const component = horizontalBridge()
    const plan = planBridgeBoards(component, treatment)
    const layer = createBridgeDeckLayer(
      { bridgeBoards: boardSources() },
      [component],
      16,
      treatment,
    )
    const final = required(recordedCanvases[0], 'Final bridge canvas was not recorded.')
    const boardDraws = final.commands.filter((command) => command.name === 'drawImage')
    const sourceOverlap = treatment.portalOverlapCells + treatment.portalMaskInsetCells
    const crossSpan = 0.7 + treatment.sideOverhangCells * 2
    const overscannedCrossSpan = crossSpan + treatment.sourceOverscanCells * 2

    expect(plan.bounds.minX).toBeCloseTo(4 - sourceOverlap, 10)
    expect(plan.bounds.maxX).toBeCloseTo(6 + sourceOverlap, 10)
    expect(plan.bounds.minY).toBeCloseTo(7.1, 10)
    expect(plan.bounds.maxY).toBeCloseTo(7.9, 10)
    expect(boardDraws).toHaveLength(plan.boards.length)
    for (const [index, draw] of boardDraws.entries()) {
      const board = required(plan.boards[index], 'Bridge plan is missing a board.')
      expect(draw.args[4]).toBeCloseTo(overscannedCrossSpan * BRIDGE_DECK_SOURCE_CELLS, 10)
      expect(draw.args[3]).toBeCloseTo(
        board.width * BRIDGE_DECK_SOURCE_CELLS +
          (index === 0 ? treatment.portalSourceOverscanCells * BRIDGE_DECK_SOURCE_CELLS : 0) +
          (index === plan.boards.length - 1
            ? treatment.portalSourceOverscanCells * BRIDGE_DECK_SOURCE_CELLS
            : 0),
        10,
      )
    }
    const translations = final.commands.filter((command) => command.name === 'translate')
    for (const [index, translation] of translations.entries()) {
      const board = required(plan.boards[index], 'Bridge plan is missing a board.')
      const y = translation.args[1] as number
      const sourceHeight = overscannedCrossSpan * BRIDGE_DECK_SOURCE_CELLS
      const expectedY =
        (-treatment.sourceOverscanCells + board.crossAxisPhase) * BRIDGE_DECK_SOURCE_CELLS +
        (board.reversed ? sourceHeight : 0)
      expect(y).toBeCloseTo(expectedY, 10)
      expect(Math.abs(board.crossAxisPhase)).toBeLessThanOrEqual(treatment.sourcePhaseCells)
    }
    layer.destroy()
  })

  it('expands both portal ends for a one-board axis deck without changing sprite bounds', () => {
    const component = bridge('horizontal', [{ column: 4, row: 7 }], {
      kind: 'axis',
      widthCells: 0.7,
      cap: 'butt',
      center: { x: 4.5, y: 7.5 },
      axis: [
        { x: 4, y: 7.5 },
        { x: 5, y: 7.5 },
      ],
    })
    const oneBoardTreatment = { ...treatment, boardsPerCell: 1 }
    const plan = planBridgeBoards(component, oneBoardTreatment)
    const layer = createBridgeDeckLayer(
      { bridgeBoards: boardSources() },
      [component],
      16,
      oneBoardTreatment,
    )
    const final = required(recordedCanvases[0], 'Final bridge canvas was not recorded.')
    const draw = required(
      final.commands.find((command) => command.name === 'drawImage'),
      'Bridge board draw is missing.',
    )
    const sprite = required(
      required(layer.view.children[0], 'Bridge component is missing.').children.find(
        (child) => child.label === 'terrain-bridge-deck-sprite',
      ),
      'Bridge sprite is missing.',
    ) as Sprite
    const sourceSpan = 1 + (treatment.portalOverlapCells + treatment.portalMaskInsetCells) * 2

    expect(plan.boards).toHaveLength(1)
    expect(draw.args[3]).toBeCloseTo(
      (sourceSpan + treatment.portalSourceOverscanCells * 2) * BRIDGE_DECK_SOURCE_CELLS,
      10,
    )
    expect(sprite.position.x).toBeCloseTo(
      (4 - treatment.portalOverlapCells - treatment.portalMaskInsetCells) * 16,
      10,
    )
    expect(sprite.texture.width).toBe(Math.round(sourceSpan * BRIDGE_DECK_SOURCE_CELLS))
    layer.destroy()
  })

  it('maps narrow mirroring and end reversal onto the correct axes after rotation', () => {
    const horizontal = planBridgeBoards(horizontalBridge(), treatment)
    const vertical = planBridgeBoards(
      bridge('vertical', [{ column: 8, row: 4 }], {
        kind: 'axis',
        widthCells: 0.7,
        cap: 'butt',
        center: { x: 8.5, y: 4.5 },
        axis: [
          { x: 8.5, y: 4 },
          { x: 8.5, y: 5 },
        ],
      }),
      treatment,
    )
    const sources = [directionalBoard(), directionalBoard(), directionalBoard()] as const
    const layer = createBridgeDeckLayer(
      { bridgeBoards: sources },
      [
        horizontalBridge(),
        bridge('vertical', [{ column: 8, row: 4 }], {
          kind: 'axis',
          widthCells: 0.7,
          cap: 'butt',
          center: { x: 8.5, y: 4.5 },
          axis: [
            { x: 8.5, y: 4 },
            { x: 8.5, y: 5 },
          ],
        }),
      ],
      16,
      treatment,
    )
    const horizontalFinal = required(recordedCanvases[0], 'Horizontal final canvas is missing.')
    const verticalFinal = required(recordedCanvases[4], 'Vertical final canvas is missing.')
    const scales = (canvas: RecordedCanvas) =>
      canvas.commands.filter((command) => command.name === 'scale').map((command) => command.args)

    expect(scales(horizontalFinal)).toEqual(
      horizontal.boards.map((board) => [board.mirrored ? -1 : 1, board.reversed ? -1 : 1]),
    )
    expect(scales(verticalFinal)).toEqual(
      vertical.boards.map((board) => [board.reversed ? -1 : 1, board.mirrored ? -1 : 1]),
    )
    const verticalDraws = verticalFinal.commands.filter((command) => command.name === 'drawImage')
    const verticalTranslations = verticalFinal.commands.filter(
      (command) => command.name === 'translate',
    )
    for (const [index, board] of vertical.boards.entries()) {
      const draw = required(verticalDraws[index], 'Vertical board draw is missing.')
      const translation = required(
        verticalTranslations[index],
        'Vertical board translation is missing.',
      )
      const firstOverscan = index === 0 ? treatment.portalSourceOverscanCells : 0
      const lastOverscan =
        index === vertical.boards.length - 1 ? treatment.portalSourceOverscanCells : 0
      const sourceWidth =
        (board.width + treatment.sourceOverscanCells * 2) * BRIDGE_DECK_SOURCE_CELLS
      const sourceHeight = (board.height + firstOverscan + lastOverscan) * BRIDGE_DECK_SOURCE_CELLS
      const expectedX =
        (-treatment.sourceOverscanCells + board.crossAxisPhase) * BRIDGE_DECK_SOURCE_CELLS +
        (board.reversed ? sourceWidth : 0)
      const expectedY =
        (board.y - vertical.bounds.minY - firstOverscan) * BRIDGE_DECK_SOURCE_CELLS +
        (board.mirrored ? sourceHeight : 0)

      expect(draw.args[3]).toBeCloseTo(sourceWidth, 10)
      expect(draw.args[4]).toBeCloseTo(sourceHeight, 10)
      expect(translation.args[0]).toBeCloseTo(expectedX, 10)
      expect(translation.args[1]).toBeCloseTo(expectedY, 10)
    }
    const lastVerticalBoard = verticalFinal.commands
      .map((command) => command.name)
      .lastIndexOf('drawImage')
    const verticalShadows = verticalFinal.commands
      .slice(lastVerticalBoard + 1)
      .filter((command) => command.name === 'fillRect')
    const shadowWidth = treatment.edgeShadow.widthCells * BRIDGE_DECK_SOURCE_CELLS
    expect(verticalShadows.map((command) => command.args)).toEqual([
      [0, 0, shadowWidth, verticalFinal.canvas.height],
      [verticalFinal.canvas.width - shadowWidth, 0, shadowWidth, verticalFinal.canvas.height],
    ])
    layer.destroy()
  })

  it('uses the rotated narrow-axis transform without portal expansion for compact vertical decks', () => {
    const compact = bridge(
      'compact',
      [
        { column: 2, row: 1 },
        { column: 2, row: 2 },
      ],
      { kind: 'compact', widthCells: 0.7, cap: 'round', center: { x: 2.5, y: 2 } },
      'compact-vertical-render',
    )
    const plan = planBridgeBoards(compact, treatment)
    const source = directionalBoard()
    const layer = createBridgeDeckLayer(
      { bridgeBoards: [source, source, source] },
      [compact],
      16,
      treatment,
    )
    const final = required(recordedCanvases[0], 'Compact final canvas is missing.')
    const rotatedSource = required(recordedCanvases[1], 'Compact source canvas is missing.')
    const image = required(
      rotatedSource.commands.find((command) => command.name === 'putImageData')?.args[0],
      'Compact source pixels are missing.',
    ) as ImageData
    const scales = final.commands
      .filter((command) => command.name === 'scale')
      .map((command) => command.args)
    const draws = final.commands.filter((command) => command.name === 'drawImage')

    expect(plan.bounds.runAxis).toBe('vertical')
    expect(Array.from(image.data).filter((_, index) => index % 4 === 0)).toEqual([5, 3, 1, 6, 4, 2])
    expect(scales).toEqual(
      plan.boards.map((board) => [board.reversed ? -1 : 1, board.mirrored ? -1 : 1]),
    )
    for (const [index, draw] of draws.entries()) {
      const board = required(plan.boards[index], 'Compact plan is missing a board.')
      expect(draw.args[4]).toBeCloseTo(board.height * BRIDGE_DECK_SOURCE_CELLS, 10)
    }
    layer.destroy()
  })

  it('destroys generated texture resources once and leaves borrowed source pixels intact', () => {
    const sources = boardSources()
    const borrowed = sources[0].pixels
    const before = new Uint8ClampedArray(borrowed)
    const layer = createBridgeDeckLayer(
      { bridgeBoards: sources },
      [horizontalBridge()],
      16,
      treatment,
    )
    const component = required(layer.view.children[0], 'Bridge component container is missing.')
    const sprite = required(
      component.children.find((child) => child.label === 'terrain-bridge-deck-sprite'),
      'Bridge deck sprite is missing.',
    ) as Sprite
    const texture = sprite.texture
    const generatedSource = texture.source
    const destroyTexture = vi.spyOn(texture, 'destroy')

    layer.destroy()
    layer.destroy()

    expect(destroyTexture).toHaveBeenCalledOnce()
    expect(destroyTexture).toHaveBeenCalledWith(true)
    expect(texture.destroyed).toBe(true)
    expect(generatedSource.destroyed).toBe(true)
    expect(texture.source).toBeNull()
    expect(sources[0].pixels).toBe(borrowed)
    expect(borrowed).toEqual(before)
  })

  it('releases prior generated decks when a later component cannot be constructed', () => {
    const sources = boardSources()
    const originalTextureFrom = Texture.from
    let calls = 0
    const textureFrom = vi.spyOn(Texture, 'from').mockImplementation((input) => {
      if (calls === 1) throw new Error('second bridge texture failed')
      calls += 1
      return originalTextureFrom(input)
    })
    const vertical = bridge('vertical', [{ column: 8, row: 4 }], {
      kind: 'axis',
      widthCells: 0.7,
      cap: 'butt',
      center: { x: 8.5, y: 4.5 },
      axis: [
        { x: 8.5, y: 4 },
        { x: 8.5, y: 5 },
      ],
    })

    expect(() =>
      createBridgeDeckLayer(
        { bridgeBoards: sources },
        [horizontalBridge('first'), vertical],
        16,
        treatment,
      ),
    ).toThrow('second bridge texture failed')
    const firstTexture = textureFrom.mock.results[0]?.value as Texture | undefined
    expect(firstTexture?.destroyed).toBe(true)
    expect(firstTexture?.source).toBeNull()
  })
})
