const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { dirname, resolve } = require('node:path')
const { PNG } = require('pngjs')

const ROOT = resolve(__dirname, '..')
const ASSETS = resolve(ROOT, 'environments/three_branches/renderer/assets')

const OUTPUTS = {
  crateSource: resolve(ASSETS, 'source-art/scenery/marketCrate.png'),
  crateFrame: resolve(ASSETS, 'scenery/marketCrate.png'),
  scenerySource: resolve(ASSETS, 'source-art/scenery-atlas-source.png'),
  lanternSource: resolve(ASSETS, 'source-art/lantern-atlas-source.png'),
  lanternLit: resolve(ASSETS, 'lantern/lit.png'),
  lanternUnlit: resolve(ASSETS, 'lantern/unlit.png'),
  bellSourceDirectory: resolve(ASSETS, 'source-art/monuments/bell'),
  bellSource: resolve(ASSETS, 'source-art/bell-atlas-source.png'),
  monumentsSource: resolve(ASSETS, 'source-art/monuments-atlas-source.png'),
  bellFoundation: resolve(ASSETS, 'bell/foundation.png'),
  bellGantry: resolve(ASSETS, 'bell/gantry.png'),
  bellMoving: resolve(ASSETS, 'bell/moving.png'),
}

function usage() {
  return [
    'Usage: node scripts/prepare_three_branches_props.cjs',
    '  [--crate=<generated.png> [--crate-background=light-checker]]',
    '  [--lantern-lit=<generated.png> --lantern-unlit=<generated.png>]',
    '  [--recenter-lantern]',
    '  [--bell-gantry=<generated.png> --bell-moving=<generated.png>',
    '    [--bell-foundation=<generated.png>] [--bell-background=light-checker]]',
    '',
    'Provide one or more complete asset families. --recenter-lantern centers the',
    'existing loose lantern frames without rebuilding their source provenance.',
    'The script performs only reproducible raster mechanics: alpha normalization,',
    'optional light-checker extraction, transparent-bound fitting, loose-frame output,',
    'and source provenance assembly. Pack each affected atlas group afterward.',
  ].join('\n')
}

function parseArguments(arguments_) {
  const values = new Map()
  for (const argument of arguments_) {
    if (argument === '--recenter-lantern') {
      values.set('recenter-lantern', true)
      continue
    }
    const match = argument.match(/^--([^=]+)=(.+)$/)
    if (match === null) throw new Error(`Invalid argument: ${argument}\n\n${usage()}`)
    values.set(
      match[1],
      match[1] === 'crate-background' || match[1] === 'bell-background'
        ? match[2]
        : resolve(match[2]),
    )
  }

  const pathNames = [
    'crate',
    'lantern-lit',
    'lantern-unlit',
    'bell-foundation',
    'bell-gantry',
    'bell-moving',
  ]
  const knownNames = new Set([
    ...pathNames,
    'crate-background',
    'bell-background',
    'recenter-lantern',
  ])
  for (const name of values.keys()) {
    if (!knownNames.has(name)) throw new Error(`Unknown --${name}.\n\n${usage()}`)
  }

  const requireTogether = (names) => {
    const count = names.filter((name) => values.has(name)).length
    if (count !== 0 && count !== names.length) {
      throw new Error(
        `Provide ${names.map((name) => `--${name}`).join(', ')} together.\n\n${usage()}`,
      )
    }
  }
  requireTogether(['lantern-lit', 'lantern-unlit'])
  requireTogether(['bell-gantry', 'bell-moving'])
  if (values.has('bell-foundation') && !values.has('bell-gantry')) {
    throw new Error(`--bell-foundation requires --bell-gantry and --bell-moving.\n\n${usage()}`)
  }
  if (values.has('crate-background') && !values.has('crate')) {
    throw new Error(`--crate-background requires --crate.\n\n${usage()}`)
  }
  if (values.has('bell-background') && !values.has('bell-gantry')) {
    throw new Error(`--bell-background requires --bell-gantry and --bell-moving.\n\n${usage()}`)
  }
  const crateBackground = values.get('crate-background') ?? 'transparent'
  const bellBackground = values.get('bell-background') ?? 'transparent'
  for (const [name, background] of [
    ['crate', crateBackground],
    ['bell', bellBackground],
  ]) {
    if (!['transparent', 'light-checker'].includes(background)) {
      throw new Error(`--${name}-background must be transparent or light-checker.\n\n${usage()}`)
    }
  }
  if (
    !values.has('crate') &&
    !values.has('lantern-lit') &&
    !values.has('recenter-lantern') &&
    !values.has('bell-gantry')
  ) {
    throw new Error(`No asset family was provided.\n\n${usage()}`)
  }
  return {
    ...Object.fromEntries(
      pathNames.filter((name) => values.has(name)).map((name) => [name, values.get(name)]),
    ),
    crateBackground,
    bellBackground,
    recenterLantern: values.has('recenter-lantern'),
  }
}

