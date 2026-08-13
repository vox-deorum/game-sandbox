export type AtlasFormat = 'full-color' | 'grayscale-alpha'

/** A decoded PNG whose data is one RGBA byte quartet per pixel. */
export interface RgbaImage {
  width: number
  height: number
  data: Uint8Array
}

/** One atlas page and the loose frames that define it. All paths are renderer-relative. */
export interface AtlasPageSpec {
  group: string
  pagePath: string
  framesPath: string
  format: AtlasFormat
  width: number
  height: number
  columns: number
  rows: number
  framePaths: readonly string[]
}

/** One ordered loose frame, ready to compose into its declared atlas position. */
export interface AtlasFrame {
  path: string
  name: string
  image: RgbaImage
}

/** Confirm that a page contract describes a complete, rectangular atlas. */
export function validateAtlasPageSpec(spec: AtlasPageSpec): void {
  if (spec.group.trim().length === 0) throw new Error('Atlas group must not be empty')
  if (spec.format !== 'full-color' && spec.format !== 'grayscale-alpha') {
    throw new Error(`Unknown atlas format: ${spec.format}`)
  }
  validateRendererPath(spec.pagePath, 'page path')
  if (!spec.pagePath.endsWith('.png'))
    throw new Error(`Atlas page path must end in .png: ${spec.pagePath}`)
  validateRendererPath(spec.framesPath, 'frames path')
  if (!isPositiveInteger(spec.width) || !isPositiveInteger(spec.height)) {
    throw new Error('Atlas dimensions must be positive integers')
  }
  if (!isPositiveInteger(spec.columns) || !isPositiveInteger(spec.rows)) {
    throw new Error('Atlas grid columns and rows must be positive integers')
  }
  if (spec.width % spec.columns !== 0 || spec.height % spec.rows !== 0) {
    throw new Error('Atlas dimensions must divide evenly by its grid')
  }
  if (spec.framePaths.length !== spec.columns * spec.rows) {
    throw new Error(
      `Atlas grid expects ${spec.columns * spec.rows} frame paths, received ${spec.framePaths.length}`,
    )
  }

  const names = new Set<string>()
  const paths = new Set<string>()
  for (const path of spec.framePaths) {
    validateFramePath(path)
    if (paths.has(path)) throw new Error(`Atlas frame path is repeated: ${path}`)
    paths.add(path)
    const name = frameName(path)
    if (names.has(name)) throw new Error(`Atlas frame name is repeated: ${name}`)
    names.add(name)
  }
}

