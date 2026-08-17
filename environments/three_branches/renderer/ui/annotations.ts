import { codePointLength } from '@game-sandbox/schema/text'
import { stableHashParts } from '@renderers/base/math.js'
import type { RendererTextFactory } from '@renderers/base/PixiRenderer.js'
import { Container, Graphics, Sprite, type Text, Texture } from 'pixi.js'

import { THREE_BRANCHES_ASSET_CATALOG } from '../assets.js'
import { HEARTHSIDE_STYLE, THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import type { CharacterDrawable, FrameScene, SpeechLine } from '../core/types.js'
import { frameRectangle } from './tint.js'

/** Operations exposed by the retained nameplate, speech bubble, and expression chip layer. */
export interface AnnotationLayer {
  /** Reconcile plates, chips, and bubbles toward one frame at one camera zoom. */
  reconcile(scene: FrameScene, zoom: number, fittedZoom: number, resolution: number): void
  /** Slice the expression chip's effects textures into the retained chip nodes. */
  install(art: ExpressionArt): void
  /** Retain the lines one state delivered, replacing each speaker's previous line. */
  deliver(lines: readonly SpeechLine[]): void
  /** Drop every retained line, as an arbitrary replay seek must. */
  clear(): void
  /** Age retained lines, and report whether any still needs drawing. */
  advance(dtMs: number): boolean
}

/** Slice the expression chip's ten pictograms and two shared accent frames. */
export interface ExpressionArt {
  /** Per-expression-token pictogram textures, keyed by emote token and 'use'. */
  icon: Readonly<Record<string, Texture>>
  /** Shared accent textures, keyed by their effects-page frame name. */
  accent: Readonly<Record<string, Texture>>
}

/** A bubble's line and how long it has been retained, aged only by {@link AnnotationLayer.advance}. */
interface RetainedBubble {
  readonly line: SpeechLine
  readonly ageMs: number
}

/** The plate, chip, and bubble display objects retained for one character, keyed by its stable id. */
interface CharacterNode {
  readonly root: Container
  readonly plate: Graphics
  readonly plateLabel: Text
  readonly chip: Container
  readonly chipPlate: Graphics
  readonly chipAccent: Sprite
  readonly chipIcon: Sprite
  readonly chipLabel: Text
  readonly bubble: Container
  readonly bubbleBackground: Graphics
  readonly bubbleLabel: Text
}

// Screen-space layout, in the constant units each character node's `1 / zoom` scale exposes to it.
const PLATE_CLEARANCE = 14
const PLATE_PADDING_X = 8
const PLATE_PADDING_Y = 4
const PLATE_FONT_SIZE = 14
const PLATE_CHAR_WIDTH = 8.75
const PLATE_LINE_HEIGHT = 16
const CHIP_GAP = 6
const CHIP_PADDING_X = 8
const CHIP_PADDING_Y = 3
const CHIP_FONT_SIZE = 12
const CHIP_CHAR_WIDTH = 7.25
const CHIP_TEXT_GAP = 6
const CHIP_ICON_SIZE = 18
const CHIP_ACCENT_SIZE = 22
const CHIP_LINE_HEIGHT = 16
const CHIP_ACCENT_ALPHA = 0.45
const BUBBLE_GAP = 10
const BUBBLE_CHARS_PER_LINE = 24
const BUBBLE_FONT_SIZE = 12
const BUBBLE_CHAR_WIDTH = 7
const BUBBLE_LINE_HEIGHT = 15
const BUBBLE_PADDING_X = 10
const BUBBLE_PADDING_Y = 8
const BUBBLE_CORNER_RADIUS = 8
const BUBBLE_TAIL_WIDTH = 6
const BUBBLE_TAIL_HEIGHT = 8

/**
 * Build the world-space information layer of character nameplates and speech bubbles.
 *
 * Plates and bubbles reconcile by stable character id, the way {@link createCharacterLayer} in
 * characters.ts does, so an arbitrary replay seek never depends on arrival order. Delivered lines
 * are retained and aged independently of the reconciled nodes, so a bubble survives its speaker
 * briefly leaving the frame and only {@link AnnotationLayer.advance} moves its clock forward.
 */
export function createAnnotationLayer(
  layer: Container,
  createText: RendererTextFactory,
): AnnotationLayer {
  const nodes = new Map<string, CharacterNode>()
  const bubbles = new Map<string, RetainedBubble>()
  // Every key in the last delivered state, so redrawing a multi-line state never restarts the final
  // bubble. Replacing the set on each delivery keeps memory bounded by one state.
  let lastDeliveryKeys = new Set<string>()
  let art: ExpressionArt | null = null

  return {
    reconcile(scene, zoom, fittedZoom, resolution) {
      const active = new Set(scene.characters.map((character) => character.id))
      for (const [id, node] of nodes) {
        if (!active.has(id)) {
          node.root.destroy({ children: true })
          nodes.delete(id)
        }
      }

      const inverseZoom = Number.isFinite(zoom) && zoom > 0 ? 1 / zoom : 1
      const plateAlpha = nameplateAlpha(zoom, fittedZoom)
      for (const character of scene.characters) {
        let node = nodes.get(character.id)
        if (node === undefined) {
          node = createCharacterNode(layer, character.id, createText)
          nodes.set(character.id, node)
        }
        node.root.position.set(character.point.x, character.point.y)
        node.root.scale.set(inverseZoom)

        const plateBottom = -(character.radius * zoom + PLATE_CLEARANCE)
        const plateTop = drawPlate(node, character, plateBottom, resolution)
        node.plate.alpha = plateAlpha
        node.plateLabel.alpha = plateAlpha

        // The expression chip appears only where the nameplate is fully opaque, and the bubble
        // stacks above it when one is drawn, otherwise above the plate.
        let stackTop = plateTop
        const chipShown = character.expressionTitle !== null && plateAlpha === 1
        node.chip.visible = chipShown
        if (chipShown && character.expressionTitle !== null) {
          const accentFrame = expressionAccentFrame(
            character.id,
            character.expression.type,
            scene.presentationTick,
          )
          stackTop = drawChip(node, character.expressionTitle, plateTop - CHIP_GAP, resolution, art)
          if (art !== null) {
            // The retained sprites carry no intrinsic scale: the effects grid frames are 192 by 128
            // units at 1:1, so each one is scaled down into its reserved chip lane as its texture lands.
            const icon = art.icon[character.expression.type] ?? Texture.EMPTY
            const accent = art.accent[accentFrame] ?? Texture.EMPTY
            node.chipIcon.texture = icon
            node.chipIcon.scale.set(chipSpriteScale(icon, CHIP_ICON_SIZE))
            node.chipAccent.texture = accent
            node.chipAccent.scale.set(chipSpriteScale(accent, CHIP_ACCENT_SIZE))
          }
        }

        const bubble = bubbles.get(character.id)
        if (bubble === undefined) {
          node.bubble.visible = false
        } else {
          node.bubble.visible = true
          drawBubble(node, bubble.line, stackTop - BUBBLE_GAP, resolution)
          node.bubble.alpha = speechAlpha(bubble.ageMs)
        }
      }
    },

    install(nextArt) {
      art = nextArt
    },

    deliver(lines) {
      const deliveryKeys = new Set(lines.map((line) => line.key))
      for (const line of lines) {
        if (lastDeliveryKeys.has(line.key)) continue
        bubbles.set(line.speaker, { line, ageMs: 0 })
      }
      lastDeliveryKeys = deliveryKeys
    },

    clear() {
      bubbles.clear()
      lastDeliveryKeys.clear()
      for (const node of nodes.values()) node.bubble.visible = false
    },

    advance(dtMs) {
      for (const [speaker, bubble] of bubbles) {
        const ageMs = bubble.ageMs + dtMs
        if (speechAlpha(ageMs) <= 0) {
          bubbles.delete(speaker)
        } else {
          bubbles.set(speaker, { line: bubble.line, ageMs })
        }
      }
      return bubbles.size > 0
    },
  }
}

/** Plate opacity at one camera zoom, zero below the fade band and one at or above the full-plate zoom. */
export function nameplateAlpha(zoom: number, fittedZoom: number): number {
  const { nameplateZoomFactor, nameplateFadeFactor } = THREE_BRANCHES_PRESENTATION
  const fullZoom = fittedZoom * nameplateZoomFactor
  const floorZoom = fittedZoom * (nameplateZoomFactor - nameplateFadeFactor)
  if (zoom >= fullZoom) return 1
  if (zoom <= floorZoom) return 0
  return (zoom - floorZoom) / (fullZoom - floorZoom)
}

/** Wrap one delivered line to the configured line budget, eliding the overflow. */
export function wrapSpeech(
  text: string,
  charsPerLine: number,
  maxLines: number,
): readonly string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0)
  const lines: string[] = []
  let current = ''
  let currentLength = 0
  for (const word of words) {
    const points = Array.from(word)
    let offset = 0
    while (points.length - offset > charsPerLine) {
      if (currentLength > 0) {
        lines.push(current)
        current = ''
        currentLength = 0
      }
      lines.push(points.slice(offset, offset + charsPerLine).join(''))
      offset += charsPerLine
    }
    const restPoints = points.slice(offset)
    const rest = restPoints.join('')
    const candidateLength =
      currentLength === 0 ? restPoints.length : currentLength + 1 + restPoints.length
    if (candidateLength > charsPerLine) {
      lines.push(current)
      current = rest
      currentLength = restPoints.length
    } else {
      current = currentLength === 0 ? rest : `${current} ${rest}`
      currentLength = candidateLength
    }
  }
  if (currentLength > 0) lines.push(current)

  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = ellipsize(kept[maxLines - 1] ?? '', charsPerLine)
  return kept
}

