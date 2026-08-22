export type AtlasFormat = 'full-color' | 'grayscale-alpha'

/** A decoded PNG whose data is one RGBA byte quartet per pixel. */
export interface RgbaImage {
  width: number
  height: number
  data: Uint8Array
}

export interface AtlasCrop {
  x: number
  y: number
  width: number
  height: number
}

export interface AtlasSource {
  path: string
  crop?: AtlasCrop
}

export interface AtlasAlphaNormalization {
  clearAtOrBelow: number
  opaqueAtOrAbove?: number
}

export interface AtlasOutputAlpha {
  clearAtOrBelow?: number
  opaqueAtOrAbove?: number
  clearColorAtZero?: boolean
}

export type AtlasAnchor = { x: number; y: number } | { x: number; bottom: number }

export type AtlasCellRender =
  | { kind: 'copy' }
  | {
      kind: 'resize'
      resampler: 'area-premultiplied-encoded-rgb'
      outputAlpha: AtlasOutputAlpha
    }
  | {
      kind: 'fitVisible'
      sourceAlpha: AtlasAlphaNormalization
      bounds: { alphaAbove: number; fromCell?: string }
      maxSize: { width: number; height: number }
      anchor: AtlasAnchor
      resampler: 'bilinear-premultiplied-encoded-rgb'
      outputAlpha: AtlasOutputAlpha
    }

export interface AtlasCell {
  name: string
  source: AtlasSource
  render?: AtlasCellRender
}

/** One source-art build recipe for a runtime atlas page. All paths are renderer-relative. */
export interface AtlasBuildPageSpec {
  group: string
  pageKey?: string
  pagePath: string
  format: AtlasFormat
  width: number
  height: number
  columns: number
  rows: number
  cells: readonly AtlasCell[]
}

/** A cell source decoded by the I/O layer. */
export interface AtlasSourceImage {
  name: string
  image: RgbaImage
}

/** The stable tool and diagnostic key for a build page. */
export function atlasPageKey(spec: AtlasBuildPageSpec): string {
  return spec.pageKey ?? spec.group
}

/** The names exposed to the runtime frame grid, in row-major atlas order. */
export function atlasCellNames(spec: AtlasBuildPageSpec): readonly string[] {
  return spec.cells.map((cell) => cell.name)
}

/** Validate a source-art recipe before reading or rendering pixels. */
export function validateAtlasBuildPageSpec(spec: AtlasBuildPageSpec): void {
  validateExactKeys(
    spec,
    ['group', 'pageKey', 'pagePath', 'format', 'width', 'height', 'columns', 'rows', 'cells'],
    'atlas page',
  )
  if (!isNonEmptyString(spec.group)) throw new Error('Atlas group must not be empty')
  if (spec.pageKey !== undefined && !isNonEmptyString(spec.pageKey))
    throw new Error('Atlas page key must not be empty')
  if (spec.format !== 'full-color' && spec.format !== 'grayscale-alpha')
    throw new Error(`Unknown atlas format: ${String(spec.format)}`)
  validateRendererPath(spec.pagePath, 'page path')
  if (!spec.pagePath.endsWith('.png'))
    throw new Error(`Atlas page path must end in .png: ${spec.pagePath}`)
  if (!isPositiveInteger(spec.width) || !isPositiveInteger(spec.height))
    throw new Error('Atlas dimensions must be positive integers')
  if (!isPositiveInteger(spec.columns) || !isPositiveInteger(spec.rows))
    throw new Error('Atlas grid columns and rows must be positive integers')
  if (spec.width % spec.columns !== 0 || spec.height % spec.rows !== 0)
    throw new Error('Atlas dimensions must divide evenly by its grid')
  const capacity = spec.columns * spec.rows
  if (!Array.isArray(spec.cells) || spec.cells.length === 0)
    throw new Error('Atlas must declare at least one cell')
  if (spec.cells.length > capacity)
    throw new Error(`Atlas grid capacity is ${capacity} cells, received ${spec.cells.length}`)

  const names = new Set<string>()
  for (const cell of spec.cells) {
    validateCell(cell)
    if (names.has(cell.name)) throw new Error(`Atlas cell name is repeated: ${cell.name}`)
    names.add(cell.name)
    if (cell.source.path === spec.pagePath)
      throw new Error(`Atlas cell ${cell.name} source must not be its output page`)
  }
  for (const cell of spec.cells) {
    const render = cell.render
    if (render?.kind !== 'fitVisible' || render.bounds.fromCell === undefined) continue
    if (!names.has(render.bounds.fromCell))
      throw new Error(
        `Atlas cell ${cell.name} references unknown bounds cell: ${render.bounds.fromCell}`,
      )
  }
  assertNoBoundsCycles(spec)
}

