import { codePointLength } from '@game-sandbox/schema/text'
import { Container, Graphics, Text } from 'pixi.js'

import { HEARTHSIDE_STYLE, THREE_BRANCHES_PRESENTATION } from './presentation.js'
import type { CharacterDrawable, FrameScene, SpeechLine } from './types.js'

/** Operations exposed by the retained nameplate and speech bubble layer. */
export interface AnnotationLayer {
  /** Reconcile plates and bubbles toward one frame at one camera zoom. */
  reconcile(scene: FrameScene, zoom: number, fittedZoom: number, resolution: number): void
  /** Retain the lines one state delivered, replacing each speaker's previous line. */
  deliver(lines: readonly SpeechLine[]): void
  /** Drop every retained line, as an arbitrary replay seek must. */
  clear(): void
  /** Age retained lines, and report whether any still needs drawing. */
  advance(dtMs: number): boolean
}

/** A bubble's line and how long it has been retained, aged only by {@link AnnotationLayer.advance}. */
interface RetainedBubble {
  readonly line: SpeechLine
  readonly ageMs: number
}

/** The plate and bubble display objects retained for one character, keyed by its stable id. */
interface CharacterNode {
  readonly root: Container
  readonly plate: Graphics
  readonly plateLabel: Text
  readonly bubble: Container
  readonly bubbleBackground: Graphics
  readonly bubbleLabel: Text
}

// Screen-space layout, in the constant units each character node's `1 / zoom` scale exposes to it.
const PLATE_CLEARANCE = 14
const PLATE_PADDING_X = 8
const PLATE_PADDING_Y = 4
const PLATE_FONT_SIZE = 12
const PLATE_CHAR_WIDTH = 7.5
const PLATE_LINE_HEIGHT = 14
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
export function createAnnotationLayer(layer: Container): AnnotationLayer {
  const nodes = new Map<string, CharacterNode>()
  const bubbles = new Map<string, RetainedBubble>()
  // Every key in the last delivered state, so redrawing a multi-line state never restarts the final
  // bubble. Replacing the set on each delivery keeps memory bounded by one state.
  let lastDeliveryKeys = new Set<string>()

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
          node = createCharacterNode(layer, character.id)
          nodes.set(character.id, node)
        }
        node.root.position.set(character.point.x, character.point.y)
        node.root.scale.set(inverseZoom)

        const plateBottom = -(character.radius * zoom + PLATE_CLEARANCE)
        const plateTop = drawPlate(node, character, plateBottom, resolution)
        node.plate.alpha = plateAlpha
        node.plateLabel.alpha = plateAlpha

        const bubble = bubbles.get(character.id)
        if (bubble === undefined) {
          node.bubble.visible = false
        } else {
          node.bubble.visible = true
          drawBubble(node, bubble.line, plateTop - BUBBLE_GAP, resolution)
          node.bubble.alpha = speechAlpha(bubble.ageMs)
        }
      }
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
  if (!Number.isFinite(fittedZoom) || fittedZoom <= 0) return 1
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

function ellipsize(line: string, charsPerLine: number): string {
  const mark = '…'
  const points = Array.from(line)
  if (points.length + 1 <= charsPerLine) return `${line}${mark}`
  return `${points.slice(0, Math.max(0, charsPerLine - 1)).join('')}${mark}`
}

function createCharacterNode(parent: Container, id: string): CharacterNode {
  const bubble = new Container()
  const bubbleBackground = new Graphics()
  const bubbleLabel = new Text({
    text: '',
    style: {
      fill: HEARTHSIDE_STYLE.palette.ink,
      fontFamily: 'ui-monospace, monospace',
      fontSize: BUBBLE_FONT_SIZE,
      align: 'center',
    },
  })
  bubbleLabel.anchor.set(0.5, 1)
  bubble.addChild(bubbleBackground, bubbleLabel)
  bubble.visible = false

  const plate = new Graphics()
  const plateLabel = new Text({
    text: id,
    style: {
      fill: HEARTHSIDE_STYLE.palette.bone,
      fontFamily: 'ui-monospace, monospace',
      fontSize: PLATE_FONT_SIZE,
    },
  })
  plateLabel.anchor.set(0.5, 0.5)

  const root = new Container()
  root.addChild(bubble, plate, plateLabel)
  parent.addChild(root)
  return { root, plate, plateLabel, bubble, bubbleBackground, bubbleLabel }
}

/**
 * Paint the pill at its local bottom edge `bottomY` and return the pill's top edge, so a bubble
 * can stack above it. Sizing comes from the character id's length rather than measured text
 * bounds: Pixi can only measure text against a real canvas context, which a headless host does
 * not always provide, and the pill never needs pixel-exact sizing to read clearly.
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
    character.id === 'visitor' ? HEARTHSIDE_STYLE.palette.cinnabar : HEARTHSIDE_STYLE.palette.ink
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
