import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

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

describe('Three Branches asset catalog', () => {
  it('catalogs the six approved atlas groups with complete frame grids', () => {
    expect(THREE_BRANCHES_ASSET_CATALOG.map((atlas) => atlas.name)).toEqual([
      'terrain',
      'buildings',
      'props',
      'scenery',
      'characters',
      'effects',
    ])

    for (const atlas of THREE_BRANCHES_ASSET_CATALOG) {
      expect(atlas.tintable).toBe(atlas.format === 'grayscale-alpha')
      for (const raster of rastersFor(atlas)) {
        expect(raster.frames.names).toHaveLength(raster.frames.columns * raster.frames.rows)
        expect(new Set(raster.frames.names).size).toBe(raster.frames.names.length)
        expect(raster.frames.width * raster.frames.columns).toBe(raster.width)
        expect(raster.frames.height * raster.frames.rows).toBe(raster.height)
      }
    }

    const characters = THREE_BRANCHES_ASSET_CATALOG.find((atlas) => atlas.name === 'characters')
    expect(
      characters && 'layers' in characters ? characters.layers.map((layer) => layer.name) : [],
    ).toEqual(['body', 'clothing', 'arms', 'details'])
  })

  it('derives nested prop paths from camel-case frame names', () => {
    const props = ATLAS_PAGES.find((page) => page.group === 'props')
    expect(props?.framePaths).toEqual(
      expect.arrayContaining([
        'stall/base.png',
        'repair_bench/base.png',
        'repair_bench/busy.png',
        'bell/clapper.png',
      ]),
    )
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

  it('loads only the terrain atlas at runtime', async () => {
    const load = vi.fn((source: string) => source)
    const terrain = await loadThreeBranchesRuntimeAssets(load)

    expect(load).toHaveBeenCalledOnce()
    expect(terrain).toMatch(/terrain-atlas\.png/)
  })
})
