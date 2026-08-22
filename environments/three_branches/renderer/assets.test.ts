import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { describe, expect, it, vi } from 'vitest'

import type { ThreeBranchesRuntimeAssetLoadOptions } from './assets.js'
import {
  ATLAS_PAGES,
  loadThreeBranchesRuntimeAssets,
  THREE_BRANCHES_ASSET_CATALOG,
  THREE_BRANCHES_THUMBNAIL_ASSET,
} from './assets.js'

interface PngHeader {
  width: number
  height: number
  colorType: number
}

interface RasterAsset {
  source: string
  sourceWidth: number
  sourceHeight: number
  path: string
  width: number
  height: number
  frames: {
    width: number
    height: number
    columns: number
    rows: number
    names: readonly string[]
  }
}

function rastersFor(atlas: (typeof THREE_BRANCHES_ASSET_CATALOG)[number]): readonly RasterAsset[] {
  return 'layers' in atlas ? atlas.layers : [atlas]
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

describe('Three Branches asset catalog', () => {
  it('catalogs the nine declared atlas groups with named frame prefixes', () => {
    expect(THREE_BRANCHES_ASSET_CATALOG.map((atlas) => atlas.name)).toEqual([
      'terrain',
      'buildings',
      'props',
      'lantern',
      'monuments',
      'bell',
      'scenery',
      'characters',
      'effects',
    ])

    for (const atlas of THREE_BRANCHES_ASSET_CATALOG) {
      expect(atlas.tintable).toBe(atlas.format === 'grayscale-alpha')
      for (const raster of rastersFor(atlas)) {
        expect(raster.frames.names.length).toBeLessThanOrEqual(
          raster.frames.columns * raster.frames.rows,
        )
        expect(new Set(raster.frames.names).size).toBe(raster.frames.names.length)
        expect(raster.frames.width * raster.frames.columns).toBe(raster.width)
        expect(raster.frames.height * raster.frames.rows).toBe(raster.height)
      }
    }

    const props = THREE_BRANCHES_ASSET_CATALOG.find((atlas) => atlas.name === 'props')
    expect(props && !('layers' in props) ? props.frames.names : []).toHaveLength(17)
    expect(props && !('layers' in props) ? props.frames.names : []).toEqual(
      expect.arrayContaining([
        'stallAOpen',
        'stallAClosed',
        'stallBOpen',
        'stallBClosed',
        'stallCOpen',
        'stallCClosed',
      ]),
    )
    expect(props && !('layers' in props) ? props.frames.names : []).not.toEqual(
      expect.arrayContaining(['lanternLit', 'lanternUnlit', 'pumpFlowing', 'pumpIdle']),
    )

    const lantern = THREE_BRANCHES_ASSET_CATALOG.find((atlas) => atlas.name === 'lantern')
    expect(lantern && !('layers' in lantern) ? lantern : null).toMatchObject({
      sourceWidth: 2048,
      sourceHeight: 1536,
      width: 768,
      height: 512,
      tintable: false,
      format: 'full-color',
      frames: {
        width: 384,
        height: 512,
        columns: 2,
        rows: 1,
        names: ['lanternLit', 'lanternUnlit'],
      },
    })

    const monuments = THREE_BRANCHES_ASSET_CATALOG.find((atlas) => atlas.name === 'monuments')
    expect(monuments && !('layers' in monuments) ? monuments.frames.names : []).toEqual([
      'pumpFlowing',
      'pumpIdle',
    ])

    const bell = THREE_BRANCHES_ASSET_CATALOG.find((atlas) => atlas.name === 'bell')
    expect(bell && !('layers' in bell) ? bell : null).toMatchObject({
      sourceWidth: 4608,
      sourceHeight: 1024,
      width: 4608,
      height: 1024,
      tintable: false,
      format: 'full-color',
      consumer: 'bell foundation, fixed gantry, and separately animated bell',
      frames: {
        width: 1536,
        height: 1024,
        columns: 3,
        rows: 1,
        names: ['bellFoundation', 'bellGantry', 'bellMoving'],
      },
    })

    const scenery = THREE_BRANCHES_ASSET_CATALOG.find((atlas) => atlas.name === 'scenery')
    expect(scenery && !('layers' in scenery) ? scenery : null).toMatchObject({
      sourceWidth: 2048,
      sourceHeight: 1024,
      width: 2048,
      height: 1024,
      tintable: false,
      format: 'full-color',
      frames: {
        width: 512,
        height: 512,
        columns: 4,
        rows: 2,
        names: ['pineA', 'pineB', 'pineC', 'pineD', 'pineE', 'pineF', 'marketCrate'],
      },
    })

    const characters = THREE_BRANCHES_ASSET_CATALOG.find((atlas) => atlas.name === 'characters')
    expect(
      characters && 'layers' in characters ? characters.layers.map((layer) => layer.name) : [],
    ).toEqual(['body', 'clothing', 'arms', 'details'])
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

  it('requests generated mipmaps only for the interactive prop atlases', async () => {
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
      ]),
    )
    expect(mipmappedSources).toHaveLength(4)
    for (const [, options] of mipmappedCalls) {
      expect(options).toEqual({ autoGenerateMipmaps: true })
    }
  })
})
