/**
 * The information layer over the board: the round counter, the capture strip, the two rosters, and
 * the inspection cards.
 *
 * All of it is drawn in scene coordinates and scales with the canvas, so the layout constants here
 * are positions on the 1200 by 860 field rather than CSS pixels. Content comes from the scene's
 * `hud` model and from `unitCardFor`, never from renderer history.
 */
import { Container, Graphics } from 'pixi.js'

import type { CraneAssetName } from './assets.js'
import { LATO, MONO, type SpriteFactory, type TextFactory } from './draw.js'
import type { InspectionEvent, InspectionTarget, RosterInspectionTarget } from './inspection.js'
import { HUD_TEXT_SIZES, labelRowLayout } from './presentation.js'
import {
  CRANE_STYLE,
  type CraneReachScene,
  SCENE_WIDTH,
  type SceneUnit,
  unitCardFor,
} from './scene.js'
import { glyphAsset } from './units.js'

/** The two builders the renderer class owns, since they need its textures and device resolution. */
export interface HudPaint {
  sprite: SpriteFactory
  text: TextFactory
}

/** Pointer wiring for the roster hit areas, which are inspectable the way board units are. */
export interface HudInspectionHooks {
  onInspect: (event: InspectionEvent) => void
  pins: (pointerType: string) => boolean
}

const ROSTER_TYPES: SceneUnit['type'][] = ['footman', 'archer', 'cavalry']

/** Draw the whole HUD for a scene. */
export function drawHud(
  layer: Container,
  paint: HudPaint,
  scene: CraneReachScene,
  hooks: HudInspectionHooks,
): void {
  const roundLabel = paint.text(
    'ROUND',
    HUD_TEXT_SIZES.roundLabel,
    CRANE_STYLE.mutedText,
    'left',
    LATO,
  )
  const round = paint.text(
    String(scene.hud.round),
    HUD_TEXT_SIZES.roundValue,
    CRANE_STYLE.text,
    'left',
    MONO,
  )
  roundLabel.position.set(28, 28)
  round.position.set(28, 43)
  layer.addChild(roundLabel, round)
  if (scene.hud.capture !== null) drawCaptureStrip(layer, paint, scene.hud.capture)
  drawRoster(layer, paint, scene, 'red', hooks)
  drawRoster(layer, paint, scene, 'blue', hooks)
}

/** Both capture scores and the target they race to, in the top right. */
function drawCaptureStrip(
  layer: Container,
  paint: HudPaint,
  capture: { red: number; blue: number; target: number },
): void {
  const group = new Container()
  const entries = [
    { side: 'red' as const, value: capture.red, x: SCENE_WIDTH - 258 },
    { side: 'blue' as const, value: capture.blue, x: SCENE_WIDTH - 150 },
  ]
  for (const entry of entries) {
    drawLabelRow(group, paint, {
      markX: entry.x,
      centerY: 43,
      mark: {
        kind: 'dot',
        diameter: 18,
        color: entry.side === 'red' ? CRANE_STYLE.red : CRANE_STYLE.blue,
      },
      texts: [
        {
          value: String(entry.value),
          size: HUD_TEXT_SIZES.score,
          fill: CRANE_STYLE.text,
          fontFamily: MONO,
        },
      ],
      gap: 7,
    })
  }
  const target = paint.text(
    `/ ${capture.target}`,
    HUD_TEXT_SIZES.scoreTarget,
    CRANE_STYLE.mutedText,
    'left',
    MONO,
  )
  target.anchor.set(0, 0.5)
  target.position.set(SCENE_WIDTH - 83, 43)
  group.addChild(target)
  layer.addChild(group)
}