/** Bubble opacity for one age in milliseconds: one through the hold, ramping to zero across the fade. */
export function speechAlpha(ageMs: number): number {
  const { speechHoldMs, speechFadeMs } = THREE_BRANCHES_PRESENTATION
  if (ageMs <= speechHoldMs) return 1
  const fadeAgeMs = ageMs - speechHoldMs
  if (fadeAgeMs >= speechFadeMs) return 0
  return 1 - fadeAgeMs / speechFadeMs
}

/** The bubble's recipient tag, or null for an untagged broadcast. */
export function speechTag(line: SpeechLine): string | null {
  return line.addressee === null ? null : `to ${line.addressee}`
}

/**
 * The chip accent's frame at one absolute fractional presentation tick.
 *
 * The accent phase is a pure function of player id, expression type, and the fractional tick, so a
 * live transition, a repeated state, a replay, and a direct seek all resolve the same frame.
 */
export function expressionAccentFrame(
  playerId: string,
  type: string,
  fractionalTick: number,
): string {
  const { accentFrames, frameRatio } = HEARTHSIDE_STYLE.expressions
  if (accentFrames.length === 0) return ''
  const phase = stableHashParts('three-branches-expression-accent', playerId, type)
  const clock = fractionalTick * frameRatio + (phase / 0xffffffff) * accentFrames.length
  return accentFrames[Math.floor(clock) % accentFrames.length] ?? accentFrames[0] ?? ''
}

