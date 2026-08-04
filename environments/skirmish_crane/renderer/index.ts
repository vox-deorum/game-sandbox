/**
 * The draw-only Crane Reach renderer. The pure scene is kept in `scene.ts`; this class only keeps
 * Pixi display objects in sync with it. Spectators, replays, and local watch all use this same view.
 */
import type { StepState } from '@game-sandbox/schema'
import { PixiRenderer } from '@renderers/base/PixiRenderer.js'
import type { RendererDefinition, RenderOptions } from '@renderers/types.js'
import { Container, Graphics, Text } from 'pixi.js'

import {
  type CraneReachScene,
  computeScene,
  PLACEHOLDER_STYLE,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  type SceneEvent,
  type SceneUnit,
} from './scene.js'
import thumbnail from './thumbnail.svg'

const EVENT_MAX_MS = 300

interface UnitNode {
  root: Container
  body: Graphics
  label: Text
}

export class CraneReachRenderer extends PixiRenderer {
  readonly internalSize = { width: SCENE_WIDTH, height: SCENE_HEIGHT } as const

  protected override readonly animated = true

  private battlefieldLayer!: Container
  private unitLayer!: Container
  private activationLayer!: Container
  private eventLayer!: Container
  private hudLayer!: Container
  private battlefieldKey: string | null = null
  private readonly unitNodes = new Map<string, UnitNode>()
  private event: SceneEvent | null = null
  private eventMarker!: Graphics
  private eventText!: Text
  private eventProgress = 1
  private eventDurationMs = EVENT_MAX_MS
  private eventTick: number | null = null

  protected setup(root: Container): void {
    this.battlefieldLayer = new Container()
    this.unitLayer = new Container()
    this.activationLayer = new Container()
    this.eventLayer = new Container()
    this.hudLayer = new Container()
    root.addChild(
      this.battlefieldLayer,
      this.unitLayer,
      this.activationLayer,
      this.eventLayer,
      this.hudLayer,
    )
    this.eventMarker = new Graphics()
    this.eventText = this.makeText('', 18, PLACEHOLDER_STYLE.event, 'center')
    this.eventText.position.set(SCENE_WIDTH / 2, 778)
    this.eventLayer.addChild(this.eventMarker, this.eventText)
  }

  protected update(state: StepState, options?: RenderOptions): void {
    const scene = computeScene(state)
    if (scene.battlefieldKey !== this.battlefieldKey) {
      this.rebuildBattlefield(scene)
      this.battlefieldKey = scene.battlefieldKey
    }
    this.reconcileUnits(scene)
    this.reconcileActivation(scene)
    this.reconcileHud(scene)

    const changedEvent = state.tick !== this.eventTick
    this.eventTick = state.tick
    this.event = scene.event
    if (scene.event === null) {
      this.eventProgress = 1
    } else if (options?.snap || !changedEvent) {
      this.eventProgress = 1
    } else {
      this.eventProgress = 0
      this.eventDurationMs = Math.max(
        1,
        Math.min(EVENT_MAX_MS, options?.transitionMs ?? EVENT_MAX_MS),
      )
    }
    this.reconcileEvent()
  }

  protected override onFrame(dtMs: number): boolean {
    if (this.event === null || this.eventProgress >= 1) return false
    this.eventProgress = Math.min(1, this.eventProgress + dtMs / this.eventDurationMs)
    this.reconcileEvent()
    return this.eventProgress < 1
  }

  private rebuildBattlefield(scene: CraneReachScene): void {
    clear(this.battlefieldLayer)
    const board = new Graphics()
    board.rect(0, 0, scene.width, scene.height).fill(PLACEHOLDER_STYLE.backdrop)
    for (const tile of scene.tiles) {
      board.poly(points(tile.corners)).fill(PLACEHOLDER_STYLE.terrain[tile.terrain])
      board.poly(points(tile.corners)).stroke({ color: PLACEHOLDER_STYLE.grid, width: 2 })
      if (tile.feature === 'forest') {
        board
          .circle(tile.center.x, tile.center.y, scene.hexRadius * 0.3)
          .fill(PLACEHOLDER_STYLE.feature.forest)
      } else if (tile.feature === 'marsh') {
        board
          .ellipse(tile.center.x, tile.center.y, scene.hexRadius * 0.38, scene.hexRadius * 0.2)
          .fill(PLACEHOLDER_STYLE.feature.marsh)
      }
    }
    const tilesByKey = new Map(scene.tiles.map((tile) => [tile.key, tile]))
    for (const zone of scene.zones) {
      for (const key of zone.tileKeys) {
        const tile = tilesByKey.get(key)
        if (tile === undefined) continue
        board
          .poly(points(tile.corners))
          .fill({ color: PLACEHOLDER_STYLE.zone, alpha: 0.12 })
          .stroke({ color: PLACEHOLDER_STYLE.zone, width: 2, alpha: 0.75 })
      }
      board.circle(zone.center.x, zone.center.y, scene.hexRadius * 0.42).stroke({
        color: PLACEHOLDER_STYLE.zone,
        width: 4,
      })
    }
    this.battlefieldLayer.addChild(board)
  }