function load(path) {
  return PNG.sync.read(readFileSync(path))
}

function save(path, image) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, PNG.sync.write(image))
}

function blank(width, height) {
  return new PNG({ width, height, colorType: 6, inputColorType: 6 })
}

function normalizeAlpha(image, { discardBelow = 8 } = {}) {
  const output = blank(image.width, image.height)
  image.data.copy(output.data)
  for (let index = 0; index < output.data.length; index += 4) {
    const alpha = output.data[index + 3]
    if (alpha <= discardBelow) {
      output.data[index] = 0
      output.data[index + 1] = 0
      output.data[index + 2] = 0
      output.data[index + 3] = 0
    } else if (alpha >= 245) {
      output.data[index + 3] = 255
    }
  }
  return output
}

function extractLightCheckerBackground(image) {
  const output = blank(image.width, image.height)
  image.data.copy(output.data)
  const visited = new Uint8Array(image.width * image.height)
  const queue = new Int32Array(image.width * image.height)
  let head = 0
  let tail = 0

  const enqueue = (x, y) => {
    const pixel = y * image.width + x
    if (visited[pixel] !== 0) return
    const index = pixel * 4
    const red = image.data[index]
    const green = image.data[index + 1]
    const blue = image.data[index + 2]
    const minimum = Math.min(red, green, blue)
    const maximum = Math.max(red, green, blue)
    if (minimum < 180 || maximum - minimum > 12) return
    visited[pixel] = 1
    queue[tail] = pixel
    tail += 1
  }

  for (let x = 0; x < image.width; x += 1) {
    enqueue(x, 0)
    enqueue(x, image.height - 1)
  }
  for (let y = 0; y < image.height; y += 1) {
    enqueue(0, y)
    enqueue(image.width - 1, y)
  }
  while (head < tail) {
    const pixel = queue[head]
    head += 1
    const x = pixel % image.width
    const y = Math.floor(pixel / image.width)
    if (x > 0) enqueue(x - 1, y)
    if (x + 1 < image.width) enqueue(x + 1, y)
    if (y > 0) enqueue(x, y - 1)
    if (y + 1 < image.height) enqueue(x, y + 1)
  }
  for (let pixel = 0; pixel < visited.length; pixel += 1) {
    if (visited[pixel] === 0) continue
    const index = pixel * 4
    output.data[index] = 0
    output.data[index + 1] = 0
    output.data[index + 2] = 0
    output.data[index + 3] = 0
  }
  return output
}

function opaqueBounds(image, threshold) {
  let left = image.width
  let top = image.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = image.data[(y * image.width + x) * 4 + 3]
      if (alpha <= threshold) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < left || bottom < top) throw new Error('Generated image has no visible pixels.')
  return { left, top, width: right - left + 1, height: bottom - top + 1 }
}

