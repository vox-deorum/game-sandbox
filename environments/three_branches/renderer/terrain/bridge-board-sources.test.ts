import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Texture } from 'pixi.js'
import { PNG } from 'pngjs'
import { describe, expect, it, vi } from 'vitest'

import { ATLAS_PAGES } from '../assets.js'
import { HEARTHSIDE_STYLE } from '../core/presentation.js'
import { bridgeBoardSourcesFor, extractBridgeBoardSources } from './bridge-board-sources.js'

function syntheticBoardFrame(
  width: number,
  coreRuns: readonly (readonly [number, number])[],
): Uint8ClampedArray {
  const height = 12
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (const [start, end] of coreRuns) {
    for (let column = Math.max(0, start - 1); column < Math.min(width, end + 1); column += 1) {
      const alpha = column >= start && column < end ? 255 : 48
      for (let row = 0; row < height; row += 1) {
        const offset = (row * width + column) * 4
        pixels[offset] = 128 + column
        pixels[offset + 1] = 96 + row
        pixels[offset + 2] = 64
        pixels[offset + 3] = alpha
      }
    }
  }
  // Sparse opaque noise must not become a fourth board core.
  pixels[22 * 4 + 3] = 255
  return pixels
}

function atlasFrame(
  group: string,
  name: string,
): { pixels: Uint8ClampedArray; width: number; height: number } {
  const page = ATLAS_PAGES.find((item) => item.group === group)
  if (page === undefined) throw new Error(`${group} atlas page is missing.`)
  const index = page.cells.findIndex((cell) => cell.name === name)
  if (index < 0) throw new Error(`${group} frame is missing: ${name}`)
  const path = resolve(
    process.cwd(),
    `../environments/three_branches/renderer/${page.pagePath.slice(2)}`,
  )
  const image = PNG.sync.read(readFileSync(path))
  const width = page.width / page.columns
  const height = page.height / page.rows
  const pixels = new Uint8ClampedArray(width * height * 4)
  const left = (index % page.columns) * width
  const top = Math.floor(index / page.columns) * height
  for (let row = 0; row < height; row += 1) {
    pixels.set(
      image.data.subarray(
        ((top + row) * image.width + left) * 4,
        ((top + row) * image.width + left + width) * 4,
      ),
      row * width * 4,
    )
  }
  return { pixels, width, height }
}

function rowCoverage(source: Readonly<Uint8ClampedArray>, width: number, row: number): number {
  let visible = 0
  for (let column = 0; column < width; column += 1) {
    if ((source[(row * width + column) * 4 + 3] ?? 0) > 16) visible += 1
  }
  return visible / width
}

function columnCoverage(
  source: Readonly<Uint8ClampedArray>,
  width: number,
  firstRow: number,
  lastRow: number,
  column: number,
): number {
  let visible = 0
  for (let row = firstRow; row <= lastRow; row += 1) {
    if ((source[(row * width + column) * 4 + 3] ?? 0) > 16) visible += 1
  }
  return visible / (lastRow - firstRow + 1)
}

function visibleRowBounds(
  source: Readonly<Uint8ClampedArray>,
  width: number,
  height: number,
): { start: number; end: number } {
  let start = 0
  while (start < height && rowCoverage(source, width, start) < 0.1) start += 1
  let end = height
  while (end > start && rowCoverage(source, width, end - 1) < 0.1) end -= 1
  if (start === end) throw new Error('Board source has no visible material rows.')
  return { start, end }
}

