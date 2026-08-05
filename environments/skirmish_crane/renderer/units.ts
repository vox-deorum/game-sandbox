/**
 * Units on the board, at all three presentation levels.
 *
 * A unit is one reusable node of Pixi objects that gets redrawn in place as the scene changes. What
 * it draws depends on how large a hex actually is on screen: a Sengoku figure, a lacquered token
 * with a weapon mon, or a shape-coded ink marker. Hit points are never a number here. They are the
 * lit portion of the border, whichever border the level uses, so a glance reads the whole board.
 *
 * Each level falls back to drawn vector art when the artwork has not finished loading.
 */
import { Container, Graphics, Sprite, type Texture } from 'pixi.js'

import type { CraneAssetName } from './assets.js'
import type { InspectionEvent } from './inspection.js'
import {
  type GaugeState,
  gaugeFor,
  type PresentationLevel,
  UNIT_RADIUS_FACTORS,
} from './presentation.js'
import { CRANE_STYLE, type SceneUnit } from './scene.js'

export interface UnitNode {
  root: Container
  unitId: string
  shadowArt: Sprite
  shadow: Graphics
  body: Graphics
  artEdge: Sprite
  art: Sprite
}

/** Overrides the side colors, which the death dissolve uses to redraw a unit in dilute ink. */
export interface UnitPalette {
  side: string
  deep: string
  gauge: string
}

/** Build a unit's reusable node. Only board units are inspectable; the death ghost is not. */
export function createUnitNode(
  unitId: string,
  onInspect: ((event: InspectionEvent) => void) | null,
  pins: (pointerType: string) => boolean,
): UnitNode {
  const root = new Container()
  if (onInspect !== null) {
    root.eventMode = 'static'
    root.cursor = 'pointer'
    root.on('pointerover', () => onInspect({ type: 'hover-unit', unitId }))
    root.on('pointerout', () => onInspect({ type: 'hover-unit', unitId: null }))
    root.on('pointertap', (event) => {
      event.stopPropagation()
      if (!pins(event.pointerType)) return
      onInspect({ type: 'inspect', target: { kind: 'unit', unitId } })
    })
  }
  const shadowArt = new Sprite()
  shadowArt.anchor.set(0.5)
  const shadow = new Graphics()
  const body = new Graphics()
  const artEdge = new Sprite()
  artEdge.anchor.set(0.5)
  const art = new Sprite()
  art.anchor.set(0.5)
  root.addChild(shadowArt, shadow, body, artEdge, art)
  return { root, unitId, shadowArt, shadow, body, artEdge, art }
}