function sampleBilinear(image, x, y) {
  const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(x)))
  const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(y)))
  const x1 = Math.min(image.width - 1, x0 + 1)
  const y1 = Math.min(image.height - 1, y0 + 1)
  const xWeight = x - Math.floor(x)
  const yWeight = y - Math.floor(y)
  const samples = [
    [x0, y0, (1 - xWeight) * (1 - yWeight)],
    [x1, y0, xWeight * (1 - yWeight)],
    [x0, y1, (1 - xWeight) * yWeight],
    [x1, y1, xWeight * yWeight],
  ]
  let alpha = 0
  const premultiplied = [0, 0, 0]
  for (const [sampleX, sampleY, weight] of samples) {
    const index = (sampleY * image.width + sampleX) * 4
    const sampleAlpha = image.data[index + 3] / 255
    alpha += sampleAlpha * weight
    for (let channel = 0; channel < 3; channel += 1) {
      premultiplied[channel] += image.data[index + channel] * sampleAlpha * weight
    }
  }
  if (alpha === 0) return [0, 0, 0, 0]
  return [
    Math.round(premultiplied[0] / alpha),
    Math.round(premultiplied[1] / alpha),
    Math.round(premultiplied[2] / alpha),
    Math.round(alpha * 255),
  ]
}

function fitTransparent(image, target) {
  const bounds = opaqueBounds(image, target.boundsThreshold)
  return fitTransparentFromBounds(image, bounds, target)
}

function fitTransparentFromBounds(image, bounds, target) {
  const scale = Math.min(target.maxWidth / bounds.width, target.maxHeight / bounds.height)
  const width = Math.max(1, Math.round(bounds.width * scale))
  const height = Math.max(1, Math.round(bounds.height * scale))
  const left = Math.round(target.centerX - width / 2)
  const top = target.bottom === undefined ? Math.round(target.centerY - height / 2) : target.bottom - height
  const output = blank(target.width, target.height)

  for (let y = 0; y < height; y += 1) {
    const sourceY = bounds.top + ((y + 0.5) * bounds.height) / height - 0.5
    for (let x = 0; x < width; x += 1) {
      const sourceX = bounds.left + ((x + 0.5) * bounds.width) / width - 0.5
      const destinationX = left + x
      const destinationY = top + y
      if (
        destinationX < 0 ||
        destinationX >= output.width ||
        destinationY < 0 ||
        destinationY >= output.height
      ) {
        continue
      }
      const destination = (destinationY * output.width + destinationX) * 4
      const pixel = sampleBilinear(image, sourceX, sourceY)
      for (let channel = 0; channel < 4; channel += 1) {
        output.data[destination + channel] = pixel[channel]
      }
    }
  }
  return normalizeAlpha(output, { discardBelow: 2 })
}

function place(page, frame, left, top) {
  if (left + frame.width > page.width || top + frame.height > page.height) {
    throw new Error('Source frame does not fit its provenance page.')
  }
  PNG.bitblt(frame, page, 0, 0, frame.width, frame.height, left, top)
}

function replace(page, frame, left, top) {
  const cleared = blank(frame.width, frame.height)
  PNG.bitblt(cleared, page, 0, 0, frame.width, frame.height, left, top)
  place(page, frame, left, top)
}