describe('Three Branches bridge board sources', () => {
  it('reads the configured frame rectangle from a borrowed atlas resource', () => {
    const pixels = syntheticBoardFrame(24, [
      [2, 7],
      [9, 15],
      [17, 22],
    ])
    const resource = {} as CanvasImageSource
    const drawImage = vi.fn()
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage,
        getImageData: () => ({ data: pixels }) as ImageData,
      }),
    } as unknown as HTMLCanvasElement
    const createElement = vi.spyOn(document, 'createElement').mockReturnValue(canvas)
    try {
      const sources = bridgeBoardSourcesFor(
        { source: { resource } } as Texture,
        { width: 24, height: 12, columns: 2, rows: 1, names: ['other', 'boards'] },
        'boards',
      )

      expect(sources).toHaveLength(3)
      expect(drawImage).toHaveBeenCalledWith(resource, 24, 0, 24, 12, 0, 0, 24, 12)
      expect(canvas).toMatchObject({ width: 24, height: 12 })
    } finally {
      createElement.mockRestore()
    }
  })

  it('extracts three ordered full-colour sources by scanning frame columns', () => {
    const pixels = syntheticBoardFrame(24, [
      [2, 7],
      [9, 15],
      [17, 22],
    ])
    const sources = extractBridgeBoardSources(pixels, 24, 12, 'boards')

    expect(sources).toHaveLength(3)
    expect(sources.map((source) => [source.width, source.height])).toEqual([
      [7, 12],
      [8, 12],
      [7, 12],
    ])
    expect(sources[0]?.pixels[0]).toBe(129)
    expect(sources[0]?.pixels[1]).toBe(96)
    expect(sources[0]?.pixels[3]).toBe(48)
  })

  it.each([2, 4])('rejects a malformed source with %i board cores', (count) => {
    const runs = Array.from(
      { length: count },
      (_, index) => [index * 3 + 1, index * 3 + 2] as const,
    )
    expect(() => extractBridgeBoardSources(syntheticBoardFrame(16, runs), 16, 12, 'bad')).toThrow(
      `Three Branches bridge board source bad is malformed: must contain exactly three board cores, found ${count}.`,
    )
  })

  it('retains wood at both deck cross edges under worst configured overscan and phase', () => {
    const frame = atlasFrame('bridges', 'boards')
    const sources = extractBridgeBoardSources(frame.pixels, frame.width, frame.height, 'boards')
    const treatment = HEARTHSIDE_STYLE.terrain.planks
    const crossSpans = [
      HEARTHSIDE_STYLE.terrain.routes.path.widthCells,
      HEARTHSIDE_STYLE.terrain.routes.path.widthCells + treatment.sideOverhangCells * 2,
      HEARTHSIDE_STYLE.terrain.routes.road.targetWidthCells + treatment.sideOverhangCells * 2,
    ]
    const sourceRowFor = (
      rows: { start: number; end: number },
      crossSpan: number,
      deckPosition: number,
      phase: number,
    ): number =>
      Math.max(
        rows.start,
        Math.min(
          rows.end - 1,
          rows.start +
            Math.floor(
              ((deckPosition + treatment.sourceOverscanCells - phase) /
                (crossSpan + treatment.sourceOverscanCells * 2)) *
                (rows.end - rows.start),
            ),
        ),
      )
    const maximumBoardWidth =
      ((1 + (treatment.portalOverlapCells + treatment.portalMaskInsetCells) * 2) *
        (1 + treatment.widthVariation)) /
      (1 +
        treatment.widthVariation +
        (treatment.boardsPerCell - 1) * (1 - treatment.widthVariation))
    const portalInset =
      (treatment.portalMaskInsetCells + treatment.portalSourceOverscanCells) /
      (maximumBoardWidth + treatment.portalSourceOverscanCells)

    for (const source of sources) {
      const rows = visibleRowBounds(source.pixels, source.width, source.height)
      for (const crossSpan of crossSpans) {
        for (const phase of [treatment.sourcePhaseCells, -treatment.sourcePhaseCells]) {
          const firstRow = sourceRowFor(rows, crossSpan, 0, phase)
          const lastRow = sourceRowFor(rows, crossSpan, crossSpan, phase)
          expect(rowCoverage(source.pixels, source.width, firstRow)).toBeGreaterThanOrEqual(0.7)
          expect(rowCoverage(source.pixels, source.width, lastRow)).toBeGreaterThanOrEqual(0.7)
        }
      }

      const firstPortalColumn = Math.floor(portalInset * source.width)
      const lastPortalColumn = Math.min(
        source.width - 1,
        Math.ceil((1 - portalInset) * source.width) - 1,
      )
      expect(
        columnCoverage(source.pixels, source.width, rows.start, rows.end - 1, firstPortalColumn),
      ).toBeGreaterThanOrEqual(0.6)
      expect(
        columnCoverage(source.pixels, source.width, rows.start, rows.end - 1, lastPortalColumn),
      ).toBeGreaterThanOrEqual(0.6)
    }
  })
})