/** Validate a complete environment catalog's unique tool identities and output paths. */
export function validateAtlasBuildPages(pages: readonly AtlasBuildPageSpec[]): void {
  const keys = new Set<string>()
  const paths = new Set<string>()
  for (const page of pages) {
    validateAtlasBuildPageSpec(page)
    const key = atlasPageKey(page)
    if (keys.has(key)) throw new Error(`Atlas page key is repeated: ${key}`)
    if (paths.has(page.pagePath)) throw new Error(`Atlas page path is repeated: ${page.pagePath}`)
    keys.add(key)
    paths.add(page.pagePath)
  }
}

/** Compile decoded cell sources into their configured row-major runtime atlas. */
export function compileAtlas(
  spec: AtlasBuildPageSpec,
  sources: readonly AtlasSourceImage[],
): RgbaImage {
  validateAtlasBuildPageSpec(spec)
  const sourceByName = new Map(sources.map((source) => [source.name, source.image]))
  const expected = new Set(atlasCellNames(spec))
  const missing = spec.cells.map((cell) => cell.name).filter((name) => !sourceByName.has(name))
  const stray = sources.map((source) => source.name).filter((name) => !expected.has(name))
  const duplicates = sources
    .map((source) => source.name)
    .filter((name, index, names) => names.indexOf(name) !== index)
  if (
    missing.length > 0 ||
    stray.length > 0 ||
    duplicates.length > 0 ||
    sources.length !== spec.cells.length
  ) {
    throw new Error(sourceSetProblem(missing, stray, duplicates))
  }

  const prepared = new Map<string, RgbaImage>()
  for (const cell of spec.cells) {
    const source = sourceByName.get(cell.name)
    if (source === undefined) throw new Error(`Missing source image for ${cell.name}`)
    validateImage(source, `Atlas source ${cell.name}`)
    prepared.set(cell.name, cropImage(source, cell.source.crop, cell.name))
  }

  const output = {
    width: spec.width,
    height: spec.height,
    data: new Uint8Array(spec.width * spec.height * 4),
  }
  const frameWidth = spec.width / spec.columns
  const frameHeight = spec.height / spec.rows
  for (const [index, cell] of spec.cells.entries()) {
    const source = prepared.get(cell.name)
    if (source === undefined) throw new Error(`Missing prepared source for ${cell.name}`)
    const frame = renderCell(cell, source, prepared, frameWidth, frameHeight)
    validateImage(frame, `Atlas cell ${cell.name}`)
    if (frame.width !== frameWidth || frame.height !== frameHeight) {
      throw new Error(
        `Atlas cell ${cell.name} has dimensions ${frame.width}x${frame.height}, expected ${frameWidth}x${frameHeight}`,
      )
    }
    if (spec.format === 'grayscale-alpha') validateGrayscaleAlpha(frame, cell.name)
    copyInto(
      frame,
      output.data,
      spec.width,
      (index % spec.columns) * frameWidth,
      Math.floor(index / spec.columns) * frameHeight,
    )
  }
  return output
}

/** Return the first differing named cell or unused cell, or null when images match. */
export function compareAtlasPixels(
  spec: AtlasBuildPageSpec,
  expected: RgbaImage,
  actual: RgbaImage,
): string | null {
  validateAtlasBuildPageSpec(spec)
  validateImage(expected, 'Expected atlas page')
  validateImage(actual, 'Actual atlas page')
  if (
    expected.width !== spec.width ||
    expected.height !== spec.height ||
    actual.width !== spec.width ||
    actual.height !== spec.height
  ) {
    return spec.cells[0]?.name ?? 'unused cell 0'
  }
  for (let index = 0; index < expected.data.length; index += 1) {
    if (expected.data[index] === actual.data[index]) continue
    const pixel = Math.floor(index / 4)
    const x = pixel % spec.width
    const y = Math.floor(pixel / spec.width)
    const column = Math.floor(x / (spec.width / spec.columns))
    const row = Math.floor(y / (spec.height / spec.rows))
    const cell = row * spec.columns + column
    return spec.cells[cell]?.name ?? `unused cell ${cell}`
  }
  return null
}

