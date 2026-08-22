import type { AtlasPageSpec } from '@renderers/base/atlas/atlas.js'

import catalogDocument from '../catalog.json'

import presentationDocument from './assets/presentation.json'
import type { FrameGrid } from './ui/tint.js'

type AtlasFormat = 'grayscale-alpha' | 'full-color'
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** One generated source atlas and its optimized runtime counterpart. */
export interface ThreeBranchesRasterDraft {
  source: string
  sourceWidth: number
  sourceHeight: number
  path: string
  width: number
  height: number
  frames: FrameGrid
}

export interface ThreeBranchesSingleAtlasDraft extends ThreeBranchesRasterDraft {
  name: string
  tintable: boolean
  format: AtlasFormat
  consumer: string
  mipmaps: boolean
}

export interface ThreeBranchesLayerDraft extends ThreeBranchesRasterDraft {
  name: string
}

export interface ThreeBranchesLayeredAtlasDraft {
  name: string
  tintable: boolean
  format: AtlasFormat
  consumer: string
  mipmaps: boolean
  layers: readonly ThreeBranchesLayerDraft[]
}

export type ThreeBranchesAtlasDraft = ThreeBranchesSingleAtlasDraft | ThreeBranchesLayeredAtlasDraft

/** Parse a complete JSON-owned catalog without accepting unknown fields or page shapes. */
export function readThreeBranchesAssetCatalog(
  value: unknown,
  name = 'presentation.atlases',
): readonly ThreeBranchesAtlasDraft[] {
  const entries = list(value, name)
  if (entries.length === 0) throw new Error(`${name} must contain at least one atlas group.`)
  const catalog = entries.map((entry, index) => {
    const entryName = `${name}[${index}]`
    const source = record(entry, entryName)
    return 'layers' in source ? layeredAtlas(source, entryName) : singleAtlas(source, entryName)
  })
  if (new Set(catalog.map((atlas) => atlas.name)).size !== catalog.length) {
    throw new Error(`${name} must not contain duplicate atlas groups.`)
  }
  const paths: string[] = []
  for (const atlas of catalog) {
    if ('layers' in atlas) paths.push(...atlas.layers.map((layer) => layer.path))
    else paths.push(atlas.path)
  }
  if (new Set(paths).size !== paths.length) throw new Error(`${name} must not reuse runtime paths.`)
  return catalog
}

function singleAtlas(source: Record<string, unknown>, name: string): ThreeBranchesSingleAtlasDraft {
  exact(source, name, [
    'name',
    'source',
    'sourceWidth',
    'sourceHeight',
    'path',
    'width',
    'height',
    'tintable',
    'format',
    'consumer',
    'mipmaps',
    'frames',
  ])
  const atlas = {
    name: pathSegment(source.name, `${name}.name`),
    ...raster(source, name),
    tintable: bool(source.tintable, `${name}.tintable`),
    format: format(source.format, `${name}.format`),
    consumer: text(source.consumer, `${name}.consumer`),
    mipmaps: bool(source.mipmaps, `${name}.mipmaps`),
  }
  if (atlas.tintable !== (atlas.format === 'grayscale-alpha')) {
    throw new Error(`${name}.tintable must match its format.`)
  }
  return atlas
}

function layeredAtlas(
  source: Record<string, unknown>,
  name: string,
): ThreeBranchesLayeredAtlasDraft {
  exact(source, name, ['name', 'tintable', 'format', 'consumer', 'mipmaps', 'layers'])
  const layers = list(source.layers, `${name}.layers`).map((value, index) => {
    const layerName = `${name}.layers[${index}]`
    const layer = record(value, layerName)
    exact(layer, layerName, [
      'name',
      'source',
      'sourceWidth',
      'sourceHeight',
      'path',
      'width',
      'height',
      'frames',
    ])
    return { name: pathSegment(layer.name, `${layerName}.name`), ...raster(layer, layerName) }
  })
  if (layers.length === 0) throw new Error(`${name}.layers must contain at least one layer.`)
  if (new Set(layers.map((layer) => layer.name)).size !== layers.length)
    throw new Error(`${name}.layers must not contain duplicate layer names.`)
  const atlas = {
    name: pathSegment(source.name, `${name}.name`),
    tintable: bool(source.tintable, `${name}.tintable`),
    format: format(source.format, `${name}.format`),
    consumer: text(source.consumer, `${name}.consumer`),
    mipmaps: bool(source.mipmaps, `${name}.mipmaps`),
    layers,
  }
  if (atlas.tintable !== (atlas.format === 'grayscale-alpha')) {
    throw new Error(`${name}.tintable must match its format.`)
  }
  return atlas
}