/** One side's surviving count per unit type, reading outward from that side's corner. */
function drawRoster(
  layer: Container,
  paint: HudPaint,
  scene: CraneReachScene,
  side: 'red' | 'blue',
  hooks: HudInspectionHooks,
): void {
  const direction = side === 'red' ? 1 : -1
  const start = side === 'red' ? 28 : SCENE_WIDTH - 28
  for (const [index, type] of ROSTER_TYPES.entries()) {
    const x = start + direction * index * 78
    const pair = new Container()
    drawLabelRow(pair, paint, {
      markX: x + direction * 14,
      centerY: 804,
      direction,
      mark: {
        kind: 'asset',
        name: glyphAsset(type),
        width: 30,
        height: 30,
        tint: side === 'red' ? CRANE_STYLE.red : CRANE_STYLE.blue,
      },
      texts: [
        {
          value: String(scene.hud.rosters[side][type]),
          size: HUD_TEXT_SIZES.score,
          fill: CRANE_STYLE.text,
          fontFamily: MONO,
        },
      ],
      gap: 4,
    })
    if (scene.hud.terminal === null) {
      // An invisible rectangle over the icon and its count, so the whole pair is one hover target.
      const hit = new Graphics()
      const hitX = direction === 1 ? x - 4 : x - 64
      hit.roundRect(hitX, 780, 68, 48, 6).fill({ color: CRANE_STYLE.board, alpha: 0.001 })
      hit.eventMode = 'static'
      hit.cursor = 'pointer'
      hit.on('pointerover', () => {
        hooks.onInspect({ type: 'hover-roster', target: { kind: 'roster', side, type } })
      })
      hit.on('pointerout', () => hooks.onInspect({ type: 'hover-roster', target: null }))
      hit.on('pointertap', (event) => {
        event.stopPropagation()
        if (!hooks.pins(event.pointerType)) return
        hooks.onInspect({ type: 'inspect', target: { kind: 'roster', side, type } })
      })
      pair.addChild(hit)
    }
    layer.addChild(pair)
  }
}

/**
 * Draw the card for whatever is being inspected, and return its field list for the browser probe.
 * Returns null when nothing is inspected or the inspected unit has left the scene.
 */
export function drawInspectionCard(
  layer: Container,
  paint: HudPaint,
  scene: CraneReachScene,
  target: InspectionTarget,
): string | null {
  if (target?.kind === 'unit') {
    const unit = scene.units.find((candidate) => candidate.unitId === target.unitId)
    if (unit === undefined) return null
    // The card sits beside the unit, pushed back inside the field near the edges.
    const x = Math.min(SCENE_WIDTH - 254, Math.max(18, unit.position.x + scene.hexRadius * 0.75))
    const y = Math.min(670, Math.max(106, unit.position.y - scene.hexRadius * 1.2))
    return drawCard(layer, paint, {
      x,
      y,
      title: unit.unitId,
      titleFont: MONO,
      type: unit.type,
      currentHitPoints: unit.hitPoints,
      abilities: scene.hud.unitAbilities,
    })
  }
  if (target?.kind === 'roster') {
    return drawRosterCard(layer, paint, scene, target)
  }
  return null
}

function drawRosterCard(
  layer: Container,
  paint: HudPaint,
  scene: CraneReachScene,
  target: RosterInspectionTarget,
): string {
  const x = target.side === 'red' ? 28 : SCENE_WIDTH - 254
  return drawCard(layer, paint, {
    x,
    y: 656,
    title: target.type.toUpperCase(),
    titleFont: LATO,
    type: target.type,
    currentHitPoints: null,
    abilities: scene.hud.unitAbilities,
  })
}

interface CardOptions {
  x: number
  y: number
  title: string
  titleFont: string
  type: SceneUnit['type']
  currentHitPoints: number | null
  abilities: boolean
}