function renderCell(
  cell: AtlasCell,
  source: RgbaImage,
  prepared: ReadonlyMap<string, RgbaImage>,
  width: number,
  height: number,
): RgbaImage {
  const render = cell.render
  if (render === undefined || render.kind === 'copy') {
    if (source.width !== width || source.height !== height) {
      throw new Error(
        `Atlas cell ${cell.name} copy source has dimensions ${source.width}x${source.height}, expected ${width}x${height}`,
      )
    }
    return { width, height, data: new Uint8Array(source.data) }
  }
  if (render.kind === 'resize')
    return applyOutputAlpha(resizeArea(source, width, height), render.outputAlpha)
  const normalized = normalizeAlpha(source, render.sourceAlpha)
  const boundsImage =
    render.bounds.fromCell === undefined ? normalized : prepared.get(render.bounds.fromCell)
  if (boundsImage === undefined) {
    throw new Error(
      `Atlas cell ${cell.name} references unavailable bounds cell: ${render.bounds.fromCell}`,
    )
  }
  const boundsSource =
    render.bounds.fromCell === undefined
      ? boundsImage
      : normalizeAlpha(boundsImage, render.sourceAlpha)
  if (boundsSource.width !== normalized.width || boundsSource.height !== normalized.height) {
    throw new Error(
      `Atlas cell ${cell.name} shared bounds source dimensions do not match its source`,
    )
  }
  const bounds = visibleBounds(boundsSource, render.bounds.alphaAbove, cell.name)
  const fitted = fitVisible(
    normalized,
    bounds,
    width,
    height,
    render.maxSize,
    render.anchor,
    cell.name,
  )
  return applyOutputAlpha(fitted, render.outputAlpha)
}

function resizeArea(source: RgbaImage, width: number, height: number): RgbaImage {
  const output = { width, height, data: new Uint8Array(width * height * 4) }
  const scaleX = source.width / width
  const scaleY = source.height / height
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const left = x * scaleX
      const right = (x + 1) * scaleX
      const top = y * scaleY
      const bottom = (y + 1) * scaleY
      let alpha = 0
      const rgb = [0, 0, 0]
      for (let sourceY = Math.floor(top); sourceY < Math.ceil(bottom); sourceY += 1) {
        for (let sourceX = Math.floor(left); sourceX < Math.ceil(right); sourceX += 1) {
          const weight =
            (Math.max(0, Math.min(right, sourceX + 1) - Math.max(left, sourceX)) *
              Math.max(0, Math.min(bottom, sourceY + 1) - Math.max(top, sourceY))) /
            (scaleX * scaleY)
          if (weight === 0) continue
          const index = (sourceY * source.width + sourceX) * 4
          const sampleAlpha = (source.data[index + 3] ?? 0) / 255
          alpha += sampleAlpha * weight
          for (let channel = 0; channel < 3; channel += 1) {
            rgb[channel] =
              (rgb[channel] ?? 0) + (source.data[index + channel] ?? 0) * sampleAlpha * weight
          }
        }
      }
      writePremultiplied(output.data, (y * width + x) * 4, rgb, alpha)
    }
  }
  return output
}

function fitVisible(
  source: RgbaImage,
  bounds: AtlasCrop,
  width: number,
  height: number,
  maxSize: { width: number; height: number },
  anchor: AtlasAnchor,
  name: string,
): RgbaImage {
  const scale = Math.min(maxSize.width / bounds.width, maxSize.height / bounds.height)
  const fittedWidth = Math.max(1, Math.round(bounds.width * scale))
  const fittedHeight = Math.max(1, Math.round(bounds.height * scale))
  const left = Math.round(anchor.x - fittedWidth / 2)
  const top =
    'bottom' in anchor ? anchor.bottom - fittedHeight : Math.round(anchor.y - fittedHeight / 2)
  if (left < 0 || top < 0 || left + fittedWidth > width || top + fittedHeight > height)
    throw new Error(`Atlas cell ${name} fit clips outside its frame`)
  const output = { width, height, data: new Uint8Array(width * height * 4) }
  for (let y = 0; y < fittedHeight; y += 1) {
    for (let x = 0; x < fittedWidth; x += 1) {
      const pixel = sampleBilinear(
        source,
        bounds.x + ((x + 0.5) * bounds.width) / fittedWidth - 0.5,
        bounds.y + ((y + 0.5) * bounds.height) / fittedHeight - 0.5,
      )
      output.data.set(pixel, ((top + y) * width + left + x) * 4)
    }
  }
  return output
}

