import {
  type AtlasBuildPageSpec,
  type AtlasCell,
  type AtlasFormat,
  validateAtlasBuildPages,
} from '@renderers/base/atlas/atlas.js'

import presentationDocument from './assets/presentation.json'
import type { FrameGrid } from './ui/tint.js'

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

type ThumbnailFormat = 'full-color'

export interface ThreeBranchesRasterDraft {
  path: string
  width: number
  height: number
  frames: FrameGrid
  cells: readonly AtlasCell[]
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

export interface ThreeBranchesThumbnailAsset {
  source: string
  path: string
  width: number
  height: number
  format: ThumbnailFormat
}

/** Parse a complete JSON-owned source-art catalog without accepting unknown fields. */
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
  const paths = catalog.flatMap((atlas) =>
    'layers' in atlas ? atlas.layers.map((layer) => layer.path) : [atlas.path],
  )
  if (new Set(paths).size !== paths.length) throw new Error(`${name} must not reuse runtime paths.`)
  validateAtlasBuildPages(atlasBuildPages(catalog))
  return catalog
}

export function readThreeBranchesThumbnailAsset(
  value: unknown,
  name = 'presentation.thumbnail',
): ThreeBranchesThumbnailAsset {
  const source = record(value, name)
  exact(source, name, ['source', 'path', 'width', 'height', 'format'])
  const thumbnail = {
    source: sourcePngPath(source.source, `${name}.source`),
    path: thumbnailPngPath(source.path, `${name}.path`),
    width: positiveInteger(source.width, `${name}.width`),
    height: positiveInteger(source.height, `${name}.height`),
    format: thumbnailFormat(source.format, `${name}.format`),
  }
  return thumbnail
}

function singleAtlas(source: Record<string, unknown>, name: string): ThreeBranchesSingleAtlasDraft {
  exact(source, name, [
    'name',
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
    exact(layer, layerName, ['name', 'path', 'width', 'height', 'frames'])
    return { name: pathSegment(layer.name, `${layerName}.name`), ...raster(layer, layerName) }
  })
  if (layers.length === 0) throw new Error(`${name}.layers must contain at least one layer.`)
  if (new Set(layers.map((layer) => layer.name)).size !== layers.length) {
    throw new Error(`${name}.layers must not contain duplicate layer names.`)
  }
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
    path: runtimePngPath(source.path, `${name}.path`),
    width,
    height,
    frames,
    cells: parseCells(record(source.frames, `${name}.frames`).cells, `${name}.frames.cells`),
  }
}

function grid(value: unknown, name: string): FrameGrid {
  const source = record(value, name)
  exact(source, name, ['width', 'height', 'columns', 'rows', 'cells'])
  const cells = parseCells(source.cells, `${name}.cells`)
  const result = {
    width: positiveInteger(source.width, `${name}.width`),
    height: positiveInteger(source.height, `${name}.height`),
    columns: positiveInteger(source.columns, `${name}.columns`),
    rows: positiveInteger(source.rows, `${name}.rows`),
    names: cells.map((cell) => cell.name),
  }
  if (result.names.length === 0 || result.names.length > result.columns * result.rows) {
    throw new Error(`${name}.cells must fit its frame grid.`)
  }
  if (new Set(result.names).size !== result.names.length) {
    throw new Error(`${name}.cells must not contain duplicate names.`)
  }
  return result
}

function parseCells(value: unknown, name: string): readonly AtlasCell[] {
  return list(value, name).map((value, index) => {
    const cellName = `${name}[${index}]`
    const cell = record(value, cellName)
    exact(cell, cellName, ['name', 'source', 'render'])
    const source = record(cell.source, `${cellName}.source`)
    exact(source, `${cellName}.source`, ['path', 'crop'])
    const parsed: AtlasCell = {
      name: filenameStem(cell.name, `${cellName}.name`),
      source: { path: sourcePngPath(source.path, `${cellName}.source.path`) },
    }
    if (source.crop !== undefined) parsed.source.crop = crop(source.crop, `${cellName}.source.crop`)
    if (cell.render !== undefined) {
      const render = record(cell.render, `${cellName}.render`)
      validateRenderShape(render, `${cellName}.render`)
      parsed.render = render as AtlasCell['render']
    }
    return parsed
  })
}

function validateRenderShape(value: Record<string, unknown>, name: string): void {
  if (value.kind === 'copy') exact(value, name, ['kind'])
  else if (value.kind === 'resize') exact(value, name, ['kind', 'resampler', 'outputAlpha'])
  else if (value.kind === 'fitVisible') {
    exact(value, name, [
      'kind',
      'sourceAlpha',
      'bounds',
      'maxSize',
      'anchor',
      'resampler',
      'outputAlpha',
    ])
    record(value.sourceAlpha, `${name}.sourceAlpha`)
    record(value.bounds, `${name}.bounds`)
    record(value.maxSize, `${name}.maxSize`)
    record(value.anchor, `${name}.anchor`)
    if (value.outputAlpha !== undefined) record(value.outputAlpha, `${name}.outputAlpha`)
  } else throw new Error(`${name}.kind must be copy, resize, or fitVisible.`)
}

