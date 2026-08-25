import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  type AtlasBuildPageSpec,
  compareAtlasPixels,
  compileAtlas,
  type RgbaImage,
  validateAtlasBuildPageSpec,
  validateAtlasBuildPages,
} from '../src/renderers/base/atlas/atlas.js'
import {
  buildAtlasPage,
  checkAtlasPage,
  readPng,
  selectAtlasPages,
  writePng,
} from '../src/renderers/base/atlas/atlas-io.js'
import { environmentModuleUrl } from '../src/renderers/base/atlas/cli.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

function spec(overrides: Partial<AtlasBuildPageSpec> = {}): AtlasBuildPageSpec {
  return {
    group: 'terrain',
    pagePath: './assets/sample-atlas.png',
    format: 'full-color',
    width: 4,
    height: 2,
    columns: 2,
    rows: 1,
    cells: [
      { name: 'first', source: { path: './assets/source/first.png' } },
      { name: 'second', source: { path: './assets/source/second.png' } },
    ],
    ...overrides,
  }
}

function image(width: number, height: number, pixels: readonly number[]): RgbaImage {
  return { width, height, data: new Uint8Array(pixels) }
}

async function temporaryRenderer(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'game-sandbox-atlas-'))
  temporaryDirectories.push(directory)
  return directory
}

function sources() {
  return [
    {
      name: 'first',
      image: image(2, 2, [1, 2, 3, 0, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]),
    },
    {
      name: 'second',
      image: image(2, 2, [13, 14, 15, 255, 16, 17, 18, 255, 19, 20, 21, 255, 22, 23, 24, 255]),
    },
  ]
}