function sampleBilinear(image: RgbaImage, x: number, y: number): Uint8Array {
  const x0 = clamp(Math.floor(x), 0, image.width - 1)
  const y0 = clamp(Math.floor(y), 0, image.height - 1)
  const x1 = Math.min(image.width - 1, x0 + 1)
  const y1 = Math.min(image.height - 1, y0 + 1)
  const xWeight = x - Math.floor(x)
  const yWeight = y - Math.floor(y)
  let alpha = 0
  const rgb = [0, 0, 0]
  for (const [sourceX, sourceY, weight] of [
    [x0, y0, (1 - xWeight) * (1 - yWeight)],
    [x1, y0, xWeight * (1 - yWeight)],
    [x0, y1, (1 - xWeight) * yWeight],
    [x1, y1, xWeight * yWeight],
  ] as const) {
    const index = (sourceY * image.width + sourceX) * 4
    const sampleAlpha = (image.data[index + 3] ?? 0) / 255
    alpha += sampleAlpha * weight
    for (let channel = 0; channel < 3; channel += 1) {
      rgb[channel] = (rgb[channel] ?? 0) + (image.data[index + channel] ?? 0) * sampleAlpha * weight
    }
  }
  const pixel = new Uint8Array(4)
  writePremultiplied(pixel, 0, rgb, alpha)
  return pixel
}

function writePremultiplied(
  data: Uint8Array,
  index: number,
  rgb: readonly number[],
  alpha: number,
): void {
  if (alpha === 0) return
  data[index] = Math.round((rgb[0] ?? 0) / alpha)
  data[index + 1] = Math.round((rgb[1] ?? 0) / alpha)
  data[index + 2] = Math.round((rgb[2] ?? 0) / alpha)
  data[index + 3] = Math.round(alpha * 255)
}

function normalizeAlpha(image: RgbaImage, rules: AtlasAlphaNormalization): RgbaImage {
  const output = { width: image.width, height: image.height, data: new Uint8Array(image.data) }
  for (let index = 0; index < output.data.length; index += 4) {
    const alpha = output.data[index + 3] ?? 0
    if (alpha <= rules.clearAtOrBelow) output.data.fill(0, index, index + 4)
    else if (rules.opaqueAtOrAbove !== undefined && alpha >= rules.opaqueAtOrAbove)
      output.data[index + 3] = 255
  }
  return output
}

function applyOutputAlpha(image: RgbaImage, rules: AtlasOutputAlpha): RgbaImage {
  const output = { width: image.width, height: image.height, data: new Uint8Array(image.data) }
  if (rules.clearAtOrBelow !== undefined) {
    for (let index = 0; index < output.data.length; index += 4) {
      if ((output.data[index + 3] ?? 0) <= rules.clearAtOrBelow)
        output.data.fill(0, index, index + 4)
      else if (
        rules.opaqueAtOrAbove !== undefined &&
        (output.data[index + 3] ?? 0) >= rules.opaqueAtOrAbove
      )
        output.data[index + 3] = 255
    }
  } else if (rules.opaqueAtOrAbove !== undefined) {
    for (let index = 0; index < output.data.length; index += 4) {
      if ((output.data[index + 3] ?? 0) >= rules.opaqueAtOrAbove) output.data[index + 3] = 255
    }
  }
  if (rules.clearColorAtZero) {
    for (let index = 0; index < output.data.length; index += 4) {
      if (output.data[index + 3] === 0) output.data.fill(0, index, index + 3)
    }
  }
  return output
}

function visibleBounds(image: RgbaImage, threshold: number, name: string): AtlasCrop {
  let left = image.width
  let top = image.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if ((image.data[(y * image.width + x) * 4 + 3] ?? 0) <= threshold) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < left || bottom < top)
    throw new Error(`Atlas cell ${name} has no visible pixels above alpha ${threshold}`)
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

function cropImage(image: RgbaImage, crop: AtlasCrop | undefined, name: string): RgbaImage {
  if (crop === undefined) return image
  if (crop.x + crop.width > image.width || crop.y + crop.height > image.height)
    throw new Error(`Atlas cell ${name} crop exceeds source dimensions`)
  const data = new Uint8Array(crop.width * crop.height * 4)
  for (let y = 0; y < crop.height; y += 1) {
    data.set(
      image.data.subarray(
        ((crop.y + y) * image.width + crop.x) * 4,
        ((crop.y + y) * image.width + crop.x + crop.width) * 4,
      ),
      y * crop.width * 4,
    )
  }
  return { width: crop.width, height: crop.height, data }
}

