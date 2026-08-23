import { hashUnit, stableHashParts } from '@renderers/base/math.js'
import { Container, Graphics, Sprite, Texture } from 'pixi.js'

import { HEARTHSIDE_STYLE, type PlankTreatment } from '../core/presentation.js'
import type { TerrainBridgeComponent } from '../core/types.js'
import type { BridgeBoardSource, BridgeBoardSources } from '../terrain/bridge-board-sources.js'

/** Source resolution used for a component-wide bridge deck canvas. */
export const BRIDGE_DECK_SOURCE_CELLS = 128

export interface BridgeDeckArt {
  readonly bridgeBoards: BridgeBoardSources
}

export interface BridgeDeckBounds {
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number
  readonly runAxis: 'horizontal' | 'vertical'
}

export interface PlannedBridgeBoard {
  readonly index: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly sourceIndex: number
  /** Flip the material across the narrow deck axis. */
  readonly mirrored: boolean
  /** Flip the plank end-to-end across the deck's cross axis. */
  readonly reversed: boolean
  /** Signed cross-axis material offset in cell units. */
  readonly crossAxisPhase: number
}

export interface BridgeBoardPlan {
  readonly bounds: BridgeDeckBounds
  readonly boards: readonly PlannedBridgeBoard[]
}

export interface BridgeDeckLayer {
  readonly view: Container
  destroy(): void
}

/**
 * Plan the visible boards in cell coordinates. The planner only handles rectangles. The retained
 * component mask below keeps compact unions, including L shapes, inside their planned bridge cells.
 */
export function planBridgeBoards(
  component: TerrainBridgeComponent,
  treatment: PlankTreatment,
): BridgeBoardPlan {
  const bounds = deckBounds(component, treatment)
  const gameplayBounds = gameplayDeckBounds(component)
  const gameplayAxisSpan =
    gameplayBounds.runAxis === 'horizontal'
      ? gameplayBounds.maxX - gameplayBounds.minX
      : gameplayBounds.maxY - gameplayBounds.minY
  const visualAxisSpan =
    bounds.runAxis === 'horizontal' ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY
  const count = Math.max(1, Math.round(gameplayAxisSpan * treatment.boardsPerCell))
  const weights = Array.from(
    { length: count },
    (_, index) =>
      1 -
      treatment.widthVariation +
      hashUnit(stableHashParts('bridge-board-width', component.id, index)) *
        2 *
        treatment.widthVariation,
  )
  const scale = visualAxisSpan / weights.reduce((sum, weight) => sum + weight, 0)
  const crossSpan =
    bounds.runAxis === 'horizontal' ? bounds.maxY - bounds.minY : bounds.maxX - bounds.minX
  let cursor = bounds.runAxis === 'horizontal' ? bounds.minX : bounds.minY
  const boards: PlannedBridgeBoard[] = []
  for (let index = 0; index < count; index += 1) {
    const weight = weights[index]
    if (weight === undefined)
      throw new Error(`Bridge component ${component.id} has no board weight.`)
    const runSize = weight * scale
    const crossStart = bounds.runAxis === 'horizontal' ? bounds.minY : bounds.minX
    const crossSize = crossSpan
    const sourceIndex = Math.floor(
      hashUnit(stableHashParts('bridge-board-source', component.id, index)) * 3,
    )
    const board =
      bounds.runAxis === 'horizontal'
        ? {
            x: cursor,
            y: crossStart,
            width: runSize,
            height: crossSize,
          }
        : {
            x: crossStart,
            y: cursor,
            width: crossSize,
            height: runSize,
          }
    boards.push({
      index,
      ...board,
      sourceIndex,
      mirrored: hashUnit(stableHashParts('bridge-board-mirror', component.id, index)) >= 0.5,
      reversed: hashUnit(stableHashParts('bridge-board-reverse', component.id, index)) >= 0.5,
      crossAxisPhase:
        (hashUnit(stableHashParts('bridge-board-phase', component.id, index)) * 2 - 1) *
        treatment.sourcePhaseCells,
    })
    cursor += runSize
  }
  return {
    bounds,
    boards,
  }
}

