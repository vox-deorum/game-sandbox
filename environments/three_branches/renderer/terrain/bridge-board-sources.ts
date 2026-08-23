import type { Texture } from 'pixi.js'

import { type FrameGrid, frameRectangle } from '../ui/tint.js'

/** One copied, full-colour board sample retained from the bridge material page. */
export interface BridgeBoardSource {
  readonly width: number
  readonly height: number
  /** The copied RGBA pixels are owned by terrain art and never by the atlas texture. */
  readonly pixels: Readonly<Uint8ClampedArray>
}

/** Exactly three ordered board samples extracted from the authored bridge strip. */
export type BridgeBoardSources = readonly [BridgeBoardSource, BridgeBoardSource, BridgeBoardSource]

const CORE_ALPHA = 160
const ANTIALIAS_ALPHA = 16
const ANTIALIAS_COVERAGE = 0.1

/** Read the three board samples from the configured full-colour `boards` frame. */
export function bridgeBoardSourcesFor(
  atlas: Texture,
  grid: FrameGrid,
  frameName = 'boards',
): BridgeBoardSources {
  const frame = frameRectangle(grid, frameName)
  const resource = atlas.source.resource
  if (resource === null) throw malformed(frameName, 'has no atlas image source.')
  const canvas = document.createElement('canvas')
  canvas.width = frame.width
  canvas.height = frame.height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('A 2D canvas is required to extract Three Branches boards.')
  context.drawImage(
    resource as CanvasImageSource,
    frame.x,
    frame.y,
    frame.width,
    frame.height,
    0,
    0,
    frame.width,
    frame.height,
  )
  return extractBridgeBoardSources(
    context.getImageData(0, 0, frame.width, frame.height).data,
    frame.width,
    frame.height,
    frameName,
  )
}

/** Split one full-colour bridge strip into three ordered board samples by column coverage. */
export function extractBridgeBoardSources(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  sourceName = 'boards',
): BridgeBoardSources {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw malformed(sourceName, 'has invalid dimensions.')
  }
  if (pixels.length !== width * height * 4) {
    throw malformed(sourceName, 'has pixels that do not match its dimensions.')
  }
  const coverage = Array.from({ length: width }, (_, column) =>
    alphaCoverage(pixels, width, height, column),
  )
  const cores = runsFor(coverage, (line) => line.mean >= CORE_ALPHA)
  if (cores.length !== 3) {
    throw malformed(sourceName, `must contain exactly three board cores, found ${cores.length}.`)
  }
  const expanded = cores.map((core, index) => {
    const previousEnd = cores[index - 1]?.end ?? 0
    const nextStart = cores[index + 1]?.start ?? width
    let start = core.start
    let end = core.end
    while (start - 1 > previousEnd && (coverage[start - 1]?.visible ?? 0) >= ANTIALIAS_COVERAGE)
      start -= 1
    while (end + 1 < nextStart && (coverage[end]?.visible ?? 0) >= ANTIALIAS_COVERAGE) end += 1
    return { start, end }
  })
  const sources = expanded.map(({ start, end }) => cropBoard(pixels, width, height, start, end))
  if (sources.length !== 3) throw malformed(sourceName, 'did not produce three board sources.')
  const first = sources[0]
  const second = sources[1]
  const third = sources[2]
  if (first === undefined || second === undefined || third === undefined) {
    throw malformed(sourceName, 'did not produce three board sources.')
  }
  return [first, second, third]
}

function alphaCoverage(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  column: number,
): { mean: number; visible: number } {
  let alphaTotal = 0
  let visible = 0
  for (let row = 0; row < height; row += 1) {
    const alpha = pixels[(row * width + column) * 4 + 3] ?? 0
    alphaTotal += alpha
    if (alpha > ANTIALIAS_ALPHA) visible += 1
  }
  return { mean: alphaTotal / height, visible: visible / height }
}

function runsFor<T>(
  items: readonly T[],
  matches: (item: T) => boolean,
): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = []
  for (let start = 0; start < items.length; ) {
    const item = items[start]
    if (item === undefined || !matches(item)) {
      start += 1
      continue
    }
    let end = start + 1
    while (end < items.length) {
      const item = items[end]
      if (item === undefined || !matches(item)) break
      end += 1
    }
    runs.push({ start, end })
    start = end
  }
  return runs
}

function cropBoard(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  start: number,
  end: number,
): BridgeBoardSource {
  const boardWidth = end - start
  const board = new Uint8ClampedArray(boardWidth * height * 4)
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = (row * width + start) * 4
    board.set(pixels.subarray(sourceOffset, sourceOffset + boardWidth * 4), row * boardWidth * 4)
  }
  return { width: boardWidth, height, pixels: board }
}

function malformed(sourceName: string, detail: string): Error {
  return new Error(`Three Branches bridge board source ${sourceName} is malformed: ${detail}`)
}