function validateCell(cell: AtlasCell): void {
  validateExactKeys(cell, ['name', 'source', 'render'], 'atlas cell')
  if (!isNonEmptyString(cell.name)) throw new Error('Atlas cell name must not be empty')
  validateExactKeys(cell.source, ['path', 'crop'], `atlas cell ${cell.name} source`)
  validateRendererPath(cell.source.path, `cell ${cell.name} source path`)
  if (!cell.source.path.endsWith('.png'))
    throw new Error(`Atlas cell ${cell.name} source path must end in .png`)
  if (cell.source.crop !== undefined) validateCrop(cell.source.crop, cell.name)
  if (cell.render === undefined) return
  if (cell.render.kind === 'copy') {
    validateExactKeys(cell.render, ['kind'], `atlas cell ${cell.name} copy render`)
    return
  }
  if (cell.render.kind === 'resize') {
    validateExactKeys(
      cell.render,
      ['kind', 'resampler', 'outputAlpha'],
      `atlas cell ${cell.name} resize render`,
    )
    if (cell.render.resampler !== 'area-premultiplied-encoded-rgb')
      throw new Error(`Atlas cell ${cell.name} has unknown resize resampler`)
    validateOutputAlpha(cell.render.outputAlpha, cell.name)
    return
  }
  if (cell.render.kind !== 'fitVisible')
    throw new Error(
      `Atlas cell ${cell.name} has unknown render kind: ${String(
        (cell.render as { kind?: unknown }).kind,
      )}`,
    )
  validateExactKeys(
    cell.render,
    ['kind', 'sourceAlpha', 'bounds', 'maxSize', 'anchor', 'resampler', 'outputAlpha'],
    `atlas cell ${cell.name} fitVisible render`,
  )
  validateAlphaNormalization(cell.render.sourceAlpha, `Atlas cell ${cell.name} source alpha`)
  validateExactKeys(
    cell.render.bounds,
    ['alphaAbove', 'fromCell'],
    `Atlas cell ${cell.name} bounds`,
  )
  validateThreshold(cell.render.bounds.alphaAbove, `Atlas cell ${cell.name} bounds alphaAbove`)
  if (cell.render.bounds.fromCell !== undefined && !isNonEmptyString(cell.render.bounds.fromCell)) {
    throw new Error(`Atlas cell ${cell.name} bounds reference must not be empty`)
  }
  validateExactKeys(
    cell.render.maxSize,
    ['width', 'height'],
    `Atlas cell ${cell.name} maximum size`,
  )
  if (
    !isPositiveInteger(cell.render.maxSize.width) ||
    !isPositiveInteger(cell.render.maxSize.height)
  ) {
    throw new Error(`Atlas cell ${cell.name} maximum size must be positive integers`)
  }
  validateAnchor(cell.render.anchor, cell.name)
  if (cell.render.resampler !== 'bilinear-premultiplied-encoded-rgb')
    throw new Error(`Atlas cell ${cell.name} has unknown fitVisible resampler`)
  validateOutputAlpha(cell.render.outputAlpha, cell.name)
}

function validateCrop(crop: AtlasCrop, name: string): void {
  validateExactKeys(crop, ['x', 'y', 'width', 'height'], `Atlas cell ${name} crop`)
  if (
    !isNonNegativeInteger(crop.x) ||
    !isNonNegativeInteger(crop.y) ||
    !isPositiveInteger(crop.width) ||
    !isPositiveInteger(crop.height)
  ) {
    throw new Error(
      `Atlas cell ${name} crop must use nonnegative coordinates and positive dimensions`,
    )
  }
}

function validateAlphaNormalization(rules: AtlasAlphaNormalization, label: string): void {
  validateExactKeys(rules, ['clearAtOrBelow', 'opaqueAtOrAbove'], label)
  validateThreshold(rules.clearAtOrBelow, `${label} clearAtOrBelow`)
  if (rules.opaqueAtOrAbove !== undefined)
    validateThreshold(rules.opaqueAtOrAbove, `${label} opaqueAtOrAbove`)
}

