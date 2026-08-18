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
  it('catalogs the seven approved atlas groups with named frame prefixes', () => {
    expect(THREE_BRANCHES_ASSET_CATALOG.map((atlas) => atlas.name)).toEqual([
      'terrain',
      'buildings',
      'props',
      'monuments',
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
    expect(props && !('layers' in props) ? props.frames.names : []).toHaveLength(15)
    expect(props && !('layers' in props) ? props.frames.names : []).not.toEqual(
      expect.arrayContaining([
        'pumpFlowing',
        'pumpIdle',
        'bellRinging',
        'bellSilent',
        'bellFoundation',
      ]),
    )

    const monuments = THREE_BRANCHES_ASSET_CATALOG.find((atlas) => atlas.name === 'monuments')
    expect(monuments && !('layers' in monuments) ? monuments.frames.names : []).toEqual([
      'pumpFlowing',
      'pumpIdle',
      'bellRinging',
      'bellSilent',
      'bellFoundation',
    ])

    const characters = THREE_BRANCHES_ASSET_CATALOG.find((atlas) => atlas.name === 'characters')
    expect(
      characters && 'layers' in characters ? characters.layers.map((layer) => layer.name) : [],
    ).toEqual(['body', 'clothing', 'arms', 'details'])
  })

  it('derives nested prop paths from camel-case frame names', () => {
    const props = ATLAS_PAGES.find((page) => page.group === 'props')
    expect(props?.framePaths).toEqual(
      expect.arrayContaining(['stall/open.png', 'lantern/lit.png', 'repair_bench/busy.png']),
    )
    expect(props?.framePaths).not.toEqual(
      expect.arrayContaining([
        'pump/flowing.png',
        'pump/idle.png',
        'bell/ringing.png',
        'bell/silent.png',
      ]),
    )
    const monuments = ATLAS_PAGES.find((page) => page.group === 'monuments')
    expect(monuments?.framePaths).toEqual([
      'pump/flowing.png',
      'pump/idle.png',
      'bell/ringing.png',
      'bell/silent.png',
      'bell/foundation.png',
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

  it('loads every shipped runtime page including the buildings atlas', async () => {
    const load = vi.fn((source: string) => source)
    const assets = await loadThreeBranchesRuntimeAssets(load)
    const sources = load.mock.calls.map(([source]) => source)

    expect(load).toHaveBeenCalledTimes(10)
    expect(assets.terrain).toMatch(/terrain-atlas\.png/)
    expect(assets.characters.body).toMatch(/characters-body-atlas\.png/)
    expect(assets.characters.clothing).toMatch(/characters-clothing-atlas\.png/)
    expect(assets.characters.arms).toMatch(/characters-arms-atlas\.png/)
    expect(assets.characters.details).toMatch(/characters-details-atlas\.png/)
    expect(assets.effects).toMatch(/effects-atlas\.png/)
    expect(assets.monuments).toMatch(/monuments-atlas\.png/)
    expect(assets.buildings).toMatch(/buildings-atlas\.png/)
    expect(sources.some((source) => /props-atlas/.test(source))).toBe(true)
    expect(sources.some((source) => /monuments-atlas/.test(source))).toBe(true)
    expect(sources.some((source) => /scenery-atlas/.test(source))).toBe(true)
    expect(sources.some((source) => /buildings/.test(source))).toBe(true)
  })
})
