import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { describe, expect, it, vi } from 'vitest'

import presentationDocument from './assets/presentation.json'
import type { ThreeBranchesRuntimeAssetLoadOptions } from './assets.js'
import {
  ATLAS_PAGES,
  loadThreeBranchesRuntimeAssets,
  readThreeBranchesAssetCatalog,
  THREE_BRANCHES_ASSET_CATALOG,
  THREE_BRANCHES_THUMBNAIL_ASSET,
} from './assets.js'

interface PngHeader {
  width: number
  height: number
  colorType: number
}

interface AlphaGeometry {
  left: number
  top: number
  right: number
  bottom: number
  centroidX: number
  centroidY: number
}

function readPngHeader(relativePath: string): PngHeader {
  const path = fileURLToPath(new URL(relativePath, import.meta.url))
  const bytes = readFileSync(path)
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG')
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes[25] ?? -1,
  }
}

function coloredTransparentPixelCount(relativePath: string): number {
  const path = fileURLToPath(new URL(relativePath, import.meta.url))
  const pixels = PNG.sync.read(readFileSync(path)).data
  let count = 0
  for (let index = 0; index < pixels.length; index += 4) {
    if (
      pixels[index + 3] === 0 &&
      ((pixels[index] ?? 0) !== 0 ||
        (pixels[index + 1] ?? 0) !== 0 ||
        (pixels[index + 2] ?? 0) !== 0)
    ) {
      count += 1
    }
  }
  return count
}

function alphaBounds(relativePath: string): { width: number; height: number } {
  const path = fileURLToPath(new URL(relativePath, import.meta.url))
  const image = PNG.sync.read(readFileSync(path))
  let left = image.width
  let top = image.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if ((image.data[(y * image.width + x) * 4 + 3] ?? 0) < 8) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  return { width: right - left + 1, height: bottom - top + 1 }
}

function brightNeutralAlphaEdgePixelCount(relativePath: string): number {
  const image = PNG.sync.read(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url))))
  const alphaAt = (x: number, y: number): number => {
    if (x < 0 || x >= image.width || y < 0 || y >= image.height) return 0
    return image.data[(y * image.width + x) * 4 + 3] ?? 0
  }
  let count = 0
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = (y * image.width + x) * 4
      if (alphaAt(x, y) < 8) continue
      if (
        ![alphaAt(x - 1, y), alphaAt(x + 1, y), alphaAt(x, y - 1), alphaAt(x, y + 1)].some(
          (alpha) => alpha < 8,
        )
      )
        continue
      const red = image.data[index] ?? 0
      const green = image.data[index + 1] ?? 0
      const blue = image.data[index + 2] ?? 0
      if (
        Math.max(red, green, blue) - Math.min(red, green, blue) <= 16 &&
        (red + green + blue) / 3 >= 150
      )
        count += 1
    }
  }
  return count
}

function alphaGeometry(relativePath: string): AlphaGeometry {
  const path = fileURLToPath(new URL(relativePath, import.meta.url))
  const image = PNG.sync.read(readFileSync(path))
  let left = image.width
  let top = image.height
  let right = -1
  let bottom = -1
  let alphaTotal = 0
  let weightedX = 0
  let weightedY = 0
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = image.data[(y * image.width + x) * 4 + 3] ?? 0
      if (alpha < 8) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
      alphaTotal += alpha
      weightedX += x * alpha
      weightedY += y * alpha
    }
  }
  if (alphaTotal === 0) throw new Error(`Asset has no visible pixels: ${relativePath}`)
  return {
    left,
    top,
    right,
    bottom,
    centroidX: weightedX / alphaTotal,
    centroidY: weightedY / alphaTotal,
  }
}

function mutableCatalog(): Record<string, unknown>[] {
  return structuredClone(presentationDocument.atlases) as Record<string, unknown>[]
}

function catalogEntry(catalog: Record<string, unknown>[], index: number): Record<string, unknown> {
  const entry = catalog[index]
  if (entry === undefined) throw new Error(`Catalog entry ${index} is missing.`)
  return entry
}

function catalogLayers(entry: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(entry.layers)) throw new Error('Layered atlas is missing layers.')
  return entry.layers as Record<string, unknown>[]
}

