const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { dirname, resolve } = require('node:path')
const { PNG } = require('pngjs')

const ROOT = resolve(__dirname, '..')
const ASSETS = resolve(ROOT, 'environments/three_branches/renderer/assets')

const OUTPUTS = {
  crateSource: resolve(ASSETS, 'source-art/scenery/marketCrate.png'),
  crateFrame: resolve(ASSETS, 'scenery/marketCrate.png'),
  lanternSource: resolve(ASSETS, 'source-art/lantern-atlas-source.png'),
  lanternLit: resolve(ASSETS, 'lantern/lit.png'),
  lanternUnlit: resolve(ASSETS, 'lantern/unlit.png'),
  bellSourceDirectory: resolve(ASSETS, 'source-art/monuments/bell'),
  bellFoundation: resolve(ASSETS, 'monuments/bell/foundation.png'),
  bellSilent: resolve(ASSETS, 'monuments/bell/silent.png'),
  bellRinging: resolve(ASSETS, 'monuments/bell/ringing.png'),
}

function usage() {
  return [
    'Usage: node scripts/prepare_three_branches_props.cjs',
    '  --crate=<generated.png>',
    '  --lantern-lit=<generated.png>',
    '  --lantern-unlit=<generated.png>',
    '  --bell-foundation=<generated.png>',
    '  --bell-silent=<generated.png>',
    '  --bell-ringing=<generated.png>',
    '',
    'The script performs only reproducible raster mechanics: alpha normalization,',
    'transparent-bound fitting, loose-frame output, and source provenance assembly.',
    'Run the existing atlas pack command afterward for lantern, monuments, and scenery.',
  ].join('\n')
}

function parseArguments(arguments_) {
  const values = new Map()
  for (const argument of arguments_) {
    const match = argument.match(/^--([^=]+)=(.+)$/)
    if (match === null) throw new Error(`Invalid argument: ${argument}\n\n${usage()}`)
    values.set(match[1], resolve(match[2]))
  }

  const names = [
    'crate',
    'lantern-lit',
    'lantern-unlit',
    'bell-foundation',
    'bell-silent',
    'bell-ringing',
  ]
  for (const name of names) {
    if (!values.has(name)) throw new Error(`Missing --${name}.\n\n${usage()}`)
  }
  return Object.fromEntries(names.map((name) => [name, values.get(name)]))
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

function prepare() {
  const paths = parseArguments(process.argv.slice(2))
  const crate = normalizeAlpha(load(paths.crate))
  const lanternLit = normalizeAlpha(load(paths['lantern-lit']))
  const lanternUnlit = normalizeAlpha(load(paths['lantern-unlit']), { discardBelow: 160 })
  const bellFoundation = normalizeAlpha(load(paths['bell-foundation']), { discardBelow: 16 })
  const bellSilent = normalizeAlpha(load(paths['bell-silent']), { discardBelow: 16 })
  const bellRinging = normalizeAlpha(load(paths['bell-ringing']), { discardBelow: 16 })

  if (crate.width !== 1254 || crate.height !== 1254) {
    throw new Error(`Crate source must be 1254 by 1254, got ${crate.width} by ${crate.height}.`)
  }
  for (const [name, image] of [
    ['bell foundation', bellFoundation],
    ['silent bell', bellSilent],
    ['ringing bell', bellRinging],
  ]) {
    if (image.width !== 1536 || image.height !== 1024) {
      throw new Error(`${name} source must be 1536 by 1024.`)
    }
  }

  save(OUTPUTS.crateSource, crate)
  save(
    OUTPUTS.crateFrame,
    fitTransparent(crate, {
      width: 512,
      height: 512,
      maxWidth: 480,
      maxHeight: 480,
      centerX: 256,
      centerY: 256,
      boundsThreshold: 8,
    }),
  )

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
  const lanternFrame = {
    width: 384,
    height: 512,
    maxWidth: 160,
    maxHeight: 160,
    centerX: 192,
    centerY: 362,
    boundsThreshold: 8,
  }
  save(OUTPUTS.lanternLit, fitTransparent(lanternLit, lanternFrame))
  save(OUTPUTS.lanternUnlit, fitTransparent(lanternUnlit, lanternFrame))

  mkdirSync(OUTPUTS.bellSourceDirectory, { recursive: true })
  for (const [name, source] of [
    ['foundation.png', bellFoundation],
    ['silent.png', bellSilent],
    ['ringing.png', bellRinging],
  ]) {
    save(resolve(OUTPUTS.bellSourceDirectory, name), source)
  }
  save(
    OUTPUTS.bellFoundation,
    fitTransparent(bellFoundation, {
      width: 768,
      height: 512,
      maxWidth: 384,
      maxHeight: 344,
      centerX: 384,
      centerY: 252,
      boundsThreshold: 16,
    }),
  )
  const bellFrame = {
    width: 768,
    height: 512,
    maxWidth: 384,
    maxHeight: 456,
    centerX: 384,
    bottom: 488,
    boundsThreshold: 16,
  }
  save(OUTPUTS.bellSilent, fitTransparent(bellSilent, bellFrame))
  save(OUTPUTS.bellRinging, fitTransparent(bellRinging, bellFrame))

  console.log('Prepared Three Branches crate, lantern, and bell loose frames.')
  console.log('Pack the lantern, monuments, and scenery atlas groups with the existing atlas command.')
}

try {
  prepare()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
