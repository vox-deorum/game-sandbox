import { codePointLength } from '@game-sandbox/schema/text'
import { stableHashParts } from '@renderers/base/math.js'
import type { RendererTextFactory } from '@renderers/base/PixiRenderer.js'
import { Container, Graphics, Sprite, type Text, Texture } from 'pixi.js'

import { THREE_BRANCHES_ASSET_CATALOG } from '../assets.js'
import { HEARTHSIDE_STYLE, THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import type { CharacterDrawable, FrameScene, SpeechLine } from '../core/types.js'
import { frameRectangle } from './tint.js'

/** Operations exposed by the retained nameplate, expression marker, and speech bubble layer. */
export interface AnnotationLayer {
  /** Reconcile plates, pictograms, and bubbles toward one frame at one camera zoom. */
  reconcile(scene: FrameScene, zoom: number, fittedZoom: number, resolution: number): void
  /** Slice the expression pictograms into the retained annotation nodes. */
  install(art: ExpressionArt): void
  /**
   * Advance the per-character expression marker machines by one delivered state. A live marker
   * stays live, then holds {@link EXPRESSION_HOLD_TICKS} more states and fades across one state of
   * `tickMs`. Called once per landed state, never on a redraw.
   */
  observeExpressions(scene: FrameScene, tickMs: number): void
  /** The semantic title of one visible or retained expression, or null for none. */
  expressionChipTitle(characterId: string): string | null
  /** Retain the lines one state delivered, replacing each speaker's previous line. */
  deliver(lines: readonly SpeechLine[]): void
  /**
   * Drop every retained line and expression marker tail, as an arbitrary replay seek must.
   */
  clear(): void
  /** Age retained lines and expression fades, and report whether any still needs drawing. */
  advance(dtMs: number): boolean
}

/** Slice expression and prop-activity pictograms from the effects page. */
export interface ExpressionArt {
  /** Per-expression-token pictogram textures, keyed by emote and activity token. */
  icon: Readonly<Record<string, Texture>>
  /** Shared accent textures, keyed by their effects-page frame name. */
  accent: Readonly<Record<string, Texture>>
}

/** A bubble's line and how long it has been retained, aged only by {@link AnnotationLayer.advance}. */
interface RetainedBubble {
  readonly line: SpeechLine
  readonly ageMs: number
}

/**
 * The per-character expression marker tail. A `live` entry draws the target expression at full opacity;
 * when the expression reads `none`, the same entry enters `hold` for {@link EXPRESSION_HOLD_TICKS}
 * delivered states and finally `fade`, ramping the icon's alpha to zero across one state. Only one
 * entry exists per character, so a newer expression always replaces the older one.
 */
interface ExpressionChip {
  readonly title: string
  /** The resolved emote or prop-activity token for the pictogram. */
  readonly icon: string
  phase: 'live' | 'hold' | 'fade'
  /** Delivered states yet to show at full opacity in the hold phase. */
  remainTicks: number
  /** Milliseconds one no-expression state lasts, the fade phase's full span. */
  fadeMs: number
  /** Milliseconds the fade phase has already shown. */
  elapsedMs: number
}

/** The fused plate, pictogram, and bubble display objects retained for one character. */
interface CharacterNode {
  readonly root: Container
  readonly plate: Graphics
  readonly plateLabel: Text
  readonly expression: Container
  readonly expressionIcon: Sprite
  readonly bubble: Container
  readonly bubbleBackground: Graphics
  readonly bubbleLabel: Text
}

// Screen-space layout, in the constant units each character node's `1 / zoom` scale exposes to it.
const PLATE_CLEARANCE = 14
const WORLD_LABEL = HEARTHSIDE_STYLE.expressions.worldLabel
// The expression marker lingers this many delivered states at full opacity once its expression reads
// `none`, then fades out across the next delivered state. Counting delivered states (never redraws)
// keeps the tail deterministic through movement animation and replay cadence.
const EXPRESSION_HOLD_TICKS = 2
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
  // One expression marker tail per character, replaced by the newest expression and aged by delivery.
  const chips = new Map<string, ExpressionChip>()
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
          chips.delete(id)
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

        const retained = chips.get(character.id)
        const expressionShown =
          art !== null &&
          plateAlpha === 1 &&
          (retained !== undefined || character.expressionIcon !== null)
        const expressionIcon = retained?.icon ?? character.expressionIcon ?? 'use'
        const expressionAlpha = retained === undefined ? 1 : displayedChipAlpha(retained)
        const plateBottom = -(character.radius * zoom + PLATE_CLEARANCE)
        const plateTop = drawPlate(
          node,
          character,
          plateBottom,
          resolution,
          expressionShown,
          expressionAlpha,
          art,
          expressionIcon,
        )
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

    install(nextArt) {
      art = nextArt
    },

    observeExpressions(scene, tickMs) {
      const present = new Set(scene.characters.map((character) => character.id))
      for (const character of scene.characters) {
        const title = character.expressionTitle
        const previous = chips.get(character.id)
        if (title !== null) {
          // A live expression (new or repeated) replaces and resets any hold or fade tail.
          chips.set(character.id, {
            title,
            icon: character.expressionIcon ?? 'use',
            phase: 'live',
            remainTicks: 0,
            fadeMs: 0,
            elapsedMs: 0,
          })
          continue
        }
        if (previous === undefined) continue
        if (previous.phase === 'live') {
          chips.set(character.id, {
            ...previous,
            phase: 'hold',
            remainTicks: EXPRESSION_HOLD_TICKS,
          })
        } else if (previous.phase === 'hold') {
          if (previous.remainTicks > 1) {
            chips.set(character.id, { ...previous, remainTicks: previous.remainTicks - 1 })
          } else {
            chips.set(character.id, {
              ...previous,
              phase: 'fade',
              remainTicks: 0,
              // The fade spans this one delivered state, whatever its playback rate.
              fadeMs: Math.max(1, tickMs),
              elapsedMs: 0,
            })
          }
        }
      }
      for (const id of [...chips.keys()]) if (!present.has(id)) chips.delete(id)
    },

    expressionChipTitle(characterId) {
      const chip = chips.get(characterId)
      return chip === undefined ? null : chip.title
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
      chips.clear()
      for (const node of nodes.values()) {
        node.bubble.visible = false
        node.expression.visible = false
        node.expression.alpha = 1
      }
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
      let fading = false
      for (const [id, chip] of chips) {
        if (chip.phase !== 'fade') continue
        const elapsedMs = chip.elapsedMs + dtMs
        if (elapsedMs >= chip.fadeMs) {
          chips.delete(id)
        } else {
          chips.set(id, { ...chip, elapsedMs })
          fading = true
        }
      }
      return bubbles.size > 0 || fading
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
      Object.entries({
        ...HEARTHSIDE_STYLE.expressions.frames,
        ...(HEARTHSIDE_STYLE.expressions as { activityFrames?: Readonly<Record<string, string>> })
          .activityFrames,
      }).map(([token, frame]) => [token, required(frame)]),
    ),
    accent: Object.fromEntries(
      HEARTHSIDE_STYLE.expressions.accentFrames.map((frame) => [frame, required(frame)]),
    ),
  }
}

