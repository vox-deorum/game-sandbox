import { type ColorMatrix, ColorMatrixFilter } from 'pixi.js'

import type { ColorGradeTreatment, HearthsidePalette } from '../core/presentation.js'

const LUMINANCE_RED = 0.2126
const LUMINANCE_GREEN = 0.7152
const LUMINANCE_BLUE = 0.0722

/**
 * Compose one grade into a row-major five-by-four Pixi matrix. Reading a sampled channel as `c`,
 * the treatment applies saturation around luminance, contrast around mid grey, brightness, then the
 * tint mix, and this matrix is that composition folded into a single affine step. Results are left
 * unclamped: the framebuffer performs the final channel clamp, and the alpha row is the identity so
 * transparent apertures survive the pass untouched.
 */
export function composeColorGradeMatrix(
  treatment: ColorGradeTreatment,
  palette: HearthsidePalette,
): ColorMatrix {
  const tint = rgb(palette[treatment.tint])
  const desaturation = 1 - treatment.saturation
  const scale = (1 - treatment.tintMix) * treatment.brightness * treatment.contrast
  const offset = (1 - treatment.tintMix) * treatment.brightness * 0.5 * (1 - treatment.contrast)

  return [
    scale * (treatment.saturation + desaturation * LUMINANCE_RED),
    scale * desaturation * LUMINANCE_GREEN,
    scale * desaturation * LUMINANCE_BLUE,
    0,
    offset + treatment.tintMix * tint.red,
    scale * desaturation * LUMINANCE_RED,
    scale * (treatment.saturation + desaturation * LUMINANCE_GREEN),
    scale * desaturation * LUMINANCE_BLUE,
    0,
    offset + treatment.tintMix * tint.green,
    scale * desaturation * LUMINANCE_RED,
    scale * desaturation * LUMINANCE_GREEN,
    scale * (treatment.saturation + desaturation * LUMINANCE_BLUE),
    0,
    offset + treatment.tintMix * tint.blue,
    0,
    0,
    0,
    1,
    0,
  ] as ColorMatrix
}

/**
 * Create one retained grade filter. Both world grades use the same options: they inherit the render
 * target's resolution and antialiasing, add no padding, and clip to the viewport so a filter pass
 * costs one screen-sized texture however far the camera is zoomed in.
 */
export function createGradeFilter(
  treatment: ColorGradeTreatment,
  palette: HearthsidePalette,
): ColorMatrixFilter {
  const filter = new ColorMatrixFilter({
    resolution: 'inherit',
    antialias: 'inherit',
    padding: 0,
    clipToViewport: true,
  })
  filter.matrix = composeColorGradeMatrix(treatment, palette)
  return filter
}

function rgb(hex: string): { red: number; green: number; blue: number } {
  return {
    red: Number.parseInt(hex.slice(1, 3), 16) / 255,
    green: Number.parseInt(hex.slice(3, 5), 16) / 255,
    blue: Number.parseInt(hex.slice(5, 7), 16) / 255,
  }
}
