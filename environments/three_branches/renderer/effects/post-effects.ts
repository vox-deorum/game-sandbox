import { clamp, interpolateDegrees, lerp } from '@renderers/base/math.js'
import { type ColorMatrix, ColorMatrixFilter, Texture } from 'pixi.js'

import { type DayCycleKeyframe, HEARTHSIDE_STYLE } from '../core/presentation.js'
import type { FrameScene } from '../core/types.js'
import { RULES } from '../ui/overlay.js'

const LUMINANCE_RED = 0.2126
const LUMINANCE_GREEN = 0.7152
const LUMINANCE_BLUE = 0.0722
const IDENTITY_TOLERANCE = 1e-6

type Rgb = readonly [number, number, number]

/** The resolved look of one presented instant, blended from the day-cycle keyframes. */
export interface DayLight {
  exposure: number
  contrast: number
  saturation: number
  /** Per-channel multiplicative gain from the coloured light. */
  gain: Rgb
  /** Haze colour already multiplied by its mix, so blending stays linear. */
  haze: Rgb
  hazeMix: number
  glow: number
  shadow: DayShadow
  vignette: number
  clouds: number
  cranes: number
}

/** The character drop shadow at one instant. */
export interface DayShadow {
  /** Screen direction the shadow points, in degrees clockwise from east (north is up). */
  angleDegrees: number
  /** Offset of the shadow's far end in cells. */
  length: number
  alpha: number
}

interface Keyframe {
  tick: number
  light: DayLight
}

/** Keyframes resolved once, each sitting at the midpoint tick of its rules phase. */
const KEYFRAMES: readonly Keyframe[] = RULES.phases.map((phase) => {
  const keyframe = HEARTHSIDE_STYLE.postEffects.dayCycle[phase.name]
  if (keyframe === undefined) throw new Error(`Day cycle keyframe is missing: ${phase.name}`)
  return { tick: (phase.start + phase.end) / 2, light: resolveKeyframe(keyframe) }
})
const MIDDAY = requiredKeyframe('midday')
const CYCLE_PHASES = new Set(RULES.phases.map((phase) => phase.name))

/**
 * The look of the world at a presented tick. While the day cycle runs (the phase is a rules
 * phase), adjacent keyframes blend with a smoothstep between their midpoint ticks, and the first
 * and last keyframes hold beyond them. The off phase, the tickless opening, and anything unknown
 * render as midday, whose grade is the identity. The result depends only on its inputs, so seeks,
 * replays, and live play all present the same light for the same tick.
 */
export function dayLightAt(phase: string | null | undefined, tick: number): DayLight {
  if (phase === null || phase === undefined || !CYCLE_PHASES.has(phase)) return MIDDAY
  const first = KEYFRAMES[0]
  const last = KEYFRAMES[KEYFRAMES.length - 1]
  if (first === undefined || last === undefined) return MIDDAY
  if (tick <= first.tick) return first.light
  if (tick >= last.tick) return last.light
  for (let index = 1; index < KEYFRAMES.length; index += 1) {
    const to = KEYFRAMES[index]
    const from = KEYFRAMES[index - 1]
    if (to === undefined || from === undefined || tick > to.tick) continue
    if (tick === to.tick) return to.light
    const linear = (tick - from.tick) / (to.tick - from.tick)
    return blendLight(from.light, to.light, linear * linear * (3 - 2 * linear))
  }
  return last.light
}

/**
 * Whether a new tick moves the drifting clouds or the flying cranes. Like a sustained prop effect,
 * such a tick deserves a glide even when no character moves, so the sky never steps a tick at a
 * time. At night both are gone, and a still village rests between ticks.
 */
export function hasAmbientTransition(from: FrameScene, to: FrameScene): boolean {
  if (from.presentationTick === to.presentationTick) return false
  return [from, to].some((scene) => {
    const light = dayLightAt(scene.dynamic?.phase, scene.presentationTick)
    return light.clouds > 0 || light.cranes > 0
  })
}

/**
 * Fold the day light into one row-major five-by-four Pixi colour matrix. Reading a sampled
 * channel as `c`, it applies saturation around luminance, contrast around mid grey, exposure, the
 * coloured light's per-channel gain, then the haze mix, all as one affine step. The gain keeps the
 * ink's value structure where a flat tint mix would read as fog. Results are left unclamped (the
 * framebuffer clamps), and the alpha row is the identity so transparent apertures survive.
 */
export function gradeMatrix(light: DayLight): ColorMatrix {
  const desaturation = 1 - light.saturation
  const luminance = [
    desaturation * LUMINANCE_RED,
    desaturation * LUMINANCE_GREEN,
    desaturation * LUMINANCE_BLUE,
  ] as const
  const matrix: number[] = []
  for (const channel of [0, 1, 2] as const) {
    const scale = (1 - light.hazeMix) * light.gain[channel] * light.exposure
    const row = luminance.map(
      (weight, column) =>
        scale * light.contrast * (weight + (column === channel ? light.saturation : 0)),
    )
    const offset = scale * 0.5 * (1 - light.contrast) + light.haze[channel]
    matrix.push(...row, 0, offset)
  }
  matrix.push(0, 0, 0, 1, 0)
  return matrix as ColorMatrix
}

/** Whether a colour matrix leaves every pixel unchanged, so its pass can be skipped entirely. */
export function isIdentityMatrix(matrix: ColorMatrix): boolean {
  return matrix.every(
    (value, index) =>
      Math.abs(value - (index % 6 === 0 && index < 19 ? 1 : 0)) < IDENTITY_TOLERANCE,
  )
}

/**
 * Create the retained grade filter. It inherits the render target's resolution and antialiasing,
 * adds no padding, and clips to the viewport so the pass costs one screen-sized texture however
 * far the camera is zoomed in.
 */