/** Convert one PNG path under a frames directory into its stable camel-case frame name. */
export function frameName(path: string): string {
  validateFramePath(path)
  const withoutExtension = path.slice(0, -'.png'.length)
  const words = withoutExtension.split(/[/_-]+/)
  return words
    .map((word, index) => (index === 0 ? word : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`))
    .join('')
}

/** Cut a decoded atlas page into independent, row-major loose frames. */
export function splitAtlas(spec: AtlasPageSpec, atlas: RgbaImage): AtlasFrame[] {
  validateAtlasPageSpec(spec)
  validateImage(atlas, 'Atlas page')
  if (atlas.width !== spec.width || atlas.height !== spec.height) {
    throw new Error(
      `Atlas page has dimensions ${atlas.width}x${atlas.height}, expected ${spec.width}x${spec.height}`,
    )
  }

  const frameWidth = spec.width / spec.columns
  const frameHeight = spec.height / spec.rows
  return spec.framePaths.map((path, index) => {
    const column = index % spec.columns
    const row = Math.floor(index / spec.columns)
    return {
      path,
      name: frameName(path),
      image: copyRectangle(atlas, column * frameWidth, row * frameHeight, frameWidth, frameHeight),
    }
  })
}

/** Validate loose frames and compose them into their declared row-major atlas page. */
export function composeAtlas(spec: AtlasPageSpec, frames: readonly AtlasFrame[]): RgbaImage {
  validateAtlasPageSpec(spec)
  validateAtlasFrames(spec, frames)
  const data = new Uint8Array(spec.width * spec.height * 4)
  const frameWidth = spec.width / spec.columns
  const frameHeight = spec.height / spec.rows
  for (const [index, frame] of frames.entries()) {
    const column = index % spec.columns
    const row = Math.floor(index / spec.columns)
    copyInto(frame.image, data, spec.width, column * frameWidth, row * frameHeight)
  }
  return { width: spec.width, height: spec.height, data }
}

/** Validate frame membership, frame dimensions, and grayscale-alpha pixel values. */
export function validateAtlasFrames(spec: AtlasPageSpec, frames: readonly AtlasFrame[]): void {
  validateAtlasPageSpec(spec)
  const expectedPaths = new Set(spec.framePaths)
  const actualPaths = new Set(frames.map((frame) => frame.path))
  const missing = spec.framePaths.filter((path) => !actualPaths.has(path))
  const stray = frames.map((frame) => frame.path).filter((path) => !expectedPaths.has(path))
  const duplicates = frames
    .map((frame) => frame.path)
    .filter((path, index, paths) => paths.indexOf(path) !== index)
  if (
    missing.length > 0 ||
    stray.length > 0 ||
    duplicates.length > 0 ||
    frames.length !== spec.framePaths.length
  ) {
    throw new Error(frameSetProblem(missing, stray, duplicates))
  }

  const frameWidth = spec.width / spec.columns
  const frameHeight = spec.height / spec.rows
  for (const [index, frame] of frames.entries()) {
    const path = spec.framePaths[index]
    if (frame.path !== path) {
      throw new Error(
        `Atlas frames must follow declared order: expected ${path}, received ${frame.path}`,
      )
    }
    const name = frameName(frame.path)
    if (frame.name !== name)
      throw new Error(`Atlas frame name must be ${name}, received ${frame.name}`)
    validateImage(frame.image, `Atlas frame ${name}`)
    if (frame.image.width !== frameWidth || frame.image.height !== frameHeight) {
      throw new Error(
        `Atlas frame ${name} has dimensions ${frame.image.width}x${frame.image.height}, expected ${frameWidth}x${frameHeight}`,
      )
    }
    if (spec.format === 'grayscale-alpha') validateGrayscaleAlpha(frame)
  }
}

/** Return the name of the first frame whose decoded pixels differ, or null when images match. */
export function compareAtlasPixels(
  spec: AtlasPageSpec,
  expected: RgbaImage,
  actual: RgbaImage,
): string | null {
  validateAtlasPageSpec(spec)
  validateImage(expected, 'Expected atlas page')
  validateImage(actual, 'Actual atlas page')
  if (
    expected.width !== spec.width ||
    expected.height !== spec.height ||
    actual.width !== spec.width ||
    actual.height !== spec.height
  ) {
    return frameName(spec.framePaths[0] ?? '')
  }
  for (let index = 0; index < expected.data.length; index += 1) {
    if (expected.data[index] === actual.data[index]) continue
    const pixel = Math.floor(index / 4)
    const x = pixel % spec.width
    const y = Math.floor(pixel / spec.width)
    const frameColumn = Math.floor(x / (spec.width / spec.columns))
    const frameRow = Math.floor(y / (spec.height / spec.rows))
    const frameIndex = frameRow * spec.columns + frameColumn
    return frameName(spec.framePaths[frameIndex] ?? '')
  }
  return null
}

/** Describe missing, stray, and repeated loose PNG paths in one actionable error. */
export function frameSetProblem(
  missing: readonly string[],
  stray: readonly string[],
  duplicates: readonly string[] = [],
): string {
  const problems: string[] = []
  if (missing.length > 0) problems.push(`missing: ${missing.join(', ')}`)
  if (stray.length > 0) problems.push(`stray: ${stray.join(', ')}`)
  if (duplicates.length > 0) problems.push(`repeated: ${[...new Set(duplicates)].join(', ')}`)
  return `Atlas frames do not match the declared set (${problems.join('; ')})`
}

function validateGrayscaleAlpha(frame: AtlasFrame): void {
  for (let index = 0; index < frame.image.data.length; index += 4) {
    const red = frame.image.data[index]
    const green = frame.image.data[index + 1]
    const blue = frame.image.data[index + 2]
    if (red === green && green === blue) continue
    throw new Error(`Atlas frame ${frame.name} is not grayscale-alpha at pixel ${index / 4}`)
  }
}

function copyRectangle(
  source: RgbaImage,
  sourceX: number,
  sourceY: number,
  width: number,
  height: number,
): RgbaImage {
  const data = new Uint8Array(width * height * 4)
  for (let row = 0; row < height; row += 1) {
    const sourceStart = ((sourceY + row) * source.width + sourceX) * 4
    data.set(source.data.subarray(sourceStart, sourceStart + width * 4), row * width * 4)
  }
  return { width, height, data }
}

function copyInto(
  source: RgbaImage,
  target: Uint8Array,
  targetWidth: number,
  targetX: number,
  targetY: number,
): void {
  for (let row = 0; row < source.height; row += 1) {
    const targetStart = ((targetY + row) * targetWidth + targetX) * 4
    target.set(
      source.data.subarray(row * source.width * 4, (row + 1) * source.width * 4),
      targetStart,
    )
  }
}

function validateImage(image: RgbaImage, label: string): void {
  if (!isPositiveInteger(image.width) || !isPositiveInteger(image.height)) {
    throw new Error(`${label} dimensions must be positive integers`)
  }
  if (image.data.length !== image.width * image.height * 4) {
    throw new Error(`${label} must contain exactly four RGBA bytes per pixel`)
  }
}

function validateRendererPath(path: string, label: string): void {
  if (!path.startsWith('./') || path.includes('\\') || path.split('/').includes('..')) {
    throw new Error(`Atlas ${label} must be a renderer-relative POSIX path: ${path}`)
  }
}

function validateFramePath(path: string): void {
  if (
    !path.endsWith('.png') ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').includes('..')
  ) {
    throw new Error(`Atlas frame path must be a relative PNG path: ${path}`)
  }
  if (path.split('/').some((part) => part.length === 0 || part === '.')) {
    throw new Error(`Atlas frame path is invalid: ${path}`)
  }
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}