/** Redraw a unit node for the current scene at the given presentation level. */
export function drawUnit(
  node: UnitNode,
  unit: SceneUnit,
  hexRadius: number,
  level: PresentationLevel,
  textureFor: (name: CraneAssetName) => Texture | null,
  palette?: UnitPalette,
): void {
  const side = palette?.side ?? (unit.side === 'red' ? CRANE_STYLE.red : CRANE_STYLE.blue)
  const deep = palette?.deep ?? (unit.side === 'red' ? CRANE_STYLE.redDeep : CRANE_STYLE.blueDeep)
  const radius = Math.max(5, hexRadius * UNIT_RADIUS_FACTORS[level])
  const unitGauge = gaugeFor(unit)
  const gauge = palette === undefined ? unitGauge : { ...unitGauge, color: palette.gauge }
  node.root.position.set(unit.position.x, unit.position.y)
  node.root.visible = true
  node.root.alpha = 1
  node.root.rotation = 0
  const shadowTexture = textureFor('shadowOval')
  node.shadowArt.visible = shadowTexture !== null
  if (shadowTexture !== null) {
    node.shadowArt.texture = shadowTexture
    node.shadowArt.width = radius * 1.4
    node.shadowArt.height = radius * 0.5
    node.shadowArt.position.set(0, radius * 0.32)
    node.shadowArt.tint = CRANE_STYLE.shadow
    node.shadowArt.alpha = 0.35
    node.shadow.clear()
  } else {
    node.shadow
      .clear()
      .ellipse(0, radius * 0.32, radius * 0.9, radius * 0.3)
      .fill({ color: CRANE_STYLE.shadow, alpha: 0.35 })
  }
  node.body.clear()
  node.artEdge.visible = false
  node.art.visible = false
  if (level === 'figure') {
    node.body.ellipse(0, radius * 0.28, radius * 0.94, radius * 0.3).fill(side)
    const texture = textureFor(figureAsset(unit.type))
    if (texture !== null) {
      // The edge copy sits slightly larger behind the figure, which is what gives the silhouette
      // its thin bone rim light.
      node.artEdge.texture = texture
      node.artEdge.width = radius * 2.25
      node.artEdge.height = radius * 2.25
      node.artEdge.tint = CRANE_STYLE.text
      node.artEdge.visible = true
      node.art.texture = texture
      node.art.width = radius * 2.15
      node.art.height = radius * 2.15
      node.art.tint = deep
      node.art.visible = true
    } else {
      drawSengokuFigure(node.body, unit.type, radius, deep)
    }
    drawEllipseGauge(node.body, 0, radius * 0.28, radius * 0.94, radius * 0.3, gauge, deep)
    return
  }
  if (level === 'token') {
    node.body.circle(0, 0, radius).fill(side)
    node.body.circle(0, 0, radius * 0.72).fill(deep)
    const texture = textureFor(glyphAsset(unit.type))
    if (texture !== null) {
      node.art.texture = texture
      node.art.width = radius * 1.5
      node.art.height = radius * 1.5
      node.art.tint = CRANE_STYLE.text
      node.art.visible = true
    } else {
      drawWeaponGlyph(node.body, unit.type, radius * 0.92, CRANE_STYLE.text)
    }
    drawGauge(node.body, radius, gauge, deep)
    return
  }
  drawCompactMark(node.body, unit.type, radius, deep)
  drawCompactGauge(node.body, unit.type, radius, gauge, deep)
}

function figureAsset(type: SceneUnit['type']): CraneAssetName {
  return type === 'footman' ? 'figFootman' : type === 'archer' ? 'figArcher' : 'figCavalry'
}

/** The token mon, which the HUD rosters reuse as each unit type's mark. */
export function glyphAsset(type: SceneUnit['type']): CraneAssetName {
  return type === 'footman' ? 'glyphSword' : type === 'archer' ? 'glyphBow' : 'glyphHorse'
}

/** The token rim: a full depleted ring with the lit portion swept over it from the top. */
function drawGauge(graphics: Graphics, radius: number, gauge: GaugeState, depleted: string): void {
  const start = -Math.PI / 2
  const end = start + Math.PI * 2
  graphics
    .arc(0, 0, radius, start, end)
    .stroke({ color: depleted, width: Math.max(1.5, radius * 0.12) })
  graphics
    .arc(0, 0, radius, start, start + Math.PI * 2 * gauge.fraction)
    .stroke({ color: gauge.color, width: Math.max(1.5, radius * 0.12) })
  if (gauge.critical) {
    // A broken outer ring, so critical state carries a cue that does not depend on color.
    for (let index = 0; index < 4; index += 1) {
      const segment = start + index * Math.PI * 0.5
      graphics
        .arc(0, 0, radius * 1.15, segment, segment + Math.PI * 0.25)
        .stroke({ color: gauge.color, width: Math.max(1, radius * 0.07) })
    }
  }
}

/** Pixi arcs are circular, so the figure's base plate traces its ellipse by hand. */
function drawEllipseArc(
  graphics: Graphics,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  startFraction: number,
  endFraction: number,
  color: string,
  width: number,
): void {
  const steps = Math.max(2, Math.ceil((endFraction - startFraction) * 48))
  for (let step = 0; step <= steps; step += 1) {
    const fraction = startFraction + ((endFraction - startFraction) * step) / steps
    const angle = -Math.PI / 2 + fraction * Math.PI * 2
    const x = centerX + Math.cos(angle) * radiusX
    const y = centerY + Math.sin(angle) * radiusY
    if (step === 0) graphics.moveTo(x, y)
    else graphics.lineTo(x, y)
  }
  graphics.stroke({ color, width, cap: 'round', join: 'round' })
}

