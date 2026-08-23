import { Texture, type Sprite } from 'pixi.js'
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
  return {
    width: 2,
    height: 3,
    pixels: new Uint8ClampedArray(
      [1, 2, 3, 4, 5, 6].flatMap((red) => [red, 0, 0, 255]),
    ),
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

    expect(first).toEqual(second)
    expect(first.sourceRotation).toBe(0)
    expect(first.bounds).toMatchObject({ runAxis: 'horizontal' })
    expect(first.bounds.minX).toBeCloseTo(3.9, 10)
    expect(first.bounds.maxX).toBeCloseTo(6.1, 10)
    expect(first.bounds.minY).toBeCloseTo(7.1, 10)
    expect(first.bounds.maxY).toBeCloseTo(7.9, 10)
    expect(first.boards).toHaveLength(6)
    expect(first.boards[0]?.x).toBe(3.9)
    const last = required(first.boards.at(-1), 'Horizontal bridge has no final board.')
    expect(last.x + last.width).toBeCloseTo(6.1, 10)
    for (const [index, board] of first.boards.slice(1).entries()) {
      const previous = required(first.boards[index], 'Horizontal bridge has no previous board.')
      expect(board.x).toBeCloseTo(previous.x + previous.width, 10)
    }
    expect(
      first.boards.every(
        (board) => board.y === first.bounds.minY && board.y + board.height === first.bounds.maxY,
      ),
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

    expect(plan.sourceRotation).toBe(1)
    expect(plan.bounds).toEqual({ minX: 2.1, maxX: 2.9, minY: 0.9, maxY: 3.1, runAxis: 'vertical' })
    expect(plan.boards).toHaveLength(6)
    expect(plan.boards[0]?.y).toBe(0.9)
    const last = required(plan.boards.at(-1), 'Vertical bridge has no final board.')
    expect(last.y + last.height).toBeCloseTo(3.1, 10)
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

    expect(deckBounds(component)).toMatchObject({ minX: 3.15, maxX: 3.85, minY: 4.15, maxY: 4.85 })
  })

  it('rotates compact material samples when the board run is vertical', () => {
    const component = bridge(
      'compact',
      [
        { column: 2, row: 1 },
        { column: 2, row: 2 },
      ],
      { kind: 'compact', widthCells: 0.7, cap: 'round', center: { x: 2.5, y: 2 } },
    )

    const plan = planBridgeBoards(component, treatment)

    expect(plan.bounds.runAxis).toBe('vertical')
    expect(plan.sourceRotation).toBe(1)
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
      { kind: 'compact', widthCells: 0.7, cap: 'round', center: { x: 3, y: 3 } },
      'compact-square',
    )
    const elbow = bridge(
      'compact',
      [
        { column: 2, row: 2 },
        { column: 3, row: 2 },
        { column: 2, row: 3 },
      ],
      { kind: 'compact', widthCells: 0.7, cap: 'round', center: { x: 3, y: 3 } },
      'compact-elbow',
    )

    expect(deckBounds(square)).toMatchObject({ minX: 2, maxX: 4, minY: 2, maxY: 4 })
    expect(deckBounds(elbow)).toMatchObject({ minX: 2, maxX: 4, minY: 2, maxY: 4 })
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
    )
    const horizontalSource = required(recordedCanvases[1], 'Horizontal source canvas is missing.')
    const horizontalImage = required(
      horizontalSource.commands.find((command) => command.name === 'putImageData')?.args[0],
      'Horizontal source pixels are missing.',
    ) as ImageData
    expect({ width: horizontalSource.canvas.width, height: horizontalSource.canvas.height }).toEqual({
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
    const verticalLayer = createBridgeDeckLayer({ bridgeBoards: sources }, [vertical], 16)
    const verticalSource = required(recordedCanvases[1], 'Vertical source canvas is missing.')
    const verticalImage = required(
      verticalSource.commands.find((command) => command.name === 'putImageData')?.args[0],
      'Vertical source pixels are missing.',
    ) as ImageData
    expect({ width: verticalSource.canvas.width, height: verticalSource.canvas.height }).toEqual({
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
    const layer = createBridgeDeckLayer({ bridgeBoards: boardSources() }, [horizontalBridge()], 16)
    const component = required(layer.view.children[0], 'Bridge component container is missing.')
    const sprite = required(
      component.children.find((child) => child.label === 'terrain-bridge-deck-sprite'),
      'Bridge deck sprite is missing.',
    ) as Sprite
    const textureInput = textureFrom.mock.calls[0]?.[0] as
      | { resource?: HTMLCanvasElement; autoGenerateMipmaps?: boolean }
      | undefined
    const canvas = required(textureInput?.resource, 'Bridge texture canvas is missing.')

    expect(canvas.width).toBe(Math.round(2.2 * BRIDGE_DECK_SOURCE_CELLS))
    expect(canvas.height).toBe(Math.round(0.8 * BRIDGE_DECK_SOURCE_CELLS))
    expect(textureInput?.autoGenerateMipmaps).toBe(true)
    expect(sprite.position.x).toBeCloseTo(3.9 * 16, 10)
    expect(sprite.position.y).toBeCloseTo(7.1 * 16, 10)
    expect(sprite.scale.x).toBe(16 / BRIDGE_DECK_SOURCE_CELLS)
    expect(sprite.scale.y).toBe(16 / BRIDGE_DECK_SOURCE_CELLS)
    layer.destroy()
  })

  it('draws opaque backing, full-color boards, then narrow ink seams', () => {
    const layer = createBridgeDeckLayer({ bridgeBoards: boardSources() }, [horizontalBridge()], 16)
    const final = required(recordedCanvases[0], 'Final bridge canvas was not recorded.')
    const indexOf = (name: string, value?: unknown): number =>
      final.commands.findIndex(
        (command) => command.name === name && (value === undefined || command.args[0] === value),
      )
    const backing = indexOf('fillRect')
    const firstBoard = indexOf('drawImage')
    const seams = final.commands.filter((command) => command.name === 'fillRect').slice(1)

    expect(final.commands[0]).toEqual({ name: 'fillStyle', args: ['#484238'] })
    expect(backing).toBeGreaterThan(-1)
    expect(firstBoard).toBeGreaterThan(backing)
    expect(seams).toHaveLength(5)
    expect(seams.every((command) => (command.args[2] as number) < 4)).toBe(true)
    expect(final.commands.some((command) => command.name === 'composite')).toBe(false)
    layer.destroy()
  })

  it('destroys generated texture resources once and leaves borrowed source pixels intact', () => {
    const sources = boardSources()
    const borrowed = sources[0].pixels
    const before = new Uint8ClampedArray(borrowed)
    const layer = createBridgeDeckLayer({ bridgeBoards: sources }, [horizontalBridge()], 16)
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
      createBridgeDeckLayer({ bridgeBoards: sources }, [horizontalBridge('first'), vertical], 16),
    ).toThrow('second bridge texture failed')
    const firstTexture = textureFrom.mock.results[0]?.value as Texture | undefined
    expect(firstTexture?.destroyed).toBe(true)
    expect(firstTexture?.source).toBeNull()
  })
})