function crop(
  value: unknown,
  name: string,
): { x: number; y: number; width: number; height: number } {
  const source = record(value, name)
  exact(source, name, ['x', 'y', 'width', 'height'])
  return {
    x: nonNegativeInteger(source.x, `${name}.x`),
    y: nonNegativeInteger(source.y, `${name}.y`),
    width: positiveInteger(source.width, `${name}.width`),
    height: positiveInteger(source.height, `${name}.height`),
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`)
  }
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, name: string, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (Object.keys(value).some((key) => !allowed.has(key))) {
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
  const result = text(value, name)
  const prefix = './assets/source-art/'
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

function thumbnailPngPath(value: unknown, name: string): string {
  const result = text(value, name)
  if (!/^\.\/assets\/[A-Za-z0-9][A-Za-z0-9_-]*\.png$/.test(result)) {
    throw new Error(`${name} must be a direct ./assets/<safe>.png path.`)
  }
  return result
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return value
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative integer.`)
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

function thumbnailFormat(value: unknown, name: string): ThumbnailFormat {
  if (value !== 'full-color') throw new Error(`${name} must be full-color.`)
  return value
}

/** The complete JSON-owned catalog used by runtime loading and presentation validation. */
export const THREE_BRANCHES_ASSET_CATALOG = readThreeBranchesAssetCatalog(
  presentationDocument.atlases,
)

/** The separate illustrative image used by the environment card. */
export const THREE_BRANCHES_THUMBNAIL_ASSET = readThreeBranchesThumbnailAsset(
  presentationDocument.thumbnail,
)

/** Resolve frame names from one JSON-owned atlas page. */
export function atlasFrameNames(group: string, layer?: string): readonly string[] {
  const atlas = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === group)
  if (atlas === undefined) throw new Error(`Three Branches manifest has no ${group} atlas.`)
  if (!('layers' in atlas)) {
    if (layer !== undefined)
      throw new Error(`Three Branches manifest atlas ${group} has no layers.`)
    return atlas.frames.names
  }
  if (layer === undefined)
    throw new Error(`Three Branches manifest atlas ${group} requires a layer.`)
  const page = atlas.layers.find((item) => item.name === layer)
  if (page === undefined) throw new Error(`Three Branches manifest has no ${group}.${layer} layer.`)
  return page.frames.names
}

function atlasBuildPages(
  catalog: readonly ThreeBranchesAtlasDraft[],
): readonly AtlasBuildPageSpec[] {
  return catalog.flatMap((atlas) =>
    'layers' in atlas
      ? atlas.layers.map((layer) =>
          buildPage(atlas.name, `${atlas.name}/${layer.name}`, atlas.format, layer),
        )
      : [buildPage(atlas.name, atlas.name, atlas.format, atlas)],
  )
}

function buildPage(
  group: string,
  pageKey: string,
  format: AtlasFormat,
  raster: ThreeBranchesRasterDraft,
): AtlasBuildPageSpec {
  return {
    group,
    pageKey,
    pagePath: raster.path,
    format,
    width: raster.width,
    height: raster.height,
    columns: raster.frames.columns,
    rows: raster.frames.rows,
    cells: raster.cells,
  }
}

/** The source-art manifests for the configured Three Branches atlas pages. */
export const ATLAS_PAGES = atlasBuildPages(THREE_BRANCHES_ASSET_CATALOG)

export interface ThreeBranchesRuntimeAssets<T> {
  terrain: T
  props: T
  lantern: T
  monuments: T
  buildings: { home: T; inn: T; shed: T }
  scenery: T
  characters: T
  effects: T
}

export interface ThreeBranchesRuntimeAssetLoadOptions {
  autoGenerateMipmaps: true
}

interface RuntimeAtlasPage {
  key: string
  path: string
  mipmaps: boolean
}

/** Resolve and load the atlas pages consumed by shipped world and character art. */
export async function loadThreeBranchesRuntimeAssets<T>(
  load: (source: string, options?: ThreeBranchesRuntimeAssetLoadOptions) => Promise<T> | T,
): Promise<ThreeBranchesRuntimeAssets<T>> {
  const urls = threeBranchesRuntimeAssetUrls()
  const loadPath = (path: string, options?: ThreeBranchesRuntimeAssetLoadOptions): Promise<T> => {
    const source = urls[path]
    if (source === undefined) throw new Error(`Three Branches atlas is missing: ${path}`)
    return Promise.resolve(load(source, options))
  }
  const loaded = new Map<string, T>()
  await Promise.all(
    runtimeAtlasPages().map(async (page) => {
      loaded.set(
        page.key,
        await loadPath(page.path, page.mipmaps ? { autoGenerateMipmaps: true } : undefined),
      )
    }),
  )
  const required = (group: string, layer?: string): T => {
    const key = layer === undefined ? group : `${group}/${layer}`
    const texture = loaded.get(key)
    if (texture === undefined) throw new Error(`Three Branches runtime atlas is missing: ${key}`)
    return texture
  }
  return {
    terrain: required('terrain'),
    props: required('props'),
    lantern: required('lantern'),
    monuments: required('monuments'),
    buildings: {
      home: required('buildings', 'home'),
      inn: required('buildings', 'inn'),
      shed: required('buildings', 'shed'),
    },
    scenery: required('scenery'),
    characters: required('characters'),
    effects: required('effects'),
  }
}

function threeBranchesRuntimeAssetUrls(): Record<string, string> {
  const urls = import.meta.glob('./assets/*-atlas.png', {
    eager: true,
    import: 'default',
    query: '?url',
  }) as Record<string, string>
  for (const page of runtimeAtlasPages()) {
    if (urls[page.path] === undefined)
      throw new Error(`Three Branches runtime atlas is not bundled: ${page.path}`)
  }
  return urls
}

function runtimeAtlasPages(): readonly RuntimeAtlasPage[] {
  return THREE_BRANCHES_ASSET_CATALOG.flatMap((atlas) =>
    'layers' in atlas
      ? atlas.layers.map((layer) => ({
          key: `${atlas.name}/${layer.name}`,
          path: layer.path,
          mipmaps: atlas.mipmaps,
        }))
      : [{ key: atlas.name, path: atlas.path, mipmaps: atlas.mipmaps }],
  )
}