/** The figure's base plate edge as a gauge. */
function drawEllipseGauge(
  graphics: Graphics,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  gauge: GaugeState,
  depleted: string,
): void {
  const width = Math.max(1.5, radiusY * 0.38)
  drawEllipseArc(graphics, centerX, centerY, radiusX, radiusY, 0, 1, depleted, width)
  drawEllipseArc(
    graphics,
    centerX,
    centerY,
    radiusX,
    radiusY,
    0,
    gauge.fraction,
    gauge.color,
    width,
  )
  if (gauge.critical) {
    for (let segment = 0; segment < 4; segment += 1) {
      drawEllipseArc(
        graphics,
        centerX,
        centerY,
        radiusX * 1.14,
        radiusY * 1.28,
        segment * 0.25,
        segment * 0.25 + 0.12,
        gauge.color,
        Math.max(1, width * 0.55),
      )
    }
  }
}

/** Trace a fraction of a polyline's total length, which is how a marker edge fills. */
function drawPolylineProgress(
  graphics: Graphics,
  points: ReadonlyArray<{ x: number; y: number }>,
  progress: number,
  color: string,
  width: number,
): void {
  if (points.length < 2 || progress <= 0) return
  const lengths = points.slice(1).map((point, index) => {
    const previous = points[index] as { x: number; y: number }
    return Math.hypot(point.x - previous.x, point.y - previous.y)
  })
  let remaining = lengths.reduce((total, length) => total + length, 0) * Math.min(1, progress)
  const first = points[0] as { x: number; y: number }
  graphics.moveTo(first.x, first.y)
  for (let index = 0; index < lengths.length && remaining > 0; index += 1) {
    const start = points[index] as { x: number; y: number }
    const end = points[index + 1] as { x: number; y: number }
    const length = lengths[index] as number
    const covered = Math.min(1, remaining / length)
    graphics.lineTo(start.x + (end.x - start.x) * covered, start.y + (end.y - start.y) * covered)
    remaining -= length
  }
  graphics.stroke({ color, width, cap: 'round', join: 'round' })
}

/** The compact marker outlines: a shield square, an archer chevron, a cavalry hoof diamond. */
function compactGaugePoints(
  type: SceneUnit['type'],
  radius: number,
): Array<{ x: number; y: number }> {
  if (type === 'footman') {
    return [
      { x: 0, y: -radius },
      { x: radius, y: -radius },
      { x: radius, y: radius },
      { x: -radius, y: radius },
      { x: -radius, y: -radius },
      { x: 0, y: -radius },
    ]
  }
  if (type === 'archer') {
    return [
      { x: -radius, y: -radius * 0.55 },
      { x: 0, y: radius * 0.58 },
      { x: radius, y: -radius * 0.55 },
    ]
  }
  return [
    { x: 0, y: -radius },
    { x: radius, y: 0 },
    { x: 0, y: radius },
    { x: -radius, y: 0 },
    { x: 0, y: -radius },
  ]
}

/** The compact marker's own edge as a gauge. */
function drawCompactGauge(
  graphics: Graphics,
  type: SceneUnit['type'],
  radius: number,
  gauge: GaugeState,
  depleted: string,
): void {
  const points = compactGaugePoints(type, radius)
  const width = Math.max(1.5, radius * 0.14)
  drawPolylineProgress(graphics, points, 1, depleted, width)
  drawPolylineProgress(graphics, points, gauge.fraction, gauge.color, width)
  if (gauge.critical) {
    const outer = points.map((point) => ({ x: point.x * 1.16, y: point.y * 1.16 }))
    for (let index = 0; index < outer.length - 1; index += 1) {
      const start = outer[index] as { x: number; y: number }
      const end = outer[index + 1] as { x: number; y: number }
      graphics
        .moveTo(start.x, start.y)
        .lineTo(start.x + (end.x - start.x) * 0.45, start.y + (end.y - start.y) * 0.45)
        .stroke({ color: gauge.color, width: Math.max(1, width * 0.55), cap: 'round' })
    }
  }
}