/** Return the visual canvas bounds for a bridge component. */
export function deckBounds(
  component: TerrainBridgeComponent,
  treatment: Pick<
    PlankTreatment,
    'portalOverlapCells' | 'portalMaskInsetCells' | 'sideOverhangCells'
  > = HEARTHSIDE_STYLE.terrain.planks,
  outerPaddingCells = 0,
): BridgeDeckBounds {
  const bounds = gameplayDeckBounds(component)
  if (component.deck.kind === 'compact') return bounds
  const portal = treatment.portalOverlapCells + treatment.portalMaskInsetCells + outerPaddingCells
  const side = treatment.sideOverhangCells + outerPaddingCells
  return bounds.runAxis === 'horizontal'
    ? {
        ...bounds,
        minX: bounds.minX - portal,
        maxX: bounds.maxX + portal,
        minY: bounds.minY - side,
        maxY: bounds.maxY + side,
      }
    : {
        ...bounds,
        minX: bounds.minX - side,
        maxX: bounds.maxX + side,
        minY: bounds.minY - portal,
        maxY: bounds.maxY + portal,
      }
}

/** Return the authoritative gameplay deck bounds without visual overlap. */
function gameplayDeckBounds(component: TerrainBridgeComponent): BridgeDeckBounds {
  if (component.deck.kind === 'axis') {
    const axis = component.deck.axis
    if (axis === undefined) throw new Error(`Bridge component ${component.id} has no deck axis.`)
    const horizontal = axis[0].y === axis[1].y
    if (horizontal) {
      return {
        minX: Math.min(axis[0].x, axis[1].x),
        maxX: Math.max(axis[0].x, axis[1].x),
        minY: component.deck.center.y - component.deck.widthCells / 2,
        maxY: component.deck.center.y + component.deck.widthCells / 2,
        runAxis: 'horizontal',
      }
    }
    return {
      minX: component.deck.center.x - component.deck.widthCells / 2,
      maxX: component.deck.center.x + component.deck.widthCells / 2,
      minY: Math.min(axis[0].y, axis[1].y),
      maxY: Math.max(axis[0].y, axis[1].y),
      runAxis: 'vertical',
    }
  }
  if (component.cells.length === 1) {
    const half = component.deck.widthCells / 2
    return {
      minX: component.deck.center.x - half,
      maxX: component.deck.center.x + half,
      minY: component.deck.center.y - half,
      maxY: component.deck.center.y + half,
      runAxis:
        hashUnit(stableHashParts('bridge-compact-axis', component.id)) < 0.5
          ? 'horizontal'
          : 'vertical',
    }
  }
  const width = component.bounds.maxColumn - component.bounds.minColumn + 1
  const height = component.bounds.maxRow - component.bounds.minRow + 1
  return {
    minX: component.bounds.minColumn,
    maxX: component.bounds.maxColumn + 1,
    minY: component.bounds.minRow,
    maxY: component.bounds.maxRow + 1,
    runAxis:
      width === height
        ? hashUnit(stableHashParts('bridge-compact-axis', component.id)) < 0.5
          ? 'horizontal'
          : 'vertical'
        : width > height
          ? 'horizontal'
          : 'vertical',
  }
}

