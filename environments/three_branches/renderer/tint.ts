import { Rectangle, Texture } from 'pixi.js'

/** A regular frame grid supplied by the renderer-local atlas manifest. */
export interface FrameGrid {
  width: number
  height: number
  columns: number
  rows: number
  names: readonly string[]
}

/** Return a named atlas frame rectangle without requiring browser drawing APIs. */
export function frameRectangle(grid: FrameGrid, name: string): Rectangle {
  const index = grid.names.indexOf(name)
  if (index < 0) throw new Error(`Unknown atlas frame: ${name}`)
  return new Rectangle(
    (index % grid.columns) * grid.width,
    Math.floor(index / grid.columns) * grid.height,
    grid.width,
    grid.height,
  )
}

/** Slice one Pixi atlas texture using its manifest grid. */
export function sliceAtlasFrame(atlas: Texture, grid: FrameGrid, name: string): Texture {
  return new Texture({ source: atlas.source, frame: frameRectangle(grid, name) })
}

/** Stable cache key for a tint baked from one atlas frame. */
export function tintedMaskCacheKey(frame: string, tint: string, opacity = 1): string {
  const normalized = maskOpacity(opacity)
  const base = `${frame}:${tint.toLowerCase()}`
  return normalized === 1 ? base : `${base}:${normalized}`
}

const tintedMasks = new WeakMap<Texture, Map<string, Texture>>()

/** Bake a grayscale-alpha atlas frame once for a tilemap that cannot tint individual packed tiles. */
export function tintedMaskFrame(
  atlas: Texture,
  grid: FrameGrid,
  name: string,
  tint: string,
  opacity = 1,
): Texture {
  const key = tintedMaskCacheKey(name, tint, opacity)
  let cached = tintedMasks.get(atlas)
  if (cached === undefined) {
    cached = new Map()
    tintedMasks.set(atlas, cached)
  }
  const existing = cached.get(key)
  if (existing !== undefined) return existing

  const frame = frameRectangle(grid, name)
  const canvas = document.createElement('canvas')
  canvas.width = frame.width
  canvas.height = frame.height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('A 2D canvas is required to tint Three Branches artwork.')
  const resource = atlas.source.resource
  if (resource === null) throw new Error(`Atlas texture has no image source for frame ${name}.`)
  context.drawImage(
    resource as CanvasImageSource,
    frame.x,
    frame.y,
    frame.width,
    frame.height,
    0,
    0,
    frame.width,
    frame.height,
  )
  const pixels = context.getImageData(0, 0, frame.width, frame.height)
  tintedMaskPixels(pixels.data, tint, opacity)
  context.putImageData(pixels, 0, 0)
  const baked = Texture.from(canvas)
  cached.set(key, baked)
  return baked
}

/** Tint grayscale-alpha mask pixels and scale their opacity without changing their value shape. */
export function tintedMaskPixels(pixels: Uint8ClampedArray, tint: string, opacity = 1): void {
  const [red, green, blue] = tintChannels(tint)
  const amount = maskOpacity(opacity)
  for (let index = 0; index < pixels.length; index += 4) {
    const grayscale = (pixels[index] ?? 0) / 255
    pixels[index] = Math.round(red * grayscale)
    pixels[index + 1] = Math.round(green * grayscale)
    pixels[index + 2] = Math.round(blue * grayscale)
    pixels[index + 3] = Math.round((pixels[index + 3] ?? 0) * amount)
  }
}

/** Stable cache key for an opaque terrain fill baked from one atlas frame. */
export function opaqueFillCacheKey(frame: string, tint: string): string {
  return `fill:${tintedMaskCacheKey(frame, tint)}`
}

/** Stable cache key for one terrain fill feathered by a cardinal cutout mask. */
export function cutoutFillCacheKey(frame: string, mask: string, tint: string): string {
  return `cutout:${frame}:${mask}:${tint.toLowerCase()}`
}

/** Maximum same-hue value shift retained from a terrain fill mask. */
export const TERRAIN_FILL_DETAIL_STRENGTH = 0.14

const opaqueFills = new WeakMap<Texture, Map<string, Texture>>()

/**
 * Bake an opaque terrain base from a grayscale-alpha mask. Transparent mask pixels become the
 * configured tint, while visible mask pixels shift that tint's value by a restrained 14 percent.
 */