  private reconcileUnits(scene: CraneReachScene): void {
    const { units } = scene
    const liveIds = new Set(units.map((unit) => unit.unitId))
    for (const [unitId, node] of this.unitNodes) {
      if (!liveIds.has(unitId)) {
        this.unitNodes.delete(unitId)
        node.root.removeFromParent()
        node.root.destroy({ children: true })
      }
    }
    for (const unit of units) {
      let node = this.unitNodes.get(unit.unitId)
      if (node === undefined) {
        node = this.createUnitNode()
        this.unitNodes.set(unit.unitId, node)
        this.unitLayer.addChild(node.root)
      }
      this.drawUnit(node, unit, scene.hexRadius)
    }
  }

  private createUnitNode(): UnitNode {
    const root = new Container()
    const body = new Graphics()
    const label = new Text({ text: '' })
    label.anchor.set(0.5)
    root.addChild(body, label)
    return { root, body, label }
  }

  private drawUnit(node: UnitNode, unit: SceneUnit, hexRadius: number): void {
    const radius = Math.max(6, hexRadius * 0.62)
    node.root.position.set(unit.position.x, unit.position.y)
    node.body.clear()
    node.body
      .circle(0, 0, radius)
      .fill(unit.side === 'red' ? PLACEHOLDER_STYLE.red : PLACEHOLDER_STYLE.blue)
    node.body.circle(0, 0, radius).stroke({ color: PLACEHOLDER_STYLE.text, width: 2 })
    node.label.resolution = this.textResolution()
    node.label.text = `${unit.type.slice(0, 1).toUpperCase()} ${unit.hitPoints}`
    node.label.style = {
      fontFamily: 'system-ui, sans-serif',
      fontWeight: 'bold',
      fontSize: Math.max(9, Math.min(14, hexRadius * 0.55)),
      fill: PLACEHOLDER_STYLE.text,
      stroke: { color: PLACEHOLDER_STYLE.backdrop, width: 3 },
    }
  }

  private reconcileActivation(scene: CraneReachScene): void {
    clear(this.activationLayer)
    if (scene.activation === null) return
    const ring = new Graphics()
    ring
      .circle(
        scene.activation.position.x,
        scene.activation.position.y,
        Math.max(8, scene.hexRadius * 0.82),
      )
      .stroke({
        color: PLACEHOLDER_STYLE.activation,
        width: Math.max(2, scene.hexRadius * 0.12),
      })
    this.activationLayer.addChild(ring)
  }

  private reconcileEvent(): void {
    this.eventMarker.clear()
    if (this.event === null) {
      this.eventText.visible = false
      return
    }
    const progress = this.eventProgress
    const x = this.event.from.x + (this.event.to.x - this.event.from.x) * progress
    const y = this.event.from.y + (this.event.to.y - this.event.from.y) * progress
    this.eventMarker.moveTo(this.event.from.x, this.event.from.y).lineTo(x, y).stroke({
      color: PLACEHOLDER_STYLE.event,
      width: 4,
      alpha: 0.8,
    })
    this.eventMarker.circle(x, y, 9).fill(PLACEHOLDER_STYLE.event)

    this.eventText.text = this.eventLabel(this.event)
    this.eventText.visible = this.eventText.text !== ''
  }

  private eventLabel(event: SceneEvent): string {
    const parts = [event.actorId.replaceAll('_', ' ')]
    if (event.targetId !== null)
      parts.push(`hit ${event.targetId.replaceAll('_', ' ')} for ${event.damage}`)
    if (event.deathId !== null) parts.push(`${event.deathId.replaceAll('_', ' ')} defeated`)
    if (event.redCapture !== 0 || event.blueCapture !== 0) {
      parts.push(
        `capture Δ R${event.redCapture >= 0 ? '+' : ''}${event.redCapture} B${event.blueCapture >= 0 ? '+' : ''}${event.blueCapture}`,
      )
    }
    return parts.join(' · ')
  }

  private reconcileHud(scene: CraneReachScene): void {
    clear(this.hudLayer)
    const round = this.makeText(scene.hud.round, 28, PLACEHOLDER_STYLE.text, 'left')
    round.position.set(28, 24)
    const capture = this.makeText(scene.hud.capture, 22, PLACEHOLDER_STYLE.mutedText, 'right')
    capture.position.set(SCENE_WIDTH - 28, 29)
    this.hudLayer.addChild(round, capture)
    if (scene.hud.terminal !== null) {
      const terminal = this.makeText(scene.hud.terminal, 26, PLACEHOLDER_STYLE.danger, 'center')
      terminal.position.set(SCENE_WIDTH / 2, 818)
      this.hudLayer.addChild(terminal)
    }
  }

  private makeText(
    value: string,
    size: number,
    fill: string,
    align: 'left' | 'center' | 'right',
  ): Text {
    const text = new Text({
      text: value,
      style: { fontFamily: 'system-ui, sans-serif', fontWeight: 'bold', fontSize: size, fill },
    })
    text.resolution = this.textResolution()
    text.anchor.set(
      align === 'left' ? 0 : align === 'right' ? 1 : 0.5,
      align === 'center' ? 0.5 : 0,
    )
    return text
  }
}

function points(corners: ReadonlyArray<{ x: number; y: number }>): number[] {
  return corners.flatMap((corner) => [corner.x, corner.y])
}

function clear(layer: Container): void {
  for (const child of layer.removeChildren()) {
    child.destroy({ children: true })
  }
}

const definition = {
  key: 'crane-reach-field',
  renderer: CraneReachRenderer,
  thumbnail,
} satisfies RendererDefinition

export default definition