/** Create and retain one mipmapped canvas deck for every bridge component. */
export function createBridgeDeckLayer(
  art: BridgeDeckArt,
  components: readonly TerrainBridgeComponent[],
  cellSize: number,
  treatment: PlankTreatment = HEARTHSIDE_STYLE.terrain.planks,
): BridgeDeckLayer {
  const view = new Container({ label: 'terrain-bridge-decks' })
  const owned: { container: Container; sprite: Sprite; mask: Graphics; texture: Texture }[] = []
  try {
    for (const component of components) {
      const plan = planBridgeBoards(component, treatment)
      const source = art.bridgeBoards
      if (source.length !== 3)
        throw new Error(`Bridge component ${component.id} has no three-board art.`)
      const canvas = composeBridgeDeck(component, plan, source, treatment)
      const container = new Container({ label: `terrain-bridge-deck:${component.id}` })
      const mask = bridgeDeckMask(component, cellSize, treatment)
      let texture: Texture | undefined
      let sprite: Sprite | undefined
      try {
        texture = Texture.from({ resource: canvas, autoGenerateMipmaps: true })
        sprite = new Sprite({ label: 'terrain-bridge-deck-sprite', texture })
        sprite.position.set(plan.bounds.minX * cellSize, plan.bounds.minY * cellSize)
        sprite.scale.set(cellSize / BRIDGE_DECK_SOURCE_CELLS)
        mask.label = `terrain-bridge-deck-mask:${component.id}`
        sprite.mask = mask
        container.addChild(sprite, mask)
        view.addChild(container)
        owned.push({ container, sprite, mask, texture })
      } catch (error) {
        sprite?.destroy({ texture: false })
        mask.destroy()
        container.destroy({ children: false })
        texture?.destroy(true)
        throw error
      }
    }
  } catch (error) {
    destroyDeckNodes(view, owned)
    throw error
  }
  let destroyed = false
  return {
    view,
    destroy() {
      if (destroyed) return
      destroyed = true
      destroyDeckNodes(view, owned)
    },
  }
}

function composeBridgeDeck(
  component: TerrainBridgeComponent,
  plan: BridgeBoardPlan,
  sources: readonly BridgeBoardSource[],
  treatment: PlankTreatment,
): HTMLCanvasElement {
  const width = Math.max(
    1,
    Math.round((plan.bounds.maxX - plan.bounds.minX) * BRIDGE_DECK_SOURCE_CELLS),
  )
  const height = Math.max(
    1,
    Math.round((plan.bounds.maxY - plan.bounds.minY) * BRIDGE_DECK_SOURCE_CELLS),
  )
  const canvas = makeCanvas(width, height)
  const context = requiredContext(canvas, `Bridge component ${component.id} canvas`)
  const rotation = plan.bounds.runAxis === 'vertical' ? 1 : 0
  const sourceCanvases = sources.map((source) => boardCanvas(source, rotation))
  drawBoardSeams(context, plan, treatment, width, height)
  for (const board of plan.boards) {
    const source = sourceCanvases[board.sourceIndex]
    if (source === undefined)
      throw new Error(`Bridge component ${component.id} board source is missing.`)
    const rect = sourceRect(component, plan, board, treatment)
    drawBoardSource(context, source, rect, plan.bounds.runAxis, board)
  }
  drawCrossEdgeShadows(context, plan, treatment, width, height)
  return canvas
}

function drawCrossEdgeShadows(
  context: CanvasRenderingContext2D,
  plan: BridgeBoardPlan,
  treatment: PlankTreatment,
  width: number,
  height: number,
): void {
  const shadowWidth = treatment.edgeShadow.widthCells * BRIDGE_DECK_SOURCE_CELLS
  const tint = HEARTHSIDE_STYLE.palette[treatment.edgeShadow.tint]
  const transparentTint = `${tint}00`
  context.save()
  context.globalAlpha = treatment.edgeShadow.opacity
  context.globalCompositeOperation = 'source-atop'
  if (plan.bounds.runAxis === 'horizontal') {
    const north = context.createLinearGradient(0, 0, 0, shadowWidth)
    north.addColorStop(0, tint)
    north.addColorStop(1, transparentTint)
    context.fillStyle = north
    context.fillRect(0, 0, width, shadowWidth)

    const south = context.createLinearGradient(0, height - shadowWidth, 0, height)
    south.addColorStop(0, transparentTint)
    south.addColorStop(1, tint)
    context.fillStyle = south
    context.fillRect(0, height - shadowWidth, width, shadowWidth)
  } else {
    const west = context.createLinearGradient(0, 0, shadowWidth, 0)
    west.addColorStop(0, tint)
    west.addColorStop(1, transparentTint)
    context.fillStyle = west
    context.fillRect(0, 0, shadowWidth, height)

    const east = context.createLinearGradient(width - shadowWidth, 0, width, 0)
    east.addColorStop(0, transparentTint)
    east.addColorStop(1, tint)
    context.fillStyle = east
    context.fillRect(width - shadowWidth, 0, shadowWidth, height)
  }
  context.restore()
}

