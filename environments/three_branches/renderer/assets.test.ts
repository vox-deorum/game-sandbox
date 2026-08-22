import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { describe, expect, it, vi } from 'vitest'

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

function mutableCatalog(): Record<string, unknown>[] {
  return structuredClone(THREE_BRANCHES_ASSET_CATALOG) as unknown as Record<string, unknown>[]
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

  it('accepts arbitrary catalog group and layer names while rejecting duplicate and malformed entries', () => {
    const arbitraryNames = mutableCatalog()
    catalogEntry(arbitraryNames, 0).name = 'meadows'
    const residents = catalogEntry(arbitraryNames, 7)
    residents.name = 'residents'
    catalogEntry(catalogLayers(residents), 0).name = 'forms'
    const parsed = readThreeBranchesAssetCatalog(arbitraryNames)
    expect(parsed.map((atlas) => atlas.name)).toContain('meadows')
    const parsedResidents = parsed.find((atlas) => atlas.name === 'residents')
    expect(
      parsedResidents && 'layers' in parsedResidents ? parsedResidents.layers[0]?.name : null,
    ).toBe('forms')

    const duplicateNames = mutableCatalog()
    catalogEntry(duplicateNames, 1).name = 'terrain'
    expect(() => readThreeBranchesAssetCatalog(duplicateNames)).toThrow(
      'must not contain duplicate atlas groups',
    )

    const duplicateLayers = mutableCatalog()
    const layers = catalogLayers(catalogEntry(duplicateLayers, 7))
    catalogEntry(layers, 1).name = catalogEntry(layers, 0).name
    expect(() => readThreeBranchesAssetCatalog(duplicateLayers)).toThrow(
      'must not contain duplicate layer names',
    )

    const duplicatePaths = mutableCatalog()
    catalogEntry(duplicatePaths, 1).path = catalogEntry(duplicatePaths, 0).path
    expect(() => readThreeBranchesAssetCatalog(duplicatePaths)).toThrow(
      'must not reuse runtime paths',
    )

    const unsafeGroup = mutableCatalog()
    catalogEntry(unsafeGroup, 0).name = '../meadows'
    expect(() => readThreeBranchesAssetCatalog(unsafeGroup)).toThrow('must be a safe path segment')

    const unsafeFrame = mutableCatalog()
    frameGrid(catalogEntry(unsafeFrame, 2)).names = ['../stall']
    expect(() => readThreeBranchesAssetCatalog(unsafeFrame)).toThrow('must be a safe filename stem')

    const nestedRuntimePath = mutableCatalog()
    catalogEntry(nestedRuntimePath, 0).path = './assets/nested/terrain-atlas.png'
    expect(() => readThreeBranchesAssetCatalog(nestedRuntimePath)).toThrow(
      'must be a direct ./assets/<safe>-atlas.png path',
    )

    const unsafeSourcePath = mutableCatalog()
    catalogEntry(unsafeSourcePath, 0).source = './assets/source-art/../terrain-atlas-source.png'
    expect(() => readThreeBranchesAssetCatalog(unsafeSourcePath)).toThrow(
      'must be a renderer-relative POSIX PNG path',
    )

    const malformedEntry = mutableCatalog()
    catalogEntry(malformedEntry, 2).mipmaps = 'yes'
    expect(() => readThreeBranchesAssetCatalog(malformedEntry)).toThrow('mipmaps must be boolean')
  })

  it('derives nested ordinary-prop paths and gives lantern frames their dedicated page', () => {
    const props = ATLAS_PAGES.find((page) => page.group === 'props')
    expect(props?.framePaths).toEqual(
      expect.arrayContaining([
        'stall/open.png',
        'stall/closed.png',
        'stall/b/open.png',
        'stall/b/closed.png',
        'stall/c/open.png',
        'stall/c/closed.png',
        'repair_bench/busy.png',
      ]),
    )
    expect(props?.framePaths).not.toEqual(
      expect.arrayContaining([
        'pump/flowing.png',
        'pump/idle.png',
        'bell/ringing.png',
        'bell/silent.png',
        'lantern/lit.png',
        'lantern/unlit.png',
      ]),
    )
    const lantern = ATLAS_PAGES.find((page) => page.group === 'lantern')
    expect(lantern).toMatchObject({
      framesPath: './assets/lantern',
      framePaths: ['lit.png', 'unlit.png'],
      width: 768,
      height: 512,
      columns: 2,
      rows: 1,
    })
    const monuments = ATLAS_PAGES.find((page) => page.group === 'monuments')
    expect(monuments?.framePaths).toEqual(['pump/flowing.png', 'pump/idle.png'])
    const bell = ATLAS_PAGES.find((page) => page.group === 'bell')
    expect(bell).toMatchObject({
      framesPath: './assets/bell',
      framePaths: ['foundation.png', 'gantry.png', 'moving.png'],
      width: 4608,
      height: 1024,
      columns: 3,
      rows: 1,
    })
    const scenery = ATLAS_PAGES.find((page) => page.group === 'scenery')
    expect(scenery?.framePaths).toEqual([
      'pineA.png',
      'pineB.png',
      'pineC.png',
      'pineD.png',
      'pineE.png',
      'pineF.png',
      'marketCrate.png',
    ])
  })

  it('keeps the generated thumbnail source and runtime image at their declared dimensions', () => {
    const source = readPngHeader(THREE_BRANCHES_THUMBNAIL_ASSET.source)
    const runtime = readPngHeader(THREE_BRANCHES_THUMBNAIL_ASSET.path)

    expect(source).toMatchObject({
      width: THREE_BRANCHES_THUMBNAIL_ASSET.sourceWidth,
      height: THREE_BRANCHES_THUMBNAIL_ASSET.sourceHeight,
    })
    expect(runtime).toEqual({
      width: THREE_BRANCHES_THUMBNAIL_ASSET.width,
      height: THREE_BRANCHES_THUMBNAIL_ASSET.height,
      colorType: 2,
    })
  })

  it('keeps the dedicated lantern source, frames, and packed page at their declared dimensions', () => {
    const lantern = THREE_BRANCHES_ASSET_CATALOG.find((atlas) => atlas.name === 'lantern')
    if (lantern === undefined || 'layers' in lantern) throw new Error('Lantern atlas is missing')

    expect(readPngHeader(lantern.source)).toMatchObject({
      width: lantern.sourceWidth,
      height: lantern.sourceHeight,
    })
    expect(readPngHeader(lantern.path)).toMatchObject({
      width: lantern.width,
      height: lantern.height,
    })
    expect(readPngHeader('./assets/lantern/lit.png')).toMatchObject({ width: 384, height: 512 })
    expect(readPngHeader('./assets/lantern/unlit.png')).toMatchObject({ width: 384, height: 512 })
  })

  it('clears hidden color from fully transparent lantern pixels', () => {
    expect(coloredTransparentPixelCount('./assets/lantern/lit.png')).toBe(0)
    expect(coloredTransparentPixelCount('./assets/lantern/unlit.png')).toBe(0)
  })

  it('keeps the market crate square in its runtime frame and retained source', () => {
    const runtimePath = './assets/scenery/marketCrate.png'
    const sourcePath = './assets/source-art/scenery/marketCrate.png'
    expect(readPngHeader(runtimePath)).toMatchObject({ width: 512, height: 512 })
    expect(readPngHeader(sourcePath)).toMatchObject({ width: 1254, height: 1254 })
    for (const path of [runtimePath, sourcePath]) {
      const bounds = alphaBounds(path)
      expect(
        Math.max(bounds.width, bounds.height) / Math.min(bounds.width, bounds.height),
      ).toBeLessThan(1.05)
      expect(coloredTransparentPixelCount(path)).toBe(0)
    }
  })

  it('loads all twelve shipped runtime pages including dedicated lantern and bell atlases', async () => {
    const load = vi.fn((source: string) => source)
    const assets = await loadThreeBranchesRuntimeAssets(load)
    const sources = load.mock.calls.map(([source]) => source)

    expect(load).toHaveBeenCalledTimes(12)
    expect(assets.terrain).toMatch(/terrain-atlas\.png/)
    expect(assets.characters.body).toMatch(/characters-body-atlas\.png/)
    expect(assets.characters.clothing).toMatch(/characters-clothing-atlas\.png/)
    expect(assets.characters.arms).toMatch(/characters-arms-atlas\.png/)
    expect(assets.characters.details).toMatch(/characters-details-atlas\.png/)
    expect(assets.effects).toMatch(/effects-atlas\.png/)
    expect(assets.lantern).toMatch(/lantern-atlas\.png/)
    expect(assets.monuments).toMatch(/monuments-atlas\.png/)
    expect(assets.bell).toMatch(/bell-atlas\.png/)
    expect(assets.buildings).toMatch(/buildings-atlas\.png/)
    expect(sources.some((source) => /props-atlas/.test(source))).toBe(true)
    expect(sources.some((source) => /lantern-atlas/.test(source))).toBe(true)
    expect(sources.some((source) => /monuments-atlas/.test(source))).toBe(true)
    expect(sources.some((source) => /bell-atlas/.test(source))).toBe(true)
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
        expect.stringMatching(/lantern-atlas\.png/),
        expect.stringMatching(/monuments-atlas\.png/),
        expect.stringMatching(/bell-atlas\.png/),
        expect.stringMatching(/scenery-atlas\.png/),
      ]),
    )
    expect(mipmappedSources).toHaveLength(5)
    for (const [, options] of mipmappedCalls) {
      expect(options).toEqual({ autoGenerateMipmaps: true })
    }
  })

  it('keeps every character layer non-mipmapped when its catalog group disables mipmaps', async () => {
    const load = vi.fn((source: string, options?: ThreeBranchesRuntimeAssetLoadOptions) => ({
      source,
      options,
    }))

    await loadThreeBranchesRuntimeAssets(load)

    for (const [source, options] of load.mock.calls) {
      if (/characters-(body|clothing|arms|details)-atlas\.png/.test(source)) {
        expect(options).toBeUndefined()
      }
    }
  })
})