/**
 * The scale that sizes one expression-chip sprite into its reserved layout lane. Effects atlas
 * frames are 192 by 128 units at 1:1, so each is shrunk by `targetWidth / frameWidth`, preserving
 * the design's aspect while keeping the artwork inside the pill, whatever frame lands later.
 */
function chipSpriteScale(texture: Texture, targetWidth: number): number {
  return texture.width > 0 ? targetWidth / texture.width : 1
}

/** Chip opacity for one tail machine entry: full through live and hold, ramping to zero across fade. */
function displayedChipAlpha(chip: ExpressionChip): number {
  if (chip.phase !== 'fade') return 1
  return Math.max(0, 1 - chip.elapsedMs / chip.fadeMs)
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
    WORLD_LABEL.fontSize,
    HEARTHSIDE_STYLE.palette.bone,
    'center',
    'ui-monospace, monospace',
  )

  const expression = new Container({ label: 'annotation-expression' })
  const expressionIcon = new Sprite({ label: 'annotation-expression-icon', texture: Texture.EMPTY })
  expressionIcon.anchor.set(0.5)
  expressionIcon.tint = HEARTHSIDE_STYLE.palette[HEARTHSIDE_STYLE.expressions.tint]
  expression.visible = false
  expression.addChild(expressionIcon)

  const root = new Container()
  root.addChild(bubble, plate, plateLabel, expression)
  parent.addChild(root)
  return {
    root,
    plate,
    plateLabel,
    expression,
    expressionIcon,
    bubble,
    bubbleBackground,
    bubbleLabel,
  }
}

/** Paint the fused pill at its local bottom edge `bottomY` and return its top edge. Sizing comes
 * from the character id's length rather than measured
 * text bounds: Pixi can only measure text against a real canvas context, which a headless host
 * does not always provide, and the pill never needs pixel-exact sizing to read clearly.
 */
function drawPlate(
  node: CharacterNode,
  character: CharacterDrawable,
  bottomY: number,
  resolution: number,
  expressionShown: boolean,
  expressionAlpha: number,
  art: ExpressionArt | null,
  expressionIcon: string,
): number {
  node.plateLabel.text = character.id
  node.plateLabel.resolution = resolution
  const accent =
    character.id === 'player_0' ? HEARTHSIDE_STYLE.palette.cinnabar : HEARTHSIDE_STYLE.palette.ink
  const nameWidth = character.id.length * WORLD_LABEL.characterWidth + WORLD_LABEL.paddingX * 2
  const height = WORLD_LABEL.lineHeight + WORLD_LABEL.paddingY * 2
  const left = -nameWidth / 2 - (expressionShown ? WORLD_LABEL.iconSlotWidth : 0)
  const width = nameWidth + (expressionShown ? WORLD_LABEL.iconSlotWidth : 0)
  node.plate.clear()
  node.plate
    .roundRect(left, bottomY - height, width, height, height / 2)
    .fill(accent)
    .stroke({ color: HEARTHSIDE_STYLE.palette.backdrop, width: 1 })
  if (expressionShown) {
    const dividerX = -nameWidth / 2
    node.plate
      .moveTo(dividerX, bottomY - height + 3)
      .lineTo(dividerX, bottomY - 3)
      .stroke({
        color: HEARTHSIDE_STYLE.palette.gilt,
        width: 1,
      })
  }
  node.plateLabel.position.set(0, bottomY - height / 2)
  node.expression.visible = expressionShown && art !== null
  node.expression.alpha = expressionAlpha
  if (node.expression.visible && art !== null) {
    const icon = art.icon[expressionIcon] ?? art.icon.use ?? Texture.EMPTY
    node.expressionIcon.texture = icon
    node.expressionIcon.scale.set(chipSpriteScale(icon, WORLD_LABEL.iconFrameWidth))
    node.expressionIcon.position.set(
      -nameWidth / 2 - WORLD_LABEL.iconSlotWidth / 2,
      bottomY - height / 2,
    )
  }
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