function drawBoardSeams(
  context: CanvasRenderingContext2D,
  plan: BridgeBoardPlan,
  treatment: PlankTreatment,
  width: number,
  height: number,
): void {
  context.fillStyle = HEARTHSIDE_STYLE.palette[treatment.seam.tint]
  context.globalAlpha = treatment.seam.opacity
  const seam = treatment.seam.widthCells * BRIDGE_DECK_SOURCE_CELLS
  for (const board of plan.boards.slice(0, -1)) {
    const rect = baseSourceRect(board, plan.bounds)
    if (plan.bounds.runAxis === 'horizontal') {
      context.fillRect(rect.x + rect.width - seam / 2, 0, seam, height)
    } else {
      context.fillRect(0, rect.y + rect.height - seam / 2, width, seam)
    }
  }
  context.globalAlpha = 1
}

function baseSourceRect(
  board: PlannedBridgeBoard,
  bounds: BridgeDeckBounds,
): { x: number; y: number; width: number; height: number } {
  return {
    x: (board.x - bounds.minX) * BRIDGE_DECK_SOURCE_CELLS,
    y: (board.y - bounds.minY) * BRIDGE_DECK_SOURCE_CELLS,
    width: board.width * BRIDGE_DECK_SOURCE_CELLS,
    height: board.height * BRIDGE_DECK_SOURCE_CELLS,
  }
}

function sourceRect(
  component: TerrainBridgeComponent,
  plan: BridgeBoardPlan,
  board: PlannedBridgeBoard,
  treatment: PlankTreatment,
): { x: number; y: number; width: number; height: number } {
  const rect = baseSourceRect(board, plan.bounds)
  const crossOverscan = treatment.sourceOverscanCells * BRIDGE_DECK_SOURCE_CELLS
  const phase = board.crossAxisPhase * BRIDGE_DECK_SOURCE_CELLS
  const axisOverscan =
    component.deck.kind === 'axis'
      ? treatment.portalSourceOverscanCells * BRIDGE_DECK_SOURCE_CELLS
      : 0
  const first = board.index === 0
  const last = board.index === plan.boards.length - 1
  if (plan.bounds.runAxis === 'horizontal') {
    rect.y -= crossOverscan - phase
    rect.height += crossOverscan * 2
    if (first) {
      rect.x -= axisOverscan
      rect.width += axisOverscan
    }
    if (last) rect.width += axisOverscan
  } else {
    rect.x -= crossOverscan - phase
    rect.width += crossOverscan * 2
    if (first) {
      rect.y -= axisOverscan
      rect.height += axisOverscan
    }
    if (last) rect.height += axisOverscan
  }
  return rect
}

function drawBoardSource(
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  rect: { x: number; y: number; width: number; height: number },
  runAxis: BridgeDeckBounds['runAxis'],
  board: PlannedBridgeBoard,
): void {
  context.save()
  const flipX = runAxis === 'horizontal' ? board.mirrored : board.reversed
  const flipY = runAxis === 'horizontal' ? board.reversed : board.mirrored
  context.translate(rect.x + (flipX ? rect.width : 0), rect.y + (flipY ? rect.height : 0))
  context.scale(flipX ? -1 : 1, flipY ? -1 : 1)
  context.drawImage(source, 0, 0, rect.width, rect.height)
  context.restore()
}

