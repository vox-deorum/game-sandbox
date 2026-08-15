import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { frameName } from '@renderers/base/atlas/atlas.js'
import { describe, expect, it } from 'vitest'

import {
  ATLAS_PAGES,
  loadThreeBranchesAssets,
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

  it('maps each catalog group to its atlas pages and declared loose frame names', () => {
    expect(new Set(ATLAS_PAGES.map((page) => page.group))).toEqual(
      new Set(THREE_BRANCHES_ASSET_CATALOG.map((atlas) => atlas.name)),
    )
    expect(ATLAS_PAGES).toHaveLength(9)

    for (const atlas of THREE_BRANCHES_ASSET_CATALOG) {
      const pages = ATLAS_PAGES.filter((page) => page.group === atlas.name)
      const rasters = rastersFor(atlas)
      expect(pages).toHaveLength(rasters.length)

      for (const raster of rasters) {
        const page = pages.find((candidate) => candidate.pagePath === raster.path)
        expect(page).toBeDefined()
        if (page === undefined) throw new Error(`Atlas page is missing: ${raster.path}`)
        expect(page).toMatchObject({
          format: atlas.format,
          width: raster.width,
          height: raster.height,
          columns: raster.frames.columns,
          rows: raster.frames.rows,
        })
        expect(page.framePaths.map(frameName)).toEqual(raster.frames.names)
      }
    }
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

  it('loads entries by stable atlas name', async () => {
    const loaded = await loadThreeBranchesAssets((raster) => raster.path)
    expect(loaded.characters).toEqual({
      body: './assets/characters-body-atlas.png',
      clothing: './assets/characters-clothing-atlas.png',
      arms: './assets/characters-arms-atlas.png',
      details: './assets/characters-details-atlas.png',
    })
    expect(loaded.terrain).toBe('./assets/terrain-atlas.png')
  })

})