/** Slice the expression chip's textures from the effects page without changing its source. */
export function createExpressionArt(atlas: Texture): ExpressionArt {
  const effects = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === 'effects')
  if (effects === undefined || 'layers' in effects) {
    throw new Error('Three Branches effects atlas is missing.')
  }
  const views = Object.fromEntries(
    effects.frames.names.map((name) => [
      name,
      new Texture({ source: atlas.source, frame: frameRectangle(effects.frames, name) }),
    ]),
  )
  const required = (name: string): Texture => {
    const texture = views[name]
    if (texture === undefined) throw new Error(`Three Branches effects frame is missing: ${name}`)
    return texture
  }
  return {
    icon: Object.fromEntries(
      Object.entries(HEARTHSIDE_STYLE.expressions.frames).map(([token, frame]) => [
        token,
        required(frame),
      ]),
    ),
    accent: Object.fromEntries(
      HEARTHSIDE_STYLE.expressions.accentFrames.map((frame) => [frame, required(frame)]),
    ),
  }
}

/**
 * The scale that sizes one expression-chip sprite into its reserved layout lane. Effects atlas
 * frames are 192 by 128 units at 1:1, so each is shrunk by `targetWidth / frameWidth` — preserving
 * the design's aspect while keeping the artwork inside the pill, whatever frame lands later.
 */