function frameGrid(entry: Record<string, unknown>): Record<string, unknown> {
  const frames = entry.frames
  if (typeof frames !== 'object' || frames === null || Array.isArray(frames)) {
    throw new Error('Atlas is missing frames.')
  }
  return frames as Record<string, unknown>
}

describe('Three Branches asset catalog', () => {
  it('keeps the dedicated bridge material page full-colour and non-tintable', () => {
    const bridges = THREE_BRANCHES_ASSET_CATALOG.find((atlas) => atlas.name === 'bridges')
    if (bridges === undefined || 'layers' in bridges) {
      throw new Error('The dedicated bridges atlas group is required.')
    }
    expect(bridges.format).toBe('full-color')
    expect(bridges.tintable).toBe(false)
    expect(bridges.frames.names).toEqual(['boards'])
  })

  it('keeps stalls and pines on mipmapped atlas groups', () => {
    const props = THREE_BRANCHES_ASSET_CATALOG.find((atlas) => atlas.name === 'props')
    const scenery = THREE_BRANCHES_ASSET_CATALOG.find((atlas) => atlas.name === 'scenery')
    if (props === undefined || scenery === undefined || 'layers' in props || 'layers' in scenery) {
      throw new Error('Props and scenery atlas groups are required.')
    }

    expect(props.mipmaps).toBe(true)
    expect(props.frames.names).toEqual(
      expect.arrayContaining(['stallAOpen', 'stallBOpen', 'stallCOpen']),
    )
    expect(scenery.mipmaps).toBe(true)
    expect(scenery.frames.names).toEqual(
      expect.arrayContaining(['pineA', 'pineB', 'pineC', 'pineD', 'pineE', 'pineF']),
    )
  })

  it('keeps the four cast sets on one full-color registered page', () => {
    const characters = THREE_BRANCHES_ASSET_CATALOG.find((atlas) => atlas.name === 'characters')
    if (characters === undefined || 'layers' in characters) {
      throw new Error('Character atlas group is required.')
    }
    expect(characters).toMatchObject({
      width: 576,
      height: 768,
      tintable: false,
      format: 'full-color',
      mipmaps: true,
      frames: { width: 192, height: 192, columns: 3, rows: 4 },
    })
    expect(characters.frames.names).toEqual([
      'visitorBase',
      'visitorLeftArm',
      'visitorRightArm',
      'feltCapBase',
      'feltCapLeftArm',
      'feltCapRightArm',
      'quiltedCapBase',
      'quiltedCapLeftArm',
      'quiltedCapRightArm',
      'linenBonnetBase',
      'linenBonnetLeftArm',
      'linenBonnetRightArm',
    ])
  })

  it('keeps one clean, mipmapped full-roof page for each semantic building type', () => {
    const buildings = THREE_BRANCHES_ASSET_CATALOG.find((atlas) => atlas.name === 'buildings')
    if (buildings === undefined || !('layers' in buildings)) {
      throw new Error('Layered buildings atlas group is required.')
    }

    expect(buildings.mipmaps).toBe(true)
    const expected = {
      home: { width: 1024, height: 896 },
      inn: { width: 1536, height: 1280 },
      shed: { width: 1024, height: 1024 },
    } as const
    expect(buildings.layers.map((layer) => layer.name)).toEqual(Object.keys(expected))
    for (const layer of buildings.layers) {
      const dimensions = expected[layer.name as keyof typeof expected]
      expect(layer).toMatchObject({
        ...dimensions,
        frames: { width: dimensions.width, height: dimensions.height, names: [layer.name] },
      })
      expect(readPngHeader(layer.path)).toMatchObject(dimensions)
      expect(readPngHeader(layer.cells[0]?.source.path ?? '')).toMatchObject({
        ...dimensions,
        colorType: 6,
      })
      expect(coloredTransparentPixelCount(layer.cells[0]?.source.path ?? '')).toBe(0)
    }
  })

  it('accepts arbitrary catalog group and layer names while rejecting duplicate and malformed entries', () => {
    const arbitraryNames = mutableCatalog()
    catalogEntry(arbitraryNames, 0).name = 'meadows'
    const residents = arbitraryNames.find((entry) => entry.name === 'buildings')
    if (residents === undefined) throw new Error('Buildings catalog entry is missing.')
    residents.name = 'residents'
    catalogEntry(catalogLayers(residents), 0).name = 'forms'
    const parsed = readThreeBranchesAssetCatalog(arbitraryNames)
    expect(parsed.map((atlas) => atlas.name)).toContain('meadows')
    const parsedResidents = parsed.find((atlas) => atlas.name === 'residents')
    expect(
      parsedResidents && 'layers' in parsedResidents ? parsedResidents.layers[0]?.name : null,
    ).toBe('forms')

    const duplicateNames = mutableCatalog()
    const duplicateNameEntry = duplicateNames.find((entry) => entry.name === 'bridges')
    if (duplicateNameEntry === undefined) throw new Error('Bridges catalog entry is missing.')
    duplicateNameEntry.name = 'terrain'
    expect(() => readThreeBranchesAssetCatalog(duplicateNames)).toThrow(
      'must not contain duplicate atlas groups',
    )

    const duplicateLayers = mutableCatalog()
    const buildings = duplicateLayers.find((entry) => entry.name === 'buildings')
    if (buildings === undefined) throw new Error('Buildings catalog entry is missing.')
    const layers = catalogLayers(buildings)
    catalogEntry(layers, 1).name = catalogEntry(layers, 0).name
    expect(() => readThreeBranchesAssetCatalog(duplicateLayers)).toThrow(
      'must not contain duplicate layer names',
    )

    const duplicatePaths = mutableCatalog()
    const duplicatePathEntry = duplicatePaths.find((entry) => entry.name === 'props')
    const terrainPathEntry = duplicatePaths.find((entry) => entry.name === 'terrain')
    if (duplicatePathEntry === undefined || terrainPathEntry === undefined) {
      throw new Error('Terrain and props catalog entries are missing.')
    }
    duplicatePathEntry.path = terrainPathEntry.path
    expect(() => readThreeBranchesAssetCatalog(duplicatePaths)).toThrow(
      'must not reuse runtime paths',
    )

    const unsafeGroup = mutableCatalog()
    catalogEntry(unsafeGroup, 0).name = '../meadows'
    expect(() => readThreeBranchesAssetCatalog(unsafeGroup)).toThrow('must be a safe path segment')

    const unsafeFrame = mutableCatalog()
    const propsEntry = unsafeFrame.find((entry) => entry.name === 'props')
    if (propsEntry === undefined) throw new Error('Props catalog entry is missing.')
    const cells = frameGrid(propsEntry).cells as Record<string, unknown>[]
    const firstCell = cells[0]
    if (firstCell === undefined) throw new Error('Props cell is missing.')
    firstCell.name = '../stall'
    expect(() => readThreeBranchesAssetCatalog(unsafeFrame)).toThrow('must be a safe filename stem')

    const nestedRuntimePath = mutableCatalog()
    catalogEntry(nestedRuntimePath, 0).path = './assets/nested/terrain-atlas.png'
    expect(() => readThreeBranchesAssetCatalog(nestedRuntimePath)).toThrow(
      'must be a direct ./assets/<safe>-atlas.png path',
    )

    const unsafeSourcePath = mutableCatalog()
    const terrainCells = frameGrid(catalogEntry(unsafeSourcePath, 0)).cells as Record<
      string,
      unknown
    >[]
    const terrainCell = terrainCells[0]
    if (terrainCell === undefined) throw new Error('Terrain cell is missing.')
    terrainCell.source = { path: './assets/source-art/../terrain.png' }
    expect(() => readThreeBranchesAssetCatalog(unsafeSourcePath)).toThrow(
      'must be a renderer-relative POSIX PNG path',
    )

    const malformedEntry = mutableCatalog()
    const malformedProps = malformedEntry.find((entry) => entry.name === 'props')
    if (malformedProps === undefined) throw new Error('Props catalog entry is missing.')
    malformedProps.mipmaps = 'yes'
    expect(() => readThreeBranchesAssetCatalog(malformedEntry)).toThrow('mipmaps must be boolean')
  })

  it('derives build pages entirely from configured source cells', () => {
    const props = ATLAS_PAGES.find((page) => page.group === 'props')
    expect(props?.cells.map((cell) => cell.source.path)).toEqual(
      expect.arrayContaining([
        './assets/source-art/stall/a/open.png',
        './assets/source-art/stall/a/closed.png',
        './assets/source-art/stall/b/open.png',
        './assets/source-art/stall/b/closed.png',
        './assets/source-art/stall/c/open.png',
        './assets/source-art/stall/c/closed.png',
        './assets/source-art/frames/props/repairBenchBusy.png',
        './assets/source-art/frames/bell/bellBase.png',
        './assets/source-art/frames/bell/bellStriker.png',
        './assets/source-art/frames/monuments/pump.png',
        './assets/source-art/frames/lantern/lanternLit.png',
        './assets/source-art/frames/lantern/lanternUnlit.png',
      ]),
    )
    const board = props?.cells.find((cell) => cell.name === 'boardNone')
    expect(board).toEqual({
      name: 'boardNone',
      source: { path: './assets/source-art/frames/props/boardNone.png' },
      render: {
        kind: 'fitVisible',
        sourceAlpha: { clearAtOrBelow: 0, opaqueAtOrAbove: 255 },
        bounds: { alphaAbove: 0 },
        maxSize: { width: 252, height: 252 },
        anchor: { x: 192, y: 128 },
        resampler: 'bilinear-premultiplied-encoded-rgb',
        outputAlpha: { clearAtOrBelow: 0, clearColorAtZero: true },
      },
    })
    expect(readPngHeader(board?.source.path ?? '')).toMatchObject({
      width: 512,
      height: 512,
      colorType: 6,
    })
    expect(coloredTransparentPixelCount(board?.source.path ?? '')).toBe(0)
    expect(props?.cells.slice(-3)).toEqual([
      { name: 'pump', source: { path: './assets/source-art/frames/monuments/pump.png' } },
      {
        name: 'lanternLit',
        source: {
          path: './assets/source-art/frames/lantern/lanternLit.png',
          crop: { x: 0, y: 128, width: 384, height: 256 },
        },
      },
      {
        name: 'lanternUnlit',
        source: {
          path: './assets/source-art/frames/lantern/lanternUnlit.png',
          crop: { x: 0, y: 128, width: 384, height: 256 },
        },
      },
    ])
    expect(ATLAS_PAGES.some((page) => page.group === 'lantern')).toBe(false)
    expect(ATLAS_PAGES.some((page) => page.group === 'monuments')).toBe(false)
    expect(ATLAS_PAGES.some((page) => page.group === 'bell')).toBe(false)
    const scenery = ATLAS_PAGES.find((page) => page.group === 'scenery')
    expect(scenery?.cells.at(-1)?.source.path).toBe(
      './assets/source-art/frames/scenery/marketCrate.png',
    )
  })

  it('keeps the configured thumbnail source decodable and the runtime image at output dimensions', () => {
    const source = readPngHeader(THREE_BRANCHES_THUMBNAIL_ASSET.source)
    const runtime = readPngHeader(THREE_BRANCHES_THUMBNAIL_ASSET.path)

    expect(source.width).toBeGreaterThan(0)
    expect(source.height).toBeGreaterThan(0)
    expect(runtime).toEqual({
      width: THREE_BRANCHES_THUMBNAIL_ASSET.width,
      height: THREE_BRANCHES_THUMBNAIL_ASSET.height,
      colorType: 2,
    })
  })

  it('keeps lantern sources centered when cropped into shared props frames', () => {
    for (const sourcePath of [
      './assets/source-art/frames/lantern/lanternLit.png',
      './assets/source-art/frames/lantern/lanternUnlit.png',
    ]) {
      expect(readPngHeader(sourcePath)).toMatchObject({ width: 384, height: 512 })
      expect(alphaGeometry(sourcePath)).toMatchObject({
        left: 76,
        top: 140,
        right: 307,
        bottom: 371,
      })
    }
  })

  it('clears hidden color from fully transparent lantern pixels', () => {
    expect(coloredTransparentPixelCount('./assets/source-art/frames/lantern/lanternLit.png')).toBe(
      0,
    )
    expect(
      coloredTransparentPixelCount('./assets/source-art/frames/lantern/lanternUnlit.png'),
    ).toBe(0)
  })

  it('keeps shrine state art on one centered registration', () => {
    const untendedPath = './assets/source-art/frames/props/shrineUntended.png'
    const tendedPath = './assets/source-art/frames/props/shrineTended.png'
    expect(readPngHeader(untendedPath)).toMatchObject({ width: 384, height: 256, colorType: 6 })
    expect(readPngHeader(tendedPath)).toMatchObject({ width: 384, height: 256, colorType: 6 })
    expect(coloredTransparentPixelCount(untendedPath)).toBe(0)
    expect(coloredTransparentPixelCount(tendedPath)).toBe(0)

    const untended = alphaGeometry(untendedPath)
    const tended = alphaGeometry(tendedPath)
    for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
      expect(Math.abs(tended[edge] - untended[edge])).toBeLessThanOrEqual(1)
    }
    expect(Math.abs(tended.centroidX - untended.centroidX)).toBeLessThanOrEqual(1)
    expect(Math.abs(tended.centroidY - untended.centroidY)).toBeLessThanOrEqual(1)
  })

  it('keeps the market crate square in its canonical source', () => {
    const sourcePath = './assets/source-art/frames/scenery/marketCrate.png'
    expect(readPngHeader(sourcePath)).toMatchObject({ width: 512, height: 512 })
    const bounds = alphaBounds(sourcePath)
    expect(
      Math.max(bounds.width, bounds.height) / Math.min(bounds.width, bounds.height),
    ).toBeLessThan(1.05)
    expect(coloredTransparentPixelCount(sourcePath)).toBe(0)
  })

  it('preserves the approved bell proportions in its canonical source layers', () => {
    const basePath = './assets/source-art/frames/bell/bellBase.png'
    const strikerPath = './assets/source-art/frames/bell/bellStriker.png'
    expect(readPngHeader(basePath)).toMatchObject({ width: 384, height: 256 })
    expect(readPngHeader(strikerPath)).toMatchObject({ width: 384, height: 256 })
    expect(alphaBounds(basePath)).toEqual({ width: 232, height: 232 })
    const strikerBounds = alphaBounds(strikerPath)
    expect(strikerBounds).toEqual({ width: 40, height: 123 })
    expect(Math.abs(strikerBounds.width / strikerBounds.height - 41 / 124)).toBeLessThan(0.01)
    expect(coloredTransparentPixelCount(basePath)).toBe(0)
    expect(coloredTransparentPixelCount(strikerPath)).toBe(0)
    expect(brightNeutralAlphaEdgePixelCount(strikerPath)).toBe(0)
  })

  it('loads every configured runtime page without superseded prop atlases', async () => {
    const load = vi.fn((source: string) => source)
    const assets = await loadThreeBranchesRuntimeAssets(load)
    const sources = load.mock.calls.map(([source]) => source)

    expect(load).toHaveBeenCalledTimes(ATLAS_PAGES.length)
    expect(assets.terrain).toMatch(/terrain-atlas\.png/)
    expect(assets.bridges).toMatch(/bridges-atlas\.png/)
    expect(assets.characters).toMatch(/characters-atlas\.png/)
    expect(assets.effects).toMatch(/effects-atlas\.png/)
    expect(assets.buildings.home).toMatch(/buildings-home-atlas\.png/)
    expect(assets.buildings.inn).toMatch(/buildings-inn-atlas\.png/)
    expect(assets.buildings.shed).toMatch(/buildings-shed-atlas\.png/)
    expect(sources.some((source) => /props-atlas/.test(source))).toBe(true)
    expect(sources.some((source) => /lantern-atlas/.test(source))).toBe(false)
    expect(sources.some((source) => /monuments-atlas/.test(source))).toBe(false)
    expect(sources.some((source) => /bell-atlas/.test(source))).toBe(false)
    expect(sources.some((source) => /scenery-atlas/.test(source))).toBe(true)
    expect(sources.some((source) => /buildings/.test(source))).toBe(true)
  })

  it('requests generated mipmaps for every runtime page in the configured atlas groups', async () => {
    const load = vi.fn((source: string, options?: ThreeBranchesRuntimeAssetLoadOptions) => ({
      source,
      options,
    }))

    await loadThreeBranchesRuntimeAssets(load)

    const mipmappedCalls = load.mock.calls.filter(([, options]) => options !== undefined)
    const mipmappedSources = mipmappedCalls.map(([source]) => source)
    expect(mipmappedSources).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/props-atlas\.png/),
        expect.stringMatching(/scenery-atlas\.png/),
        expect.stringMatching(/buildings-home-atlas\.png/),
        expect.stringMatching(/buildings-inn-atlas\.png/),
        expect.stringMatching(/buildings-shed-atlas\.png/),
      ]),
    )
    expect(mipmappedSources).toHaveLength(6)
    for (const [, options] of mipmappedCalls) {
      expect(options).toEqual({ autoGenerateMipmaps: true })
    }
  })
})
