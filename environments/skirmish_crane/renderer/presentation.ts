/**
 * How Crane Reach looks at a given size. Everything here is a pure table or a small piece of layout
 * math: the presentation thresholds, the terrain and feature marks, the hit point gauge states, and
 * the HUD type scale. Tuning the board's appearance starts in this file and in `CRANE_STYLE`.
 */
import type { CraneAssetName } from './assets.js'
import {
  CRANE_STYLE,
  type FeatureName,
  type SceneUnit,
  type TerrainName,
  UNIT_STATS,
} from './scene.js'

/** One type scale keeps the HUD and inspection cards legible at the renderer's common display sizes. */
export const HUD_TEXT_SIZES = {
  roundLabel: 16,
  roundValue: 30,
  score: 26,
  scoreTarget: 20,
  cardHeading: 17,
  cardStat: 17,
  ability: 16,
} as const

export interface LabelRowItemLayout {
  x: number
  y: number
  anchorX: 0 | 0.5 | 1
  anchorY: 0.5
}

export interface LabelRowLayout {
  mark: LabelRowItemLayout
  texts: LabelRowItemLayout[]
}

/** Lay out an icon and its text on one centerline, in either reading direction. */
export function labelRowLayout(
  markX: number,
  centerY: number,
  markWidth: number,
  textWidths: readonly number[],
  direction: 1 | -1 = 1,
  gap = 6,
): LabelRowLayout {
  let cursor = markX + direction * (markWidth / 2 + gap)
  const anchorX = direction === 1 ? 0 : 1
  const texts = textWidths.map((width) => {
    const item = { x: cursor, y: centerY, anchorX, anchorY: 0.5 } as const
    cursor += direction * (width + gap)
    return item
  })
  return {
    mark: { x: markX, y: centerY, anchorX: 0.5, anchorY: 0.5 },
    texts,
  }
}

/** How one tile mark is drawn. ``alternate`` gives a mark its scattered second tuft. */
export interface MarkSpec {
  asset: CraneAssetName
  alternate?: CraneAssetName
  tint: string
  alpha: number
  shape: 'square' | 'wide' | 'tuft' | 'canopy'
}

/** A tile type earns its mark by appearing here. Anything absent draws its wash alone. */
export const TERRAIN_MARKS: Partial<Record<TerrainName, MarkSpec>> = {
  hill: { asset: 'contour', tint: '#8f7550', alpha: 0.88, shape: 'square' },
  water: { asset: 'ripple', tint: CRANE_STYLE.void, alpha: 0.58, shape: 'wide' },
}

export const FEATURE_MARKS: Partial<Record<FeatureName, MarkSpec>> = {
  forest: { asset: 'canopy', tint: CRANE_STYLE.feature.forest, alpha: 0.88, shape: 'canopy' },
  marsh: {
    asset: 'sedgeA',
    alternate: 'sedgeB',
    tint: CRANE_STYLE.feature.marsh,
    alpha: 0.88,
    shape: 'tuft',
  },
  waste: { asset: 'waste', tint: CRANE_STYLE.feature.waste, alpha: 0.88, shape: 'square' },
}

export type PresentationLevel = 'figure' | 'token' | 'compact'

/** Choose artwork from the actual CSS size, not logical battlefield geometry. */
export function presentationFor(hexRadius: number, displayScale: number): PresentationLevel {
  const effectiveHexRadius = hexRadius * displayScale
  return effectiveHexRadius >= 18 ? 'figure' : effectiveHexRadius >= 12 ? 'token' : 'compact'
}

/**
 * The unit radius each level works from, as a fraction of the hex radius. It is not the size of the
 * artwork: a token is a disc of exactly this radius, while a figure is drawn at a little over twice
 * it and stands on a base plate this wide.
 */
export const UNIT_RADIUS_FACTORS: Record<PresentationLevel, number> = {
  figure: 0.55,
  token: 0.62,
  compact: 0.36,
}

/** Keep transient event labels and their rise legible in CSS pixels at every presentation level. */
export function eventTextMetrics(displayScale: number): { size: number; rise: number } {
  const scale = Math.max(0.01, displayScale)
  return { size: Math.max(16, 12 / scale), rise: 12 / scale }
}

export interface GaugeState {
  fraction: number
  color: string
  critical: boolean
}

/** The rim is a state gauge. The exact hit point numeral belongs to the step 4.2 hover chip. */
export function gaugeFor(unit: Pick<SceneUnit, 'type' | 'hitPoints'>): GaugeState {
  const fraction = Math.max(0, Math.min(1, unit.hitPoints / UNIT_STATS[unit.type].hitPoints))
  return {
    fraction,
    color:
      fraction <= 0.25
        ? CRANE_STYLE.danger
        : fraction <= 0.5
          ? CRANE_STYLE.hpLow
          : CRANE_STYLE.text,
    critical: fraction <= 0.25,
  }
}