function raster(source: Record<string, unknown>, name: string): ThreeBranchesRasterDraft {
  const frames = grid(source.frames, `${name}.frames`)
  const width = positiveInteger(source.width, `${name}.width`)
  const height = positiveInteger(source.height, `${name}.height`)
  if (width !== frames.width * frames.columns || height !== frames.height * frames.rows) {
    throw new Error(`${name} dimensions must match its frame grid.`)
  }
  return {
    source: sourcePngPath(source.source, `${name}.source`),
    sourceWidth: positiveInteger(source.sourceWidth, `${name}.sourceWidth`),
    sourceHeight: positiveInteger(source.sourceHeight, `${name}.sourceHeight`),
    path: runtimePngPath(source.path, `${name}.path`),
    width,
    height,
    frames,
  }
}

function grid(value: unknown, name: string): FrameGrid {
  const source = record(value, name)
  exact(source, name, ['width', 'height', 'columns', 'rows', 'names'])
  const result = {
    width: positiveInteger(source.width, `${name}.width`),
    height: positiveInteger(source.height, `${name}.height`),
    columns: positiveInteger(source.columns, `${name}.columns`),
    rows: positiveInteger(source.rows, `${name}.rows`),
    names: list(source.names, `${name}.names`).map((frame, index) =>
      filenameStem(frame, `${name}.names[${index}]`),
    ),
  }
  if (result.names.length === 0 || result.names.length > result.columns * result.rows) {
    throw new Error(`${name}.names must fit its frame grid.`)
  }
  if (new Set(result.names).size !== result.names.length) {
    throw new Error(`${name}.names must not contain duplicates.`)
  }
  return result
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`)
  }
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, name: string, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (keys.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${name} keys do not match its contract.`)
  }
}

function list(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`)
  return value
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be text.`)
  return value
}

function pathSegment(value: unknown, name: string): string {
  const result = text(value, name)
  if (!SAFE_PATH_SEGMENT.test(result)) throw new Error(`${name} must be a safe path segment.`)
  return result
}

function filenameStem(value: unknown, name: string): string {
  const result = text(value, name)
  if (!SAFE_PATH_SEGMENT.test(result)) throw new Error(`${name} must be a safe filename stem.`)
  return result
}

function sourcePngPath(value: unknown, name: string): string {
  return rendererPngPath(value, name, './assets/source-art/')
}

function rendererPngPath(value: unknown, name: string, prefix: string): string {
  const result = text(value, name)
  const segments = result.slice(prefix.length).split('/')
  if (
    !result.startsWith(prefix) ||
    !result.endsWith('.png') ||
    result.includes('\\') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`${name} must be a renderer-relative POSIX PNG path under ${prefix}.`)
  }
  return result
}

