import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

import { PNG } from 'pngjs'

import {
  type AtlasBuildPageSpec,
  atlasPageKey,
  compareAtlasPixels,
  compileAtlas,
  type RgbaImage,
  validateAtlasBuildPageSpec,
  validateAtlasBuildPages,
} from './atlas.js'

/** Compile source art and write the runtime atlas only when decoded RGBA pixels changed. */
export async function buildAtlasPage(
  rendererDirectory: string,
  spec: AtlasBuildPageSpec,
): Promise<boolean> {
  const compiled = await compileAtlasPage(rendererDirectory, spec)
  const pagePath = resolveRendererPath(rendererDirectory, spec.pagePath)
  if (await pathExists(pagePath)) {
    const committed = await readPng(pagePath)
    if (compareAtlasPixels(spec, compiled, committed) === null) return false
  }
  await writePng(pagePath, compiled)
  return true
}

/** Compile a page in memory and require its committed PNG to have identical decoded pixels. */
export async function checkAtlasPage(
  rendererDirectory: string,
  spec: AtlasBuildPageSpec,
): Promise<void> {
  const compiled = await compileAtlasPage(rendererDirectory, spec)
  const pagePath = resolveRendererPath(rendererDirectory, spec.pagePath)
  if (!(await pathExists(pagePath))) throw new Error(`Atlas page is missing: ${spec.pagePath}`)
  const differentCell = compareAtlasPixels(spec, compiled, await readPng(pagePath))
  if (differentCell !== null)
    throw new Error(`Atlas page is stale at cell ${differentCell}: ${spec.pagePath}`)
}

/** Verify every page declared by an environment renderer module is current. */
export async function expectAtlasesFresh(
  rendererDirectory: string,
  pages: readonly AtlasBuildPageSpec[],
): Promise<void> {
  validateAtlasBuildPages(pages)
  for (const page of pages) await checkAtlasPage(rendererDirectory, page)
}

/** Decode and compile every configured source for a page. */
export async function compileAtlasPage(
  rendererDirectory: string,
  spec: AtlasBuildPageSpec,
): Promise<RgbaImage> {
  validateAtlasBuildPageSpec(spec)
  const sources = await Promise.all(
    spec.cells.map(async (cell) => ({
      name: cell.name,
      image: await readCellSource(rendererDirectory, cell.name, cell.source.path),
    })),
  )
  return compileAtlas(spec, sources)
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

/** Resolve a declared renderer-contained path, rejecting traversal after normalization. */
export function resolveRendererPath(rendererDirectory: string, rendererPath: string): string {
  const resolved = resolve(rendererDirectory, rendererPath)
  const relativePath = relative(rendererDirectory, resolved)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`))
    throw new Error(`Atlas path escapes its renderer directory: ${rendererPath}`)
  return resolved
}

/** Select all pages in a group or one uniquely keyed page. */
export function selectAtlasPages(
  pages: readonly AtlasBuildPageSpec[],
  selector: string | undefined,
): readonly AtlasBuildPageSpec[] {
  validateAtlasBuildPages(pages)
  if (selector === undefined) return pages
  return pages.filter((page) => page.group === selector || atlasPageKey(page) === selector)
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

async function readCellSource(
  rendererDirectory: string,
  name: string,
  rendererPath: string,
): Promise<RgbaImage> {
  try {
    return await readPng(resolveRendererPath(rendererDirectory, rendererPath))
  } catch (error: unknown) {
    if (isMissingPath(error))
      throw new Error(`Atlas cell ${name} source is missing: ${rendererPath}`)
    throw error
  }
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