/** Vector stand-in for the token mon: katana, yumi, warhorse. */
function drawWeaponGlyph(
  graphics: Graphics,
  type: SceneUnit['type'],
  radius: number,
  color: string,
): void {
  if (type === 'footman') {
    graphics
      .moveTo(0, radius * 0.58)
      .lineTo(0, -radius * 0.62)
      .stroke({ color, width: radius * 0.14 })
    graphics
      .poly([-radius * 0.16, -radius * 0.42, 0, -radius * 0.72, radius * 0.16, -radius * 0.42])
      .fill(color)
  } else if (type === 'archer') {
    graphics
      .arc(-radius * 0.1, 0, radius * 0.5, -Math.PI / 2, Math.PI / 2)
      .stroke({ color, width: radius * 0.11 })
    graphics
      .moveTo(radius * 0.3, -radius * 0.54)
      .lineTo(radius * 0.3, radius * 0.54)
      .stroke({ color, width: radius * 0.08 })
  } else {
    graphics
      .circle(-radius * 0.13, -radius * 0.12, radius * 0.25)
      .stroke({ color, width: radius * 0.1 })
    graphics
      .moveTo(radius * 0.06, radius * 0.18)
      .lineTo(radius * 0.53, radius * 0.31)
      .stroke({ color, width: radius * 0.14 })
  }
}

/** Vector stand-in for the figure silhouettes: ashigaru, kneeling archer, mounted samurai. */
function drawSengokuFigure(
  graphics: Graphics,
  type: SceneUnit['type'],
  radius: number,
  color: string,
): void {
  if (type === 'footman') {
    graphics.circle(0, -radius * 0.38, radius * 0.18).fill(color)
    graphics
      .poly([-radius * 0.3, radius * 0.36, 0, -radius * 0.2, radius * 0.3, radius * 0.36])
      .fill(color)
    graphics
      .moveTo(radius * 0.18, radius * 0.22)
      .lineTo(radius * 0.58, -radius * 0.7)
      .stroke({ color, width: radius * 0.09 })
  } else if (type === 'archer') {
    graphics.circle(-radius * 0.14, -radius * 0.23, radius * 0.16).fill(color)
    graphics
      .poly([
        -radius * 0.48,
        radius * 0.4,
        -radius * 0.12,
        -radius * 0.05,
        radius * 0.22,
        radius * 0.4,
      ])
      .fill(color)
    graphics
      .arc(radius * 0.3, 0, radius * 0.42, -Math.PI / 2, Math.PI / 2)
      .stroke({ color: CRANE_STYLE.text, width: radius * 0.08 })
  } else {
    graphics.ellipse(0, radius * 0.22, radius * 0.58, radius * 0.26).fill(color)
    graphics.circle(radius * 0.12, -radius * 0.3, radius * 0.16).fill(color)
    graphics
      .moveTo(radius * 0.08, -radius * 0.14)
      .lineTo(radius * 0.52, -radius * 0.63)
      .stroke({ color, width: radius * 0.09 })
  }
}

/** The compact marker fill, drawn under its gauge edge. */
function drawCompactMark(
  graphics: Graphics,
  type: SceneUnit['type'],
  radius: number,
  color: string,
): void {
  if (type === 'footman') {
    graphics.roundRect(-radius, -radius, radius * 2, radius * 2, radius * 0.18).fill(color)
  } else if (type === 'archer') {
    graphics
      .moveTo(-radius, -radius * 0.55)
      .lineTo(0, radius * 0.58)
      .lineTo(radius, -radius * 0.55)
      .stroke({ color, width: radius * 0.42, cap: 'round', join: 'round' })
  } else {
    graphics.poly([0, -radius, radius, 0, 0, radius, -radius, 0]).fill(color)
    graphics
      .moveTo(-radius * 0.34, radius * 0.1)
      .quadraticCurveTo(0, radius * 0.62, radius * 0.34, radius * 0.1)
      .stroke({ color: CRANE_STYLE.text, width: radius * 0.16 })
  }
}