function validateOutputAlpha(rules: AtlasOutputAlpha, name: string): void {
  if (typeof rules !== 'object' || rules === null || Array.isArray(rules))
    throw new Error(`Atlas cell ${name} output alpha is required`)
  validateExactKeys(
    rules,
    ['clearAtOrBelow', 'opaqueAtOrAbove', 'clearColorAtZero'],
    `Atlas cell ${name} output alpha`,
  )
  if (rules.clearAtOrBelow !== undefined)
    validateThreshold(rules.clearAtOrBelow, `Atlas cell ${name} output alpha clearAtOrBelow`)
  if (rules.opaqueAtOrAbove !== undefined)
    validateThreshold(rules.opaqueAtOrAbove, `Atlas cell ${name} output alpha opaqueAtOrAbove`)
  if (rules.clearColorAtZero !== undefined && typeof rules.clearColorAtZero !== 'boolean')
    throw new Error(`Atlas cell ${name} output alpha clearColorAtZero must be boolean`)
}

function validateAnchor(anchor: AtlasAnchor, name: string): void {
  const keys = Object.keys(anchor)
  const centered = keys.length === 2 && keys.includes('x') && keys.includes('y')
  const bottom = keys.length === 2 && keys.includes('x') && keys.includes('bottom')
  if (!centered && !bottom) throw new Error(`Atlas cell ${name} anchor must use x with y or bottom`)
  if (
    !isFiniteNumber(anchor.x) ||
    (centered && !isFiniteNumber((anchor as { y: number }).y)) ||
    (bottom && !isFiniteNumber((anchor as { bottom: number }).bottom))
  ) {
    throw new Error(`Atlas cell ${name} anchor coordinates must be finite numbers`)
  }
}

function assertNoBoundsCycles(spec: AtlasBuildPageSpec): void {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const cells = new Map(spec.cells.map((cell) => [cell.name, cell]))
  const visit = (name: string): void => {
    if (visited.has(name)) return
    if (visiting.has(name)) throw new Error(`Atlas bounds references contain a cycle at ${name}`)
    visiting.add(name)
    const render = cells.get(name)?.render
    if (render?.kind === 'fitVisible' && render.bounds.fromCell !== undefined)
      visit(render.bounds.fromCell)
    visiting.delete(name)
    visited.add(name)
  }
  for (const cell of spec.cells) visit(cell.name)
}

function validateGrayscaleAlpha(image: RgbaImage, name: string): void {
  for (let index = 0; index < image.data.length; index += 4) {
    if (
      image.data[index] !== image.data[index + 1] ||
      image.data[index + 1] !== image.data[index + 2]
    )
      throw new Error(`Atlas cell ${name} is not grayscale-alpha at pixel ${index / 4}`)
  }
}

function copyInto(
  source: RgbaImage,
  target: Uint8Array,
  targetWidth: number,
  targetX: number,
  targetY: number,
): void {
  for (let row = 0; row < source.height; row += 1) {
    target.set(
      source.data.subarray(row * source.width * 4, (row + 1) * source.width * 4),
      ((targetY + row) * targetWidth + targetX) * 4,
    )
  }
}

function validateImage(image: RgbaImage, label: string): void {
  if (!isPositiveInteger(image.width) || !isPositiveInteger(image.height))
    throw new Error(`${label} dimensions must be positive integers`)
  if (image.data.length !== image.width * image.height * 4)
    throw new Error(`${label} must contain exactly four RGBA bytes per pixel`)
}

function validateRendererPath(path: string, label: string): void {
  if (
    !isNonEmptyString(path) ||
    !path.startsWith('./') ||
    path.includes('\\') ||
    path.split('/').includes('..') ||
    path.slice(2).split('/').includes('.') ||
    path.split('/').some((part) => part.length === 0 && part !== '.')
  ) {
    throw new Error(`Atlas ${label} must be a renderer-relative POSIX path: ${path}`)
  }
}

function validateExactKeys(value: object, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} property: ${key}`)
  }
}

function validateThreshold(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 255)
    throw new Error(`${label} must be an integer from 0 to 255`)
}

function sourceSetProblem(
  missing: readonly string[],
  stray: readonly string[],
  duplicates: readonly string[],
): string {
  const problems = [
    ...(missing.length > 0 ? [`missing: ${missing.join(', ')}`] : []),
    ...(stray.length > 0 ? [`stray: ${stray.join(', ')}`] : []),
    ...(duplicates.length > 0 ? [`repeated: ${[...new Set(duplicates)].join(', ')}`] : []),
  ]
  return `Atlas sources do not match the declared cells (${problems.join('; ')})`
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}
function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}
function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}
function isFiniteNumber(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