export function createGradeFilter(): ColorMatrixFilter {
  return new ColorMatrixFilter({
    resolution: 'inherit',
    antialias: 'inherit',
    padding: 0,
    clipToViewport: true,
  })
}

/**
 * A soft radial edge darkening in the backdrop colour, clear across the middle. It is stretched
 * over the content area and faded by the day light's vignette strength.
 */
export function vignetteTexture(): Texture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('A 2D canvas is required for the Three Branches vignette.')
  const [red, green, blue] = rgb(HEARTHSIDE_STYLE.palette.backdrop).map((value) =>
    Math.round(value * 255),
  )
  const colour = (alpha: number): string => `rgba(${red}, ${green}, ${blue}, ${alpha})`
  const gradient = context.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.28,
    size / 2,
    size / 2,
    size * 0.72,
  )
  gradient.addColorStop(0, colour(0))
  gradient.addColorStop(0.55, colour(0.35))
  gradient.addColorStop(1, colour(1))
  context.fillStyle = gradient
  context.fillRect(0, 0, size, size)
  return Texture.from(canvas)
}

/**
 * A seamless soft cloud-shadow mask: white with alpha from wrapped value noise, so a tint gives it
 * colour. A fixed seed keeps it identical on every mount, and three low octaves keep the patches
 * broad and their edges soft without a blur pass.
 */
export function cloudTexture(): Texture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('A 2D canvas is required for the Three Branches clouds.')
  const image = context.createImageData(size, size)
  const octaves = [
    { cells: 3, weight: 0.6 },
    { cells: 6, weight: 0.28 },
    { cells: 12, weight: 0.12 },
  ].map((octave, index) => ({ ...octave, lattice: noiseLattice(octave.cells, 0x7a3c + index) }))
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let value = 0
      for (const octave of octaves) {
        value += octave.weight * wrappedNoise(octave.lattice, octave.cells, x / size, y / size)
      }
      const cover = clamp((value - 0.46) / 0.22, 0, 1)
      const offset = (y * size + x) * 4
      image.data[offset] = 255
      image.data[offset + 1] = 255
      image.data[offset + 2] = 255
      image.data[offset + 3] = Math.round(cover * cover * (3 - 2 * cover) * 255)
    }
  }
  context.putImageData(image, 0, 0)
  return Texture.from(canvas)
}

function noiseLattice(cells: number, seed: number): Float32Array {
  const lattice = new Float32Array(cells * cells)
  let state = seed
  for (let index = 0; index < lattice.length; index += 1) {
    // A small linear congruential sequence is enough for a fixed decorative pattern.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    lattice[index] = state / 0x100000000
  }
  return lattice
}

function wrappedNoise(lattice: Float32Array, cells: number, u: number, v: number): number {
  const x = u * cells
  const y = v * cells
  const column = Math.floor(x)
  const row = Math.floor(y)
  const at = (c: number, r: number): number =>
    lattice[((r + cells) % cells) * cells + ((c + cells) % cells)] ?? 0
  const smooth = (t: number): number => t * t * (3 - 2 * t)
  const tx = smooth(x - column)
  const ty = smooth(y - row)
  return lerp(
    lerp(at(column, row), at(column + 1, row), tx),
    lerp(at(column, row + 1), at(column + 1, row + 1), tx),
    ty,
  )
}

function resolveKeyframe(keyframe: DayCycleKeyframe): DayLight {
  const palette = HEARTHSIDE_STYLE.palette
  const tint = rgb(palette[keyframe.light.tint])
  const brightest = Math.max(...tint, IDENTITY_TOLERANCE)
  const haze = rgb(palette[keyframe.haze.tint])
  return {
    exposure: keyframe.exposure,
    contrast: keyframe.contrast,
    saturation: keyframe.saturation,
    gain: tint.map((value) =>
      lerp(1, value / brightest, keyframe.light.strength),
    ) as unknown as Rgb,
    haze: haze.map((value) => value * keyframe.haze.mix) as unknown as Rgb,
    hazeMix: keyframe.haze.mix,
    glow: keyframe.glow,
    shadow: { ...keyframe.shadow },
    vignette: keyframe.vignette,
    clouds: keyframe.clouds,
    cranes: keyframe.cranes,
  }
}

function blendLight(from: DayLight, to: DayLight, amount: number): DayLight {
  const mix = (a: number, b: number): number => lerp(a, b, amount)
  const mixRgb = (a: Rgb, b: Rgb): Rgb => [mix(a[0], b[0]), mix(a[1], b[1]), mix(a[2], b[2])]
  return {
    exposure: mix(from.exposure, to.exposure),
    contrast: mix(from.contrast, to.contrast),
    saturation: mix(from.saturation, to.saturation),
    gain: mixRgb(from.gain, to.gain),
    haze: mixRgb(from.haze, to.haze),
    hazeMix: mix(from.hazeMix, to.hazeMix),
    glow: mix(from.glow, to.glow),
    shadow: {
      angleDegrees: interpolateDegrees(from.shadow.angleDegrees, to.shadow.angleDegrees, amount),
      length: mix(from.shadow.length, to.shadow.length),
      alpha: mix(from.shadow.alpha, to.shadow.alpha),
    },
    vignette: mix(from.vignette, to.vignette),
    clouds: mix(from.clouds, to.clouds),
    cranes: mix(from.cranes, to.cranes),
  }
}

function requiredKeyframe(phase: string): DayLight {
  const keyframe = HEARTHSIDE_STYLE.postEffects.dayCycle[phase]
  if (keyframe === undefined) throw new Error(`Day cycle keyframe is missing: ${phase}`)
  return resolveKeyframe(keyframe)
}

function rgb(hex: string): Rgb {
  return [
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  ]
}