function prepare() {
  const paths = parseArguments(process.argv.slice(2))
  const prepared = []
  if (paths.crate !== undefined) {
    const generatedCrate = load(paths.crate)
    if (generatedCrate.width !== 1254 || generatedCrate.height !== 1254) {
      throw new Error(
        `Crate source must be 1254 by 1254, got ${generatedCrate.width} by ${generatedCrate.height}.`,
      )
    }
    const crate = normalizeAlpha(
      paths.crateBackground === 'light-checker'
        ? extractLightCheckerBackground(generatedCrate)
        : generatedCrate,
    )
    const crateFrame = fitTransparent(crate, {
      width: 512,
      height: 512,
      maxWidth: 480,
      maxHeight: 480,
      centerX: 256,
      centerY: 256,
      boundsThreshold: 8,
    })
    save(OUTPUTS.crateSource, crate)
    save(OUTPUTS.crateFrame, crateFrame)
    const scenerySource = load(OUTPUTS.scenerySource)
    replace(scenerySource, crateFrame, 1024, 512)
    save(OUTPUTS.scenerySource, scenerySource)
    prepared.push('crate')
  }

  const lanternFrame = {
    width: 384,
    height: 512,
    maxWidth: 160,
    maxHeight: 160,
    centerX: 192,
    centerY: 256,
    boundsThreshold: 8,
  }
  if (paths['lantern-lit'] !== undefined) {
    const lanternLit = normalizeAlpha(load(paths['lantern-lit']))
    const lanternUnlit = normalizeAlpha(load(paths['lantern-unlit']), { discardBelow: 160 })
    const lanternSource = blank(2048, 1536)
    const lanternProvenanceFrame = {
      width: 1024,
      height: 1536,
      maxWidth: 992,
      maxHeight: 1400,
      centerX: 512,
      centerY: 768,
      boundsThreshold: 8,
    }
    place(lanternSource, fitTransparent(lanternLit, lanternProvenanceFrame), 0, 0)
    place(lanternSource, fitTransparent(lanternUnlit, lanternProvenanceFrame), 1024, 0)
    save(OUTPUTS.lanternSource, lanternSource)
    save(OUTPUTS.lanternLit, fitTransparent(lanternLit, lanternFrame))
    save(OUTPUTS.lanternUnlit, fitTransparent(lanternUnlit, lanternFrame))
    prepared.push('lantern')
  } else if (paths.recenterLantern) {
    const lanternLit = load(OUTPUTS.lanternLit)
    const lanternUnlit = load(OUTPUTS.lanternUnlit)
    save(OUTPUTS.lanternLit, fitTransparent(lanternLit, lanternFrame))
    save(OUTPUTS.lanternUnlit, fitTransparent(lanternUnlit, lanternFrame))
    prepared.push('lantern')
  }

  if (paths['bell-gantry'] !== undefined) {
    const bellFoundation = normalizeAlpha(
      load(paths['bell-foundation'] ?? resolve(OUTPUTS.bellSourceDirectory, 'foundation.png')),
      { discardBelow: 16 },
    )
    const normalizeBellLayer = (path) =>
      normalizeAlpha(
        paths.bellBackground === 'light-checker'
          ? extractLightCheckerBackground(load(path))
          : load(path),
        { discardBelow: 16 },
      )
    const bellGantry = normalizeBellLayer(paths['bell-gantry'])
    const bellMoving = normalizeBellLayer(paths['bell-moving'])
    for (const [name, image] of [
      ['bell foundation', bellFoundation],
      ['bell gantry', bellGantry],
      ['moving bell', bellMoving],
    ]) {
      if (image.width !== 1536 || image.height !== 1024) {
        throw new Error(`${name} source must be 1536 by 1024.`)
      }
    }
    mkdirSync(OUTPUTS.bellSourceDirectory, { recursive: true })
    for (const [name, source] of [
      ['foundation.png', bellFoundation],
      ['gantry.png', bellGantry],
      ['moving.png', bellMoving],
    ]) {
      save(resolve(OUTPUTS.bellSourceDirectory, name), source)
    }
    save(
      OUTPUTS.bellFoundation,
      fitTransparent(bellFoundation, {
        width: 1536,
        height: 1024,
        maxWidth: 768,
        maxHeight: 688,
        centerX: 768,
        centerY: 504,
        boundsThreshold: 16,
      }),
    )
    const bellFrame = {
      width: 1536,
      height: 1024,
      maxWidth: 768,
      maxHeight: 912,
      centerX: 768,
      bottom: 976,
      boundsThreshold: 16,
    }
    const gantryBounds = opaqueBounds(bellGantry, bellFrame.boundsThreshold)
    save(OUTPUTS.bellGantry, fitTransparentFromBounds(bellGantry, gantryBounds, bellFrame))
    save(OUTPUTS.bellMoving, fitTransparentFromBounds(bellMoving, gantryBounds, bellFrame))
    const bellSource = blank(4608, 1024)
    place(bellSource, bellFoundation, 0, 0)
    place(bellSource, bellGantry, 1536, 0)
    place(bellSource, bellMoving, 3072, 0)
    save(OUTPUTS.bellSource, bellSource)
    const monumentsSource = load(OUTPUTS.monumentsSource)
    for (const [left, top] of [
      [1536, 0],
      [0, 512],
      [768, 512],
      [1536, 512],
    ]) {
      replace(monumentsSource, blank(768, 512), left, top)
    }
    save(OUTPUTS.monumentsSource, monumentsSource)
    prepared.push('bell')
  }

  console.log(`Prepared Three Branches ${prepared.join(', ')} loose frames.`)
  console.log('Pack each affected atlas group with the existing atlas command.')
}

try {
  prepare()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
