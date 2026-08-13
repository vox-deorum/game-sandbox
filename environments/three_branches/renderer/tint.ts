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
export function tintedMaskCacheKey(frame: string, tint: string): string {
  return `${frame}:${tint.toLowerCase()}`
}

const tintedMasks = new WeakMap<Texture, Map<string, Texture>>()

/** Bake a grayscale-alpha atlas frame once for a tilemap that cannot tint individual packed tiles. */
export function tintedMaskFrame(
  atlas: Texture,
  grid: FrameGrid,
  name: string,
  tint: string,
): Texture {
  const key = tintedMaskCacheKey(name, tint)
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
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(tint)
  if (match === null) throw new Error(`Invalid atlas tint: ${tint}`)
  const [red, green, blue] = match.slice(1).map((channel) => Number.parseInt(channel ?? '0', 16))
  const pixels = context.getImageData(0, 0, frame.width, frame.height)
  for (let index = 0; index < pixels.data.length; index += 4) {
    const grayscale = (pixels.data[index] ?? 0) / 255
    pixels.data[index] = Math.round((red ?? 0) * grayscale)
    pixels.data[index + 1] = Math.round((green ?? 0) * grayscale)
    pixels.data[index + 2] = Math.round((blue ?? 0) * grayscale)
  }
  context.putImageData(pixels, 0, 0)
  const baked = Texture.from(canvas)
  cached.set(key, baked)
  return baked
}