/** A parchment chip with a heading, the icon-led stats in two columns, and any ability line. */
function drawCard(layer: Container, paint: HudPaint, options: CardOptions): string {
  const { x, y } = options
  const specification = unitCardFor(options.type, options.currentHitPoints, options.abilities)
  const height = specification.ability !== null ? 150 : 128
  const card = new Container()
  const parchment = new Graphics()
  parchment
    .roundRect(x, y, 244, height, 7)
    .fill({ color: CRANE_STYLE.board, alpha: 0.97 })
    .stroke({ color: CRANE_STYLE.grid, width: 2, alpha: 0.85 })
  card.addChild(parchment)
  const heading = paint.text(
    options.title,
    HUD_TEXT_SIZES.cardHeading,
    CRANE_STYLE.shadow,
    'left',
    options.titleFont,
  )
  heading.position.set(x + 14, y + 12)
  card.addChild(heading)
  for (const [index, field] of specification.fields.entries()) {
    const column = index % 2
    const row = Math.floor(index / 2)
    drawStat(
      card,
      paint,
      field.icon,
      field.label,
      field.value,
      x + 14 + column * 112,
      y + 47 + row * 28,
    )
  }
  if (specification.ability !== null) {
    const ability = paint.text(
      specification.ability,
      HUD_TEXT_SIZES.ability,
      CRANE_STYLE.grid,
      'left',
      LATO,
    )
    ability.anchor.set(0, 0.5)
    ability.position.set(x + 14, y + 130)
    card.addChild(ability)
  }
  card.eventMode = 'none'
  layer.addChild(card)
  return specification.fields.map((field) => `${field.icon}:${field.label}`).join(',')
}

/** One stat line: icon, label at a fixed column width, then the value. */
function drawStat(
  card: Container,
  paint: HudPaint,
  icon: CraneAssetName,
  label: string,
  value: string,
  x: number,
  y: number,
): void {
  drawLabelRow(card, paint, {
    markX: x + 9,
    centerY: y,
    mark: { kind: 'asset', name: icon, width: 19, height: 19, tint: CRANE_STYLE.grid },
    texts: [
      {
        value: label,
        size: HUD_TEXT_SIZES.cardStat,
        fill: CRANE_STYLE.grid,
        fontFamily: LATO,
        layoutWidth: 40,
      },
      {
        value,
        size: HUD_TEXT_SIZES.cardStat,
        fill: CRANE_STYLE.shadow,
        fontFamily: MONO,
      },
    ],
    gap: 4,
  })
}

interface LabelRowText {
  value: string
  size: number
  fill: string
  fontFamily: string
  /** Reserve a fixed slot instead of measuring, so a column of stats lines up. */
  layoutWidth?: number
}

type LabelRowMark =
  | { kind: 'asset'; name: CraneAssetName; width: number; height: number; tint?: string }
  | { kind: 'dot'; diameter: number; color: string }

interface LabelRowOptions {
  markX: number
  centerY: number
  mark: LabelRowMark
  texts: readonly LabelRowText[]
  direction?: 1 | -1
  gap?: number
}

/** Place an icon or dot and its texts along one centerline, per `labelRowLayout`. */
function drawLabelRow(parent: Container, paint: HudPaint, options: LabelRowOptions): void {
  const direction = options.direction ?? 1
  const texts = options.texts.map((item) =>
    paint.text(
      item.value,
      item.size,
      item.fill,
      direction === 1 ? 'left' : 'right',
      item.fontFamily,
    ),
  )
  const markWidth = options.mark.kind === 'asset' ? options.mark.width : options.mark.diameter
  const layout = labelRowLayout(
    options.markX,
    options.centerY,
    markWidth,
    texts.map((text, index) => options.texts[index]?.layoutWidth ?? text.width),
    direction,
    options.gap,
  )
  if (options.mark.kind === 'asset') {
    const mark = paint.sprite(
      options.mark.name,
      layout.mark.x,
      layout.mark.y,
      options.mark.width,
      options.mark.height,
    )
    if (mark !== null) {
      if (options.mark.tint !== undefined) mark.tint = options.mark.tint
      parent.addChild(mark)
    }
  } else {
    const mark = new Graphics()
    mark.circle(layout.mark.x, layout.mark.y, options.mark.diameter / 2).fill(options.mark.color)
    parent.addChild(mark)
  }
  for (const [index, text] of texts.entries()) {
    const position = layout.texts[index]
    if (position === undefined) continue
    text.anchor.set(position.anchorX, position.anchorY)
    text.position.set(position.x, position.y)
    parent.addChild(text)
  }
}
