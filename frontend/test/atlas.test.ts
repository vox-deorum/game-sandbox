import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  type AtlasPageSpec,
  compareAtlasPixels,
  composeAtlas,
  frameName,
  type RgbaImage,
  splitAtlas,
  validateAtlasFrames,
  validateAtlasPageSpec,
} from '../src/renderers/base/atlas/atlas.js'
import {
  checkAtlasPage,
  packAtlasPage,
  readPng,
  splitAtlasPage,
  writePng,
} from '../src/renderers/base/atlas/atlas-io.js'
import { environmentModuleUrl } from '../src/renderers/base/atlas/cli.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

function spec(overrides: Partial<AtlasPageSpec> = {}): AtlasPageSpec {
  return {
    group: 'terrain',
    pagePath: './assets/sample-atlas.png',
    framesPath: './assets/sample',
    format: 'full-color',
    width: 4,
    height: 2,
    columns: 2,
    rows: 1,
    framePaths: ['first.png', 'nested/second_frame.png'],
    ...overrides,
  }
}

function image(width: number, height: number, pixels: readonly number[]): RgbaImage {
  return { width, height, data: new Uint8Array(pixels) }
}

function page(): RgbaImage {
  return image(
    4,
    2,
    [
      1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255, 13, 14, 15, 255, 16, 17, 18, 255,
      19, 20, 21, 255, 22, 23, 24, 255,
    ],
  )
}

async function temporaryRenderer(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'game-sandbox-atlas-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('atlas names and pure pixel operations', () => {
  it('derives names from flat, nested, and underscored loose PNG paths', () => {
    expect(frameName('washA.png')).toBe('washA')
    expect(frameName('characters/body/rest.png')).toBe('charactersBodyRest')
    expect(frameName('repair_bench/busy_frame.png')).toBe('repairBenchBusyFrame')
  })

  it('round trips pixels through split and pack in declared row-major order', () => {
    const original = page()
    const packed = composeAtlas(spec(), splitAtlas(spec(), original))
    expect(packed).toEqual(original)
    expect(compareAtlasPixels(spec(), original, packed)).toBeNull()
  })

  it('leaves unnamed trailing cells transparent and identifies stale unused cells', () => {
    const partialSpec = spec({
      width: 6,
      columns: 3,
      framePaths: ['first.png', 'nested/second_frame.png'],
    })
    const original = image(
      6,
      2,
      [
        1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255, 13, 14, 15, 255, 16, 17, 18,
        255, 19, 20, 21, 255, 22, 23, 24, 255, 25, 26, 27, 255, 28, 29, 30, 255, 31, 32, 33, 255,
        34, 35, 36, 255,
      ],
    )
    const frames = splitAtlas(partialSpec, original)
    const packed = composeAtlas(partialSpec, frames)

    expect(frames).toHaveLength(2)
    expect(packed.data.subarray(16, 24)).toEqual(new Uint8Array(8))
    expect(packed.data.subarray(40, 48)).toEqual(new Uint8Array(8))
    expect(compareAtlasPixels(partialSpec, packed, original)).toBe('unused cell 2')
  })

  it('rejects missing, stray, and mis-sized frames', () => {
    const frames = splitAtlas(spec(), page())
    const first = frames[0]
    const second = frames[1]
    if (first === undefined || second === undefined)
      throw new Error('Test atlas should have two frames')
    expect(() => validateAtlasFrames(spec(), frames.slice(0, 1))).toThrow(
      'missing: nested/second_frame.png',
    )
    expect(() =>
      validateAtlasFrames(spec(), [...frames, { ...first, path: 'stray.png', name: 'stray' }]),
    ).toThrow('stray: stray.png')
    expect(() =>
      validateAtlasFrames(spec(), [{ ...first, image: image(1, 2, new Array(8).fill(0)) }, second]),
    ).toThrow('expected 2x2')
  })

  it('rejects colored pixels in grayscale-alpha frames and invalid grid contracts', () => {
    const graySpec = spec({ format: 'grayscale-alpha' })
    const frames = splitAtlas(graySpec, page())
    expect(() => validateAtlasFrames(graySpec, frames)).toThrow('not grayscale-alpha')
    expect(() => validateAtlasPageSpec(spec({ width: 5 }))).toThrow('divide evenly')
    expect(() => validateAtlasPageSpec(spec({ framePaths: [] }))).toThrow('at least one frame path')
    expect(() => validateAtlasPageSpec(spec({ columns: 1 }))).toThrow(
      'capacity is 1 frame paths, received 2',
    )
  })

  it('rejects an empty group and an unknown pixel format', () => {
    expect(() => validateAtlasPageSpec(spec({ group: ' ' }))).toThrow('must not be empty')
    expect(() =>
      validateAtlasPageSpec({
        ...spec(),
        format: 'indexed' as AtlasPageSpec['format'],
      }),
    ).toThrow('Unknown atlas format')
  })
})

describe('atlas PNG I/O', () => {
  it('splits a page, leaves a matching page untouched, and names the first stale frame', async () => {
    const rendererDirectory = await temporaryRenderer()
    const atlasSpec = spec()
    const pagePath = join(rendererDirectory, 'assets', 'sample-atlas.png')
    await writePng(pagePath, page())

    await splitAtlasPage(rendererDirectory, atlasSpec)
    const secondFrame = splitAtlas(atlasSpec, page())[1]
    if (secondFrame === undefined) throw new Error('Test atlas should have a second frame')
    expect(
      await readPng(join(rendererDirectory, 'assets', 'sample', 'nested', 'second_frame.png')),
    ).toEqual(secondFrame.image)

    const before = await readFile(pagePath)
    expect(await packAtlasPage(rendererDirectory, atlasSpec)).toBe(false)
    expect(await readFile(pagePath)).toEqual(before)

    await writePng(
      join(rendererDirectory, 'assets', 'sample', 'nested', 'second_frame.png'),
      image(2, 2, new Array(16).fill(42)),
    )
    await expect(checkAtlasPage(rendererDirectory, atlasSpec)).rejects.toThrow('nestedSecondFrame')
  })

  it('reports missing, stray, and mis-sized paths from a real frames directory together', async () => {
    const rendererDirectory = await temporaryRenderer()
    const atlasSpec = spec()
    await writePng(
      join(rendererDirectory, 'assets', 'sample', 'stray.PNG'),
      image(2, 2, new Array(16).fill(0)),
    )
    await writePng(
      join(rendererDirectory, 'assets', 'sample', 'first.png'),
      image(1, 2, new Array(8).fill(0)),
    )

    await expect(packAtlasPage(rendererDirectory, atlasSpec)).rejects.toThrow(
      'missing: nested/second_frame.png; stray: stray.PNG; mis-sized: first.png (1x2, expected 2x2)',
    )
  })
})

describe('atlas CLI', () => {
  it('rejects environment path traversal before loading a renderer manifest', () => {
    expect(() => environmentModuleUrl('../three_branches')).toThrow('one directory name')
    expect(() => environmentModuleUrl('three_branches/renderer')).toThrow('one directory name')
  })
})
