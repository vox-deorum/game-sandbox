import { describe, expect, it } from 'vitest'

import tileTypes from '../tile_types.json'
import { CRANE_ASSET_MANIFEST, craneAssetSources, loadCraneAssets } from './assets.js'
import {
  eventTextMetrics,
  FEATURE_MARKS,
  gaugeFor,
  HUD_CORNER_PANELS,
  HUD_PANEL_ALPHA,
  HUD_PANEL_RADIUS,
  HUD_TEXT_SIZES,
  labelRowLayout,
  presentationFor,
  TERRAIN_MARKS,
} from './presentation.js'
import { CRANE_STYLE } from './scene.js'

describe('Crane Reach Estuary Ink presentation', () => {
  it('marks every tile type the shared source declares', () => {
    // Grass and the empty feature draw their wash alone. Everything else earns a mark.
    for (const terrain of Object.keys(tileTypes.terrains)) {
      expect(terrain in TERRAIN_MARKS).toBe(terrain !== 'grass' && terrain !== 'void')
    }
    for (const feature of Object.keys(tileTypes.features)) {
      expect(feature in FEATURE_MARKS).toBe(feature !== 'none')
    }
    expect(FEATURE_MARKS.waste?.asset).toBe('waste')
    expect(FEATURE_MARKS.waste?.tint).toBe(CRANE_STYLE.feature.waste)
  })

  it('switches artwork at the exact CSS-radius boundaries without changing scene geometry', () => {
    expect(presentationFor(28, 1)).toBe('figure')
    expect(presentationFor(27.999, 1)).toBe('token')
    expect(presentationFor(12, 1)).toBe('token')
    expect(presentationFor(11.999, 1)).toBe('compact')
  })

  it('keeps the fitted desktop boards on tokens until the camera zooms further in', () => {
    const desktopScale = (893 / 1_200) * 1.236
    expect(presentationFor(28.522, desktopScale)).toBe('token')
    expect(presentationFor(20.5, desktopScale)).toBe('token')
    expect(presentationFor(28.522, desktopScale * 1.1)).toBe('figure')
    expect(presentationFor(20.5, desktopScale * 1.5)).toBe('figure')
  })

  it('maps maximum hit points to healthy, low, and critical gauge states at both boundaries', () => {
    expect(gaugeFor({ type: 'footman', hitPoints: 12 })).toMatchObject({
      fraction: 1,
      color: CRANE_STYLE.text,
      critical: false,
    })
    expect(gaugeFor({ type: 'footman', hitPoints: 6 })).toMatchObject({
      fraction: 0.5,
      color: CRANE_STYLE.hpLow,
      critical: false,
    })
    expect(gaugeFor({ type: 'footman', hitPoints: 3 })).toMatchObject({
      fraction: 0.25,
      color: CRANE_STYLE.danger,
      critical: true,
    })
    expect(gaugeFor({ type: 'archer', hitPoints: 2 })).toMatchObject({
      fraction: 2 / 6,
      critical: false,
    })
    expect(gaugeFor({ type: 'archer', hitPoints: 6 }).fraction).toBe(1)
    expect(gaugeFor({ type: 'cavalry', hitPoints: 10 }).fraction).toBe(1)
  })

  it('lays out icon labels on one centerline in both directions at the larger HUD scale', () => {
    const rightward = labelRowLayout(40, 100, 20, [30, 12], 1, 6)
    expect(rightward).toEqual({
      mark: { x: 40, y: 100, anchorX: 0.5, anchorY: 0.5 },
      texts: [
        { x: 56, y: 100, anchorX: 0, anchorY: 0.5 },
        { x: 92, y: 100, anchorX: 0, anchorY: 0.5 },
      ],
    })
    expect(labelRowLayout(40, 100, 20, [30, 12], -1, 6)).toEqual({
      mark: { x: 40, y: 100, anchorX: 0.5, anchorY: 0.5 },
      texts: [
        { x: 24, y: 100, anchorX: 1, anchorY: 0.5 },
        { x: -12, y: 100, anchorX: 1, anchorY: 0.5 },
      ],
    })
    expect(HUD_TEXT_SIZES).toEqual({
      roundLabel: 16,
      roundValue: 30,
      score: 26,
      scoreTarget: 20,
      cardHeading: 17,
      cardStat: 17,
      ability: 16,
    })
  })

  it('backs every corner HUD group with one consistent translucent night-ink field', () => {
    expect(HUD_CORNER_PANELS).toEqual({
      round: { x: 16, y: 16, width: 82, height: 66 },
      capture: { x: 924, y: 16, width: 260, height: 54 },
      redRoster: { x: 16, y: 772, width: 230, height: 64 },
      blueRoster: { x: 954, y: 772, width: 230, height: 64 },
    })
    expect(HUD_PANEL_ALPHA).toBeGreaterThan(0)
    expect(HUD_PANEL_ALPHA).toBeLessThan(1)
    expect(HUD_PANEL_RADIUS).toBe(8)
    expect(CRANE_STYLE.backdrop).toBe('#101816')
  })

  it('keeps transient event text at a legible CSS size on the narrowest viewport', () => {
    const compactMetrics = eventTextMetrics(390 / 1_200)
    expect(compactMetrics.size * (390 / 1_200)).toBeCloseTo(12)
    expect(compactMetrics.rise * (390 / 1_200)).toBeCloseTo(12)
  })

  it('keeps one typed 30-source loading contract and makes it injectable without decoding', async () => {
    expect(CRANE_ASSET_MANIFEST).toHaveLength(30)
    expect(CRANE_ASSET_MANIFEST.every((asset) => asset.path.endsWith('.png'))).toBe(true)
    expect(CRANE_ASSET_MANIFEST.every((asset) => asset.width > 0 && asset.height > 0)).toBe(true)
    expect(Object.keys(craneAssetSources())).toHaveLength(30)
    const loaded = await loadCraneAssets(async (asset) => `stub:${asset.name}`)
    expect(loaded.paperField).toBe('stub:paperField')
    expect(loaded.figCavalry).toBe('stub:figCavalry')
  })
})
