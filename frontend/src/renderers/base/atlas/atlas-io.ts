import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

import { PNG } from 'pngjs'

import {
  type AtlasFrame,
  type AtlasPageSpec,
  compareAtlasPixels,
  composeAtlas,
  frameName,
  frameSetProblem,
  type RgbaImage,
  splitAtlas,
  validateAtlasPageSpec,
} from './atlas.js'

/** Decode every declared loose frame and write it back only when its page differs by pixels. */
export async function packAtlasPage(
  rendererDirectory: string,
  spec: AtlasPageSpec,
): Promise<boolean> {
  const frames = await readAtlasFrames(rendererDirectory, spec)
  const packed = composeAtlas(spec, frames)
  const pagePath = resolveRendererPath(rendererDirectory, spec.pagePath)
  if (await pathExists(pagePath)) {
    const committed = await readPng(pagePath)
    if (compareAtlasPixels(spec, packed, committed) === null) return false
  }
  await writePng(pagePath, packed)
  return true
}

/** Split a committed page into its declared loose PNGs after rejecting stray files. */
export async function splitAtlasPage(
  rendererDirectory: string,
  spec: AtlasPageSpec,
): Promise<void> {
  validateAtlasPageSpec(spec)
  const stray = await strayFramePaths(rendererDirectory, spec)
  if (stray.length > 0) throw new Error(frameSetProblem([], stray))

  const page = await readPng(resolveRendererPath(rendererDirectory, spec.pagePath))
  for (const frame of splitAtlas(spec, page)) {
    await writePng(resolveFramePath(rendererDirectory, spec, frame.path), frame.image)
  }
}

/** Pack a page in memory and require its committed PNG to have identical decoded pixels. */
export async function checkAtlasPage(
  rendererDirectory: string,
  spec: AtlasPageSpec,
): Promise<void> {
  const packed = composeAtlas(spec, await readAtlasFrames(rendererDirectory, spec))
  const committed = await readPng(resolveRendererPath(rendererDirectory, spec.pagePath))
  const differentFrame = compareAtlasPixels(spec, packed, committed)
  if (differentFrame !== null) {
    throw new Error(`Atlas page is stale at frame ${differentFrame}: ${spec.pagePath}`)
  }
}

/** Verify every page declared by an environment renderer module is current. */
export async function expectAtlasesFresh(
  rendererDirectory: string,
  pages: readonly AtlasPageSpec[],
): Promise<void> {
  for (const page of pages) await checkAtlasPage(rendererDirectory, page)
}

/** Decode a PNG as an RGBA image. */
export async function readPng(path: string): Promise<RgbaImage> {
  const png = PNG.sync.read(await readFile(path))
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) }
}

/** Encode an RGBA image as one PNG, creating parent directories as needed. */
export async function writePng(path: string, image: RgbaImage): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const png = new PNG({ width: image.width, height: image.height })
  png.data = Buffer.from(image.data)
  await writeFile(path, PNG.sync.write(png))
}

/** Read and validate all loose frames, collecting membership and dimension failures together. */
export async function readAtlasFrames(
  rendererDirectory: string,
  spec: AtlasPageSpec,
): Promise<AtlasFrame[]> {
  validateAtlasPageSpec(spec)
  const actualPaths = await listPngPaths(resolveRendererPath(rendererDirectory, spec.framesPath))
  const expectedPaths = new Set(spec.framePaths)
  const actualSet = new Set(actualPaths)
  const missing = spec.framePaths.filter((path) => !actualSet.has(path))
  const stray = actualPaths.filter((path) => !expectedPaths.has(path))
  const frameWidth = spec.width / spec.columns
  const frameHeight = spec.height / spec.rows
  const frames: AtlasFrame[] = []
  const misSized: string[] = []

  for (const path of spec.framePaths) {
    if (!actualSet.has(path)) continue
    const image = await readPng(resolveFramePath(rendererDirectory, spec, path))
    if (image.width !== frameWidth || image.height !== frameHeight) {
      misSized.push(
        `${path} (${image.width}x${image.height}, expected ${frameWidth}x${frameHeight})`,
      )
      continue
    }
    frames.push({ path, name: frameName(path), image })
  }
  if (missing.length > 0 || stray.length > 0 || misSized.length > 0) {
    const categories = [
      ...(missing.length > 0 ? [`missing: ${missing.join(', ')}`] : []),
      ...(stray.length > 0 ? [`stray: ${stray.join(', ')}`] : []),
      ...(misSized.length > 0 ? [`mis-sized: ${misSized.join(', ')}`] : []),
    ]
    throw new Error(`Atlas frames do not match the declared set (${categories.join('; ')})`)
  }
  return frames
}

async function strayFramePaths(rendererDirectory: string, spec: AtlasPageSpec): Promise<string[]> {
  const actualPaths = await listPngPaths(resolveRendererPath(rendererDirectory, spec.framesPath))
  const expectedPaths = new Set(spec.framePaths)
  return actualPaths.filter((path) => !expectedPaths.has(path))
}

async function listPngPaths(directory: string): Promise<string[]> {
  if (!(await pathExists(directory))) return []
  const paths: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      for (const child of await listPngPaths(path)) paths.push(`${entry.name}/${child}`)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
      paths.push(entry.name)
    }
  }
  return paths.sort()
}

function resolveRendererPath(rendererDirectory: string, rendererPath: string): string {
  const resolved = resolve(rendererDirectory, rendererPath)
  const relativePath = relative(rendererDirectory, resolved)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`Atlas path escapes its renderer directory: ${rendererPath}`)
  }
  return resolved
}

function resolveFramePath(
  rendererDirectory: string,
  spec: AtlasPageSpec,
  framePath: string,
): string {
  return resolveRendererPath(rendererDirectory, `${spec.framesPath}/${framePath}`)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error: unknown) {
    if (isMissingPath(error)) return false
    throw error
  }
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