function runtimePngPath(value: unknown, name: string): string {
  const result = text(value, name)
  if (!/^\.\/assets\/[A-Za-z0-9][A-Za-z0-9_-]*-atlas\.png$/.test(result)) {
    throw new Error(`${name} must be a direct ./assets/<safe>-atlas.png path.`)
  }
  return result
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return value
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be boolean.`)
  return value
}

function format(value: unknown, name: string): AtlasFormat {
  if (value !== 'grayscale-alpha' && value !== 'full-color') {
    throw new Error(`${name} must be grayscale-alpha or full-color.`)
  }
  return value
}

/** The complete JSON-owned catalog used by runtime loading and presentation validation. */
export const THREE_BRANCHES_ASSET_CATALOG = readThreeBranchesAssetCatalog(
  presentationDocument.atlases,
)

function singleFrameNames(name: string): readonly string[] {
  const atlas = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === name)
  if (atlas === undefined || 'layers' in atlas)
    throw new Error(`Three Branches manifest has no ${name} atlas.`)
  return atlas.frames.names
}

export const TERRAIN_ATLAS_FRAME_NAMES = singleFrameNames('terrain')
export const BUILDINGS_ATLAS_FRAME_NAMES = singleFrameNames('buildings')
export const PROPS_ATLAS_FRAME_NAMES = singleFrameNames('props')
export const LANTERN_ATLAS_FRAME_NAMES = singleFrameNames('lantern')
export const MONUMENTS_ATLAS_FRAME_NAMES = singleFrameNames('monuments')
export const BELL_ATLAS_FRAME_NAMES = singleFrameNames('bell')
export const SCENERY_ATLAS_FRAME_NAMES = singleFrameNames('scenery')
export const EFFECTS_ATLAS_FRAME_NAMES = singleFrameNames('effects')

function characterFrameNames(name: string): readonly string[] {
  const atlas = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === 'characters')
  const layer =
    atlas !== undefined && 'layers' in atlas
      ? atlas.layers.find((item) => item.name === name)
      : undefined
  if (layer === undefined)
    throw new Error(`Three Branches manifest has no characters.${name} layer.`)
  return layer.frames.names
}

export const CHARACTER_POSE_FRAME_NAMES = characterFrameNames('body')
export const CHARACTER_DETAIL_FRAME_NAMES = characterFrameNames('details')

function flatFramePaths(names: readonly string[]): readonly string[] {
  return names.map((name) => `${name}.png`)
}

function catalogPropFramePath(name: string): string {
  const stall = name.match(/^stall([ABC])(Open|Closed)$/)
  if (stall !== null) {
    const state = stall[2]?.toLowerCase()
    return stall[1] === 'A' ? `stall/${state}.png` : `stall/${stall[1]?.toLowerCase()}/${state}.png`
  }
  for (const prop of catalogDocument.props) {
    const type = prop.token.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
    const state = prop.states.find(
      (value) => `${type}${value[0]?.toUpperCase()}${value.slice(1)}` === name,
    )
    if (state !== undefined) return `${prop.token}/${state}.png`
  }
  throw new Error(`Three Branches prop frame has no catalog state: ${name}`)
}

function monumentFramePath(name: string): string {
  return name === 'pumpFlowing' ? 'pump/flowing.png' : 'pump/idle.png'
}

function bellFramePath(name: string): string {
  if (name === 'bellFoundation') return 'foundation.png'
  if (name === 'bellGantry') return 'gantry.png'
  return 'moving.png'
}

function atlasPage(
  group: string,
  format: ThreeBranchesSingleAtlasDraft['format'],
  raster: ThreeBranchesRasterDraft,
  framesPath: string,
  framePaths: readonly string[],
): AtlasPageSpec {
  return {
    group,
    pagePath: raster.path,
    framesPath,
    format,
    width: raster.width,
    height: raster.height,
    columns: raster.frames.columns,
    rows: raster.frames.rows,
    framePaths,
  }
}

/** The loose-frame manifests for the twelve compiled Three Branches atlas pages. */
export const ATLAS_PAGES = THREE_BRANCHES_ASSET_CATALOG.flatMap((atlas) => {
  if ('layers' in atlas) {
    return atlas.layers.map((layer) =>
      atlasPage(
        atlas.name,
        atlas.format,
        layer,
        `./assets/${atlas.name}/${layer.name}`,
        flatFramePaths(layer.frames.names),
      ),
    )
  }

  const framePaths =
    atlas.name === 'props'
      ? atlas.frames.names.map(catalogPropFramePath)
      : atlas.name === 'monuments'
        ? atlas.frames.names.map(monumentFramePath)
        : atlas.name === 'bell'
          ? atlas.frames.names.map(bellFramePath)
          : atlas.name === 'lantern'
            ? ['lit.png', 'unlit.png']
            : flatFramePaths(atlas.frames.names)
  return [atlasPage(atlas.name, atlas.format, atlas, `./assets/${atlas.name}`, framePaths)]
}) satisfies readonly AtlasPageSpec[]

/** The separate illustrative image used by the environment card. */
export const THREE_BRANCHES_THUMBNAIL_ASSET = {
  source: './assets/source-art/thumbnail-source.png',
  sourceWidth: 1672,
  sourceHeight: 941,
  path: './assets/thumbnail.png',
  width: 320,
  height: 180,
  format: 'full-color',
} as const

/** Runtime pages consumed after the terrain and character art units have landed. */
export interface ThreeBranchesRuntimeAssets<T> {
  terrain: T
  props: T
  lantern: T
  monuments: T
  bell: T
  buildings: T
  scenery: T
  characters: {
    body: T
    clothing: T
    arms: T
    details: T
  }
  effects: T
}

/** Texture-source options needed by a specific runtime atlas. */
export interface ThreeBranchesRuntimeAssetLoadOptions {
  autoGenerateMipmaps: true
}

/** Resolve and load the atlas pages consumed by shipped terrain, prop, and character art. */
export async function loadThreeBranchesRuntimeAssets<T>(
  load: (source: string, options?: ThreeBranchesRuntimeAssetLoadOptions) => Promise<T> | T,
): Promise<ThreeBranchesRuntimeAssets<T>> {
  const urls = threeBranchesRuntimeAssetUrls()
  const loadPath = (path: string, options?: ThreeBranchesRuntimeAssetLoadOptions): Promise<T> => {
    const source = urls[path]
    if (source === undefined) throw new Error(`Three Branches atlas is missing: ${path}`)
    return Promise.resolve(load(source, options))
  }
  const loadAtlas = (name: string, layer?: string): Promise<T> => {
    const atlas = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === name)
    if (atlas === undefined) throw new Error(`Three Branches manifest has no ${name} atlas.`)
    const raster =
      layer === undefined
        ? 'layers' in atlas
          ? undefined
          : atlas
        : 'layers' in atlas
          ? atlas.layers.find((item) => item.name === layer)
          : undefined
    if (raster === undefined)
      throw new Error(`Three Branches manifest has no ${name} runtime page.`)
    return loadPath(raster.path, atlas.mipmaps ? { autoGenerateMipmaps: true } : undefined)
  }
  const [
    terrain,
    props,
    lantern,
    monuments,
    bell,
    buildings,
    scenery,
    body,
    clothing,
    arms,
    details,
    effects,
  ] = await Promise.all([
    loadAtlas('terrain'),
    loadAtlas('props'),
    loadAtlas('lantern'),
    loadAtlas('monuments'),
    loadAtlas('bell'),
    loadAtlas('buildings'),
    loadAtlas('scenery'),
    loadAtlas('characters', 'body'),
    loadAtlas('characters', 'clothing'),
    loadAtlas('characters', 'arms'),
    loadAtlas('characters', 'details'),
    loadAtlas('effects'),
  ])
  return {
    terrain,
    props,
    lantern,
    monuments,
    bell,
    buildings,
    scenery,
    characters: { body, clothing, arms, details },
    effects,
  }
}

/** Ask Vite for production URLs for every shipped runtime atlas page. */
function threeBranchesRuntimeAssetUrls(): Record<string, string> {
  const urls = import.meta.glob('./assets/*-atlas.png', {
    eager: true,
    import: 'default',
    query: '?url',
  }) as Record<string, string>
  for (const path of runtimeAtlasPaths()) {
    if (urls[path] === undefined) {
      throw new Error(`Three Branches runtime atlas is not bundled: ${path}`)
    }
  }
  return urls
}

/** Expand every catalog group to the runtime page paths Vite must bundle. */
function runtimeAtlasPaths(): readonly string[] {
  return THREE_BRANCHES_ASSET_CATALOG.flatMap((atlas) =>
    'layers' in atlas ? atlas.layers.map((layer) => layer.path) : [atlas.path],
  )
}