function boardCanvas(board: BridgeBoardSource, rotation: 0 | 1): HTMLCanvasElement {
  const rows = visibleBoardRows(board)
  const sourceHeight = rows.end - rows.start
  const width = rotation === 0 ? board.width : sourceHeight
  const height = rotation === 0 ? sourceHeight : board.width
  const canvas = makeCanvas(width, height)
  const context = requiredContext(canvas, 'Bridge board source canvas')
  const image = context.createImageData(width, height)
  if (rotation === 0) {
    for (let sourceY = rows.start; sourceY < rows.end; sourceY += 1) {
      const sourceOffset = sourceY * board.width * 4
      const targetOffset = (sourceY - rows.start) * board.width * 4
      image.data.set(
        board.pixels.subarray(sourceOffset, sourceOffset + board.width * 4),
        targetOffset,
      )
    }
  } else {
    for (let sourceY = rows.start; sourceY < rows.end; sourceY += 1) {
      for (let sourceX = 0; sourceX < board.width; sourceX += 1) {
        const sourceOffset = (sourceY * board.width + sourceX) * 4
        const targetX = sourceHeight - (sourceY - rows.start) - 1
        const targetY = sourceX
        const targetOffset = (targetY * width + targetX) * 4
        image.data.set(board.pixels.subarray(sourceOffset, sourceOffset + 4), targetOffset)
      }
    }
  }
  context.putImageData(image, 0, 0)
  return canvas
}

function visibleBoardRows(board: BridgeBoardSource): { start: number; end: number } {
  const minimumVisible = board.width * 0.1
  let start = 0
  while (start < board.height && visiblePixelsInRow(board, start) < minimumVisible) start += 1
  let end = board.height
  while (end > start && visiblePixelsInRow(board, end - 1) < minimumVisible) end -= 1
  if (start === end) throw new Error('Bridge board source has no visible material rows.')
  return { start, end }
}

function visiblePixelsInRow(board: BridgeBoardSource, row: number): number {
  let visible = 0
  for (let column = 0; column < board.width; column += 1) {
    if ((board.pixels[(row * board.width + column) * 4 + 3] ?? 0) > 16) visible += 1
  }
  return visible
}

/** Create the exact visual deck mask shared by component canvases and map route cutouts. */
export function bridgeDeckMask(
  component: TerrainBridgeComponent,
  cellSize: number,
  treatment: Pick<
    PlankTreatment,
    'portalOverlapCells' | 'portalMaskInsetCells' | 'sideOverhangCells'
  > = HEARTHSIDE_STYLE.terrain.planks,
  outerPaddingCells = 0,
): Graphics {
  const mask = new Graphics()
  appendBridgeDeckMask(mask, component, cellSize, treatment, outerPaddingCells)
  return mask
}

/** Append one visual deck mask into an existing graphics surface. */
export function appendBridgeDeckMask(
  mask: Graphics,
  component: TerrainBridgeComponent,
  cellSize: number,
  treatment: Pick<
    PlankTreatment,
    'portalOverlapCells' | 'portalMaskInsetCells' | 'sideOverhangCells'
  > = HEARTHSIDE_STYLE.terrain.planks,
  outerPaddingCells = 0,
): void {
  if (component.deck.kind === 'compact') {
    if (component.cells.length > 1) {
      for (const cell of component.cells)
        mask.rect(cell.column * cellSize, cell.row * cellSize, cellSize, cellSize).fill('#ffffff')
      return
    }
    const size = component.deck.widthCells * cellSize
    mask
      .roundRect(
        component.deck.center.x * cellSize - size / 2,
        component.deck.center.y * cellSize - size / 2,
        size,
        size,
        size / 4,
      )
      .fill('#ffffff')
    return
  }
  const bounds = deckBounds(component, { ...treatment, portalMaskInsetCells: 0 }, outerPaddingCells)
  mask
    .rect(
      bounds.minX * cellSize,
      bounds.minY * cellSize,
      (bounds.maxX - bounds.minX) * cellSize,
      (bounds.maxY - bounds.minY) * cellSize,
    )
    .fill('#ffffff')
}

function destroyDeckNodes(
  view: Container,
  owned: readonly { container: Container; sprite: Sprite; mask: Graphics; texture: Texture }[],
): void {
  for (const node of owned) {
    node.container.removeChild(node.sprite, node.mask)
    node.sprite.destroy({ texture: false })
    node.mask.destroy()
    node.container.destroy({ children: false })
    node.texture.destroy(true)
  }
  view.removeChildren()
  view.destroy({ children: false })
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function requiredContext(canvas: HTMLCanvasElement, name: string): CanvasRenderingContext2D {
  const context = canvas.getContext('2d')
  if (context === null) throw new Error(`${name} is unavailable.`)
  return context
}
