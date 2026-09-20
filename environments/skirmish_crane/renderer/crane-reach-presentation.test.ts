import type { StepState } from '@game-sandbox/schema'
import { Container, Text } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import tileTypes from '../tile_types.json'
import { CRANE_ASSET_MANIFEST, loadCraneAssets } from './assets.js'
import { drawHud } from './hud.js'
import {
  FEATURE_MARKS,
  gaugeFor,
  HUD_PANEL_ALPHA,
  HUD_TEXT_SIZES,
  labelRowLayout,
  presentationFor,
  TERRAIN_MARKS,
  UNIT_RADIUS_FACTORS,
} from './presentation.js'
import { CRANE_STYLE } from './scene.js'
import { armyScene, armyStates } from './test-helpers.js'
import { createUnitNode, drawUnit, unitPaletteFor } from './units.js'

describe('Crane Reach Estuary Ink presentation', () => {
  it('uses the larger round type scale and highlights both round labels together', () => {
    expect(HUD_TEXT_SIZES.roundLabel).toBe(18)
    expect(HUD_TEXT_SIZES.roundValue).toBe(36)

    const scene = armyScene(armyStates[39] as StepState)
    scene.hud.capture = null
    const paint = {
      sprite: () => null,
      text: (
        value: string,
        size: number,
        fill: string,
        align: 'left' | 'center' | 'right',
        fontFamily?: string,
      ) => new Text({ text: value, style: { fontSize: size, fill, align, fontFamily } }),
    }
    const draw = (roundHighlighted: boolean) => {
      const layer = new Container()
      drawHud(layer, paint, scene, {
        roundHighlighted,
        onInspect: () => undefined,
        pins: () => true,
        rosters: false,
      })
      const roundGroup = layer.children[0] as Container
      return [roundGroup.children[1], roundGroup.children[2]] as [Text, Text]
    }

    const normal = draw(false)
    expect(normal.map((text) => text.style.fontSize)).toEqual([18, 36])
    expect(normal.map((text) => text.style.fill)).toEqual([CRANE_STYLE.mutedText, CRANE_STYLE.text])

    const highlighted = draw(true)
    expect(highlighted.map((text) => text.style.fill)).toEqual([
      CRANE_STYLE.activation,
      CRANE_STYLE.activation,
    ])
  })

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

  it('mutes completed unit ink while keeping the hit point gauge at full bone contrast', () => {
    const ready = unitPaletteFor({ side: 'red', hasActed: false })
    const acted = unitPaletteFor({ side: 'red', hasActed: true })
    expect(ready).toEqual({
      side: CRANE_STYLE.red,
      deep: CRANE_STYLE.redDeep,
      gauge: CRANE_STYLE.text,
    })
    expect(acted).toEqual({
      side: '#814035',
      deep: '#5c2b24',
      gauge: CRANE_STYLE.text,
    })
  })

  it('draws a completion check at every level and leaves an acted figure gauge at its damage color', () => {
    const unit = {
      playerId: 'player_0',
      unitId: 'red_footman_0',
      side: 'red' as const,
      type: 'footman' as const,
      hitPoints: 6,
      hasActed: true,
      position: { x: 0, y: 0 },
      tileKey: '0,0',
    }
    for (const level of ['figure', 'token', 'compact'] as const) {
      for (const hexRadius of [1, 30]) {
        const node = createUnitNode(unit.unitId, null, () => false)
        drawUnit(node, unit, hexRadius, level, () => null)
        expect(node.root.alpha).toBe(1)
        expect(node.actedMark.visible).toBe(true)
        expect(graphicsColors(node.actedMark)).toEqual([
          colorNumber(CRANE_STYLE.shadow),
          colorNumber(CRANE_STYLE.text),
        ])
        const radius = Math.max(5, hexRadius * UNIT_RADIUS_FACTORS[level])
        expect(Math.min(...graphicsPathX(node.actedMark))).toBeGreaterThan(radius * 1.16)
        expect(graphicsColors(node.body)).toContain(colorNumber(CRANE_STYLE.hpLow))

        drawUnit(node, { ...unit, hasActed: false }, hexRadius, level, () => null)
        expect(node.actedMark.visible).toBe(false)
        node.root.destroy({ children: true })
      }
    }
  })

  it('lays out icon labels on one centerline in both directions', () => {
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
  })

  it('keeps the corner HUD field translucent', () => {
    expect(HUD_PANEL_ALPHA).toBeGreaterThan(0)
    expect(HUD_PANEL_ALPHA).toBeLessThan(1)
  })

  it('keeps one typed 31-source loading contract and makes it injectable without decoding', async () => {
    expect(CRANE_ASSET_MANIFEST.every((asset) => asset.path.endsWith('.png'))).toBe(true)
    expect(CRANE_ASSET_MANIFEST.every((asset) => asset.width > 0 && asset.height > 0)).toBe(true)
    const loaded = await loadCraneAssets(async (asset) => `stub:${asset.name}`)
    expect(loaded.paperField).toBe('stub:paperField')
    expect(loaded.figCavalry).toBe('stub:figCavalry')
  })
})

function graphicsColors(graphics: { context: unknown }): number[] {
  return (
    graphics.context as { instructions: Array<{ data: { style: { color: number } } }> }
  ).instructions.map((instruction) => instruction.data.style.color)
}

function graphicsPathX(graphics: { context: unknown }): number[] {
  const instructions = (
    graphics.context as {
      instructions: Array<{ data: { path: { instructions: Array<{ data: number[] }> } } }>
    }
  ).instructions
  return instructions.flatMap((instruction) =>
    instruction.data.path.instructions.map((path) => path.data[0] as number),
  )
}

function colorNumber(color: string): number {
  return Number.parseInt(color.slice(1), 16)
}