function chipSpriteScale(texture: Texture, targetWidth: number): number {
  return texture.width > 0 ? targetWidth / texture.width : 1
}

function ellipsize(line: string, charsPerLine: number): string {
  const mark = '…'
  const points = Array.from(line)
  if (points.length + 1 <= charsPerLine) return `${line}${mark}`
  return `${points.slice(0, Math.max(0, charsPerLine - 1)).join('')}${mark}`
}

function createCharacterNode(
  parent: Container,
  id: string,
  createText: RendererTextFactory,
): CharacterNode {
  const bubble = new Container({ label: 'annotation-bubble' })
  const bubbleBackground = new Graphics()
  const bubbleLabel = createText(
    '',
    BUBBLE_FONT_SIZE,
    HEARTHSIDE_STYLE.palette.ink,
    'center',
    'ui-monospace, monospace',
  )
  bubbleLabel.style.align = 'center'
  bubbleLabel.anchor.set(0.5, 1)
  bubble.addChild(bubbleBackground, bubbleLabel)
  bubble.visible = false

  const plate = new Graphics()
  const plateLabel = createText(
    id,
    PLATE_FONT_SIZE,
    HEARTHSIDE_STYLE.palette.bone,
    'center',
    'ui-monospace, monospace',
  )

  // The chip's plate and text exist before any artwork so a pending or failed art load leaves a
  // readable text-only chip. Artwork only fills the retained pictogram and accent sprites.
  const chip = new Container({ label: 'annotation-chip' })
  const chipPlate = new Graphics()
  const chipAccent = new Sprite({ label: 'annotation-chip-accent', texture: Texture.EMPTY })
  chipAccent.anchor.set(0.5)
  chipAccent.visible = false
  chipAccent.tint = HEARTHSIDE_STYLE.palette.gilt
  chipAccent.alpha = CHIP_ACCENT_ALPHA
  const chipIcon = new Sprite({ label: 'annotation-chip-icon', texture: Texture.EMPTY })
  chipIcon.anchor.set(0.5)
  chipIcon.visible = false
  chipIcon.tint = HEARTHSIDE_STYLE.palette[HEARTHSIDE_STYLE.expressions.tint]
  const chipLabel = createText(
    '',
    CHIP_FONT_SIZE,
    HEARTHSIDE_STYLE.palette.ink,
    'center',
    'ui-monospace, monospace',
  )
  chip.visible = false
  chip.addChild(chipPlate, chipAccent, chipIcon, chipLabel)

  const root = new Container()
  root.addChild(chip, bubble, plate, plateLabel)
  parent.addChild(root)
  return {
    root,
    plate,
    plateLabel,
    chip,
    chipPlate,
    chipAccent,
    chipIcon,
    chipLabel,
    bubble,
    bubbleBackground,
    bubbleLabel,
  }
}