export function opaqueTintedFillFrame(
  atlas: Texture,
  grid: FrameGrid,
  name: string,
  tint: string,
): Texture {
  const key = opaqueFillCacheKey(name, tint)
  let cached = opaqueFills.get(atlas)
  if (cached === undefined) {
    cached = new Map()
    opaqueFills.set(atlas, cached)
  }
  const existing = cached.get(key)
  if (existing !== undefined) return existing

  const frame = frameRectangle(grid, name)
  const canvas = document.createElement('canvas')
  canvas.width = frame.width
  canvas.height = frame.height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('A 2D canvas is required to tint Three Branches artwork.')
  const resource = atlas.source.resource
  if (resource === null) throw new Error(`Atlas texture has no image source for frame ${name}.`)
  context.drawImage(
    resource as CanvasImageSource,
    frame.x,
    frame.y,
    frame.width,
    frame.height,
    0,
    0,
    frame.width,
    frame.height,
  )
  const pixels = context.getImageData(0, 0, frame.width, frame.height)
  opaqueFillPixels(pixels.data, tint)
  context.putImageData(pixels, 0, 0)
  const baked = Texture.from(canvas)
  cached.set(key, baked)
  return baked
}

const cutoutFills = new WeakMap<Texture, Map<string, Texture>>()

/** Bake one opaque terrain detail through one inverse-alpha cardinal cutout mask. */
export function cutoutTintedFillFrame(
  atlas: Texture,
  grid: FrameGrid,
  fillName: string,
  tint: string,
  maskName: string,
): Texture {
  const key = cutoutFillCacheKey(fillName, maskName, tint)
  let cached = cutoutFills.get(atlas)
  if (cached === undefined) {
    cached = new Map()
    cutoutFills.set(atlas, cached)
  }
  const existing = cached.get(key)
  if (existing !== undefined) return existing

  const fillFrame = frameRectangle(grid, fillName)
  const maskFrame = frameRectangle(grid, maskName)
  const canvas = document.createElement('canvas')
  canvas.width = fillFrame.width
  canvas.height = fillFrame.height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('A 2D canvas is required to cut out Three Branches artwork.')
  const resource = atlas.source.resource
  if (resource === null) throw new Error(`Atlas texture has no image source for frame ${fillName}.`)
  context.drawImage(
    resource as CanvasImageSource,
    fillFrame.x,
    fillFrame.y,
    fillFrame.width,
    fillFrame.height,
    0,
    0,
    fillFrame.width,
    fillFrame.height,
  )
  const fillPixels = context.getImageData(0, 0, fillFrame.width, fillFrame.height)
  opaqueFillPixels(fillPixels.data, tint)
  context.clearRect(0, 0, fillFrame.width, fillFrame.height)
  context.drawImage(
    resource as CanvasImageSource,
    maskFrame.x,
    maskFrame.y,
    maskFrame.width,
    maskFrame.height,
    0,
    0,
    maskFrame.width,
    maskFrame.height,
  )
  const maskPixels = context.getImageData(0, 0, maskFrame.width, maskFrame.height)
  cutoutFillPixels(fillPixels.data, maskPixels.data)
  context.putImageData(fillPixels, 0, 0)
  const baked = Texture.from(canvas)
  cached.set(key, baked)
  return baked
}

/** Apply the opaque base and restrained same-hue value variation to RGBA terrain pixels. */
export function opaqueFillPixels(pixels: Uint8ClampedArray, tint: string): void {
  const [red, green, blue] = tintChannels(tint)
  for (let index = 0; index < pixels.length; index += 4) {
    const grayscale = (pixels[index] ?? 0) / 255
    const alpha = (pixels[index + 3] ?? 0) / 255
    const value = 1 + TERRAIN_FILL_DETAIL_STRENGTH * alpha * (grayscale * 2 - 1)
    pixels[index] = Math.round(red * value)
    pixels[index + 1] = Math.round(green * value)
    pixels[index + 2] = Math.round(blue * value)
    pixels[index + 3] = 255
  }
}

/** Feather an already tinted fill to transparency using the inverse alpha of a mask. */
export function cutoutFillPixels(
  fillPixels: Uint8ClampedArray,
  maskPixels: Uint8ClampedArray,
): void {
  if (fillPixels.length !== maskPixels.length || fillPixels.length % 4 !== 0) {
    throw new Error('Terrain cutout fill and mask pixels must have matching RGBA dimensions.')
  }
  for (let index = 3; index < fillPixels.length; index += 4) {
    const fillAlpha = fillPixels[index] ?? 0
    const maskAlpha = maskPixels[index] ?? 0
    fillPixels[index] = Math.round(fillAlpha * (1 - maskAlpha / 255))
  }
}

function maskOpacity(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('Terrain mask opacity must be between zero and one.')
  }
  return value
}
function tintChannels(tint: string): [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(tint)
  if (match === null) throw new Error(`Invalid atlas tint: ${tint}`)
  return match.slice(1).map((channel) => Number.parseInt(channel ?? '0', 16)) as [number, number, number]
}