describe('atlas source compilation', () => {
  it('copies exact source pixels, including hidden transparent RGB, in row-major order', () => {
    const atlas = compileAtlas(spec(), sources())
    expect([...atlas.data]).toEqual([
      1, 2, 3, 0, 4, 5, 6, 255, 13, 14, 15, 255, 16, 17, 18, 255, 7, 8, 9, 255, 10, 11, 12, 255, 19,
      20, 21, 255, 22, 23, 24, 255,
    ])
  })

  it('leaves unnamed suffix cells transparent and names stale cells', () => {
    const atlasSpec = spec({ width: 6, columns: 3 })
    const atlas = compileAtlas(atlasSpec, sources())
    expect(atlas.data.subarray(16, 24)).toEqual(new Uint8Array(8))
    const stale = { ...atlas, data: new Uint8Array(atlas.data) }
    stale.data[16] = 1
    expect(compareAtlasPixels(atlasSpec, atlas, stale)).toBe('unused cell 2')
  })

  it('area-resizes through premultiplied encoded RGB and clears transparent output color', () => {
    const atlasSpec = spec({
      width: 1,
      height: 1,
      columns: 1,
      rows: 1,
      cells: [
        {
          name: 'resized',
          source: { path: './assets/source/resized.png' },
          render: {
            kind: 'resize',
            resampler: 'area-premultiplied-encoded-rgb',
            outputAlpha: { clearColorAtZero: true },
          },
        },
      ],
    })
    expect(
      compileAtlas(atlasSpec, [
        { name: 'resized', image: image(2, 1, [255, 0, 0, 255, 0, 0, 255, 0]) },
      ]).data,
    ).toEqual(new Uint8Array([255, 0, 0, 128]))
    expect(
      compileAtlas(atlasSpec, [
        { name: 'resized', image: image(2, 1, [99, 88, 77, 0, 4, 3, 2, 0]) },
      ]).data,
    ).toEqual(new Uint8Array([0, 0, 0, 0]))
  })

  it('fits visible pixels after inclusive alpha normalization and supports shared bounds', () => {
    const atlasSpec = spec({
      width: 4,
      height: 2,
      columns: 2,
      cells: [
        {
          name: 'gantry',
          source: { path: './assets/source/gantry.png' },
          render: {
            kind: 'fitVisible',
            sourceAlpha: { clearAtOrBelow: 8, opaqueAtOrAbove: 245 },
            bounds: { alphaAbove: 8 },
            maxSize: { width: 2, height: 2 },
            anchor: { x: 1, y: 1 },
            resampler: 'bilinear-premultiplied-encoded-rgb',
            outputAlpha: { clearAtOrBelow: 0 },
          },
        },
        {
          name: 'moving',
          source: { path: './assets/source/moving.png' },
          render: {
            kind: 'fitVisible',
            sourceAlpha: { clearAtOrBelow: 8, opaqueAtOrAbove: 245 },
            bounds: { alphaAbove: 8, fromCell: 'gantry' },
            maxSize: { width: 2, height: 2 },
            anchor: { x: 1, bottom: 2 },
            resampler: 'bilinear-premultiplied-encoded-rgb',
            outputAlpha: { clearAtOrBelow: 0 },
          },
        },
      ],
    })
    const atlas = compileAtlas(atlasSpec, [
      { name: 'gantry', image: image(2, 2, [1, 1, 1, 8, 0, 0, 0, 245, 0, 0, 0, 9, 0, 0, 0, 0]) },
      {
        name: 'moving',
        image: image(2, 2, [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0]),
      },
    ])
    expect([...atlas.data.subarray(0, 16)]).toContain(255)
    expect([...atlas.data.subarray(16, 32)]).toContain(255)
  })

  it('rejects invalid configuration, source memberships, cycles, crops, clipping, and colored grayscale', () => {
    expect(() => validateAtlasBuildPageSpec(spec({ width: 5 }))).toThrow('divide evenly')
    expect(() => validateAtlasBuildPageSpec(spec({ cells: [] }))).toThrow('at least one cell')
    expect(() =>
      validateAtlasBuildPageSpec(
        spec({ cells: [{ name: 'one', source: { path: '../escape.png' } }] }),
      ),
    ).toThrow('renderer-relative POSIX')
    expect(() =>
      validateAtlasBuildPageSpec(
        spec({
          pagePath: './assets/page.png',
          cells: [{ name: 'one', source: { path: './assets/./page.png' } }],
        }),
      ),
    ).toThrow('renderer-relative POSIX')
    expect(() =>
      validateAtlasBuildPageSpec(
        spec({
          cells: [{ name: 'one', source: { path: './one.png' }, render: { kind: 'bad' } as never }],
        }),
      ),
    ).toThrow('unknown render kind')
    expect(() =>
      validateAtlasBuildPageSpec(
        spec({
          cells: [
            {
              name: 'one',
              source: { path: './one.png' },
              render: { kind: 'resize', resampler: 'area-premultiplied-encoded-rgb' } as never,
            },
          ],
        }),
      ),
    ).toThrow('output alpha is required')
    expect(() =>
      validateAtlasBuildPageSpec(
        spec({
          cells: [
            {
              name: 'one',
              source: { path: './one.png' },
              render: {
                kind: 'fitVisible',
                sourceAlpha: { clearAtOrBelow: 1 },
                bounds: { alphaAbove: 1, fromCell: 'one' },
                maxSize: { width: 1, height: 1 },
                anchor: { x: 0, y: 0 },
                resampler: 'bilinear-premultiplied-encoded-rgb',
                outputAlpha: { clearAtOrBelow: 0 },
              },
            },
          ],
        }),
      ),
    ).toThrow('cycle')
    expect(() =>
      compileAtlas(
        spec({
          cells: [
            {
              name: 'one',
              source: { path: './one.png', crop: { x: 1, y: 0, width: 2, height: 1 } },
            },
          ],
        }),
        [{ name: 'one', image: image(2, 1, new Array(8).fill(0)) }],
      ),
    ).toThrow('crop exceeds')
    expect(() => compileAtlas(spec({ format: 'grayscale-alpha' }), sources())).toThrow(
      'not grayscale-alpha',
    )
  })

  it('validates environment page keys and selects one page key or a whole group', () => {
    const pages = [
      spec({ group: 'characters', pageKey: 'characters/body' }),
      spec({
        group: 'characters',
        pageKey: 'characters/clothing',
        pagePath: './assets/clothing.png',
      }),
    ]
    expect(selectAtlasPages(pages, 'characters')).toHaveLength(2)
    expect(selectAtlasPages(pages, 'characters/body')).toEqual([pages[0]])
    const [body, clothing] = pages
    if (body === undefined || clothing === undefined)
      throw new Error('Test pages should be present')
    expect(() =>
      validateAtlasBuildPages([body, { ...clothing, pageKey: 'characters/body' }]),
    ).toThrow('key is repeated')
  })
})

describe('atlas PNG I/O', () => {
  it('names missing configured source art', async () => {
    await expect(buildAtlasPage(await temporaryRenderer(), spec())).rejects.toThrow(
      'Atlas cell first source is missing: ./assets/source/first.png',
    )
  })

  it('builds from sources, skips an identical decoded page, and names a stale source cell', async () => {
    const renderer = await temporaryRenderer()
    const atlasSpec = spec()
    for (const source of sources())
      await writePng(join(renderer, 'assets', 'source', `${source.name}.png`), source.image)
    expect(await buildAtlasPage(renderer, atlasSpec)).toBe(true)
    const outputPath = join(renderer, 'assets', 'sample-atlas.png')
    const before = await readFile(outputPath)
    expect(await buildAtlasPage(renderer, atlasSpec)).toBe(false)
    expect(await readFile(outputPath)).toEqual(before)
    await writePng(
      join(renderer, 'assets', 'source', 'second.png'),
      image(2, 2, new Array(16).fill(42)),
    )
    await expect(checkAtlasPage(renderer, atlasSpec)).rejects.toThrow('cell second')
    expect(await readPng(outputPath)).toMatchObject({ width: 4, height: 2 })
  })
})

describe('atlas CLI', () => {
  it('rejects environment path traversal before loading a renderer manifest', () => {
    expect(() => environmentModuleUrl('../three_branches')).toThrow('one directory name')
    expect(() => environmentModuleUrl('three_branches/renderer')).toThrow('one directory name')
  })
})