/** Paint the chip at `bottomY` and return its top edge, keeping the stack above the nameplate. */
function drawChip(
  node: CharacterNode,
  title: string,
  bottomY: number,
  resolution: number,
  art: ExpressionArt | null,
): number {
  node.chipLabel.text = title
  node.chipLabel.resolution = resolution
  const textWidth = codePointLength(title) * CHIP_CHAR_WIDTH
  const width =
    CHIP_PADDING_X * 2 +
    CHIP_ACCENT_SIZE +
    CHIP_TEXT_GAP +
    CHIP_ICON_SIZE +
    CHIP_TEXT_GAP +
    textWidth
  const height = Math.max(CHIP_ACCENT_SIZE, CHIP_ICON_SIZE, CHIP_LINE_HEIGHT) + CHIP_PADDING_Y * 2
  const chipLeft = -width / 2
  const centerY = bottomY - height / 2
  const accentX = chipLeft + CHIP_PADDING_X + CHIP_ACCENT_SIZE / 2
  const iconX = chipLeft + CHIP_PADDING_X + CHIP_ACCENT_SIZE + CHIP_TEXT_GAP + CHIP_ICON_SIZE / 2
  const labelX =
    chipLeft +
    CHIP_PADDING_X +
    CHIP_ACCENT_SIZE +
    CHIP_TEXT_GAP +
    CHIP_ICON_SIZE +
    CHIP_TEXT_GAP +
    textWidth / 2
  node.chipPlate
    .clear()
    .roundRect(chipLeft, bottomY - height, width, height, height / 2)
    .fill(HEARTHSIDE_STYLE.palette.parchment)
    .stroke({ color: HEARTHSIDE_STYLE.palette.timber, width: 1 })
  node.chipAccent.position.set(accentX, centerY)
  node.chipIcon.position.set(iconX, centerY)
  node.chipLabel.position.set(labelX, centerY)
  // The pictogram and accent only exist once their effects textures are installed.
  node.chipAccent.visible = art !== null
  node.chipIcon.visible = art !== null
  return bottomY - height
}

/** Paint the pill at its local bottom edge `bottomY` and return the pill's top edge, so a chip
 * or bubble can stack above it. Sizing comes from the character id's length rather than measured
 * text bounds: Pixi can only measure text against a real canvas context, which a headless host
 * does not always provide, and the pill never needs pixel-exact sizing to read clearly.
 */
function drawPlate(
  node: CharacterNode,
  character: CharacterDrawable,
  bottomY: number,
  resolution: number,
): number {
  node.plateLabel.text = character.id
  node.plateLabel.resolution = resolution
  const accent =
    character.id === 'player_0' ? HEARTHSIDE_STYLE.palette.cinnabar : HEARTHSIDE_STYLE.palette.ink
  const width = character.id.length * PLATE_CHAR_WIDTH + PLATE_PADDING_X * 2
  const height = PLATE_LINE_HEIGHT + PLATE_PADDING_Y * 2
  node.plate.clear()
  node.plate
    .roundRect(-width / 2, bottomY - height, width, height, height / 2)
    .fill(accent)
    .stroke({ color: HEARTHSIDE_STYLE.palette.backdrop, width: 1 })
  node.plateLabel.position.set(0, bottomY - height / 2)
  return bottomY - height
}

/** Paint the bubble with its bottom tail point at local `bottomY`, sized the same way as the plate. */
function drawBubble(
  node: CharacterNode,
  line: SpeechLine,
  bottomY: number,
  resolution: number,
): void {
  const wrapped = wrapSpeech(
    line.text,
    BUBBLE_CHARS_PER_LINE,
    THREE_BRANCHES_PRESENTATION.speechMaxLines,
  )
  const tag = speechTag(line)
  const rows = tag === null ? wrapped : [...wrapped, `(${tag})`]
  node.bubbleLabel.text = rows.join('\n')
  node.bubbleLabel.resolution = resolution

  const longestRow = rows.reduce((widest, row) => Math.max(widest, codePointLength(row)), 0)
  const width = longestRow * BUBBLE_CHAR_WIDTH + BUBBLE_PADDING_X * 2
  const height = rows.length * BUBBLE_LINE_HEIGHT + BUBBLE_PADDING_Y * 2

  node.bubbleBackground.clear()
  node.bubbleBackground
    .roundRect(-width / 2, bottomY - height, width, height, BUBBLE_CORNER_RADIUS)
    .fill(HEARTHSIDE_STYLE.palette.parchment)
    .stroke({ color: HEARTHSIDE_STYLE.palette.timber, width: 1 })
  node.bubbleBackground
    .poly([
      -BUBBLE_TAIL_WIDTH,
      bottomY,
      BUBBLE_TAIL_WIDTH,
      bottomY,
      0,
      bottomY + BUBBLE_TAIL_HEIGHT,
    ])
    .fill(HEARTHSIDE_STYLE.palette.parchment)
  node.bubbleLabel.position.set(0, bottomY - BUBBLE_PADDING_Y)
}
