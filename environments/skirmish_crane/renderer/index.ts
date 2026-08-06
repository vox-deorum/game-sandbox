/**
 * The Estuary Ink renderer for Skirmish at Crane Reach.
 *
 * This file owns the renderer's state and decides what to draw when. The work itself is split so
 * that each piece can be found and edited on its own:
 *
 * - `scene.ts` turns a recorded state into a pure drawable scene, and holds the palette.
 * - `presentation.ts`, `timeline.ts`, and `transitions.ts` hold the tunable logic: how large things
 *   are at a given display size, when each beat of an event happens, and when an event animates.
 * - `board.ts`, `units.ts`, `hud.ts`, and `draw.ts` hold the brushwork.
 *
 * The one piece of choreography that stays here is `reconcileEvent`, because it reads most of the
 * renderer's live state at once. Its arithmetic lives in `timeline.ts` and `transitions.ts`.
 */
import type { StepState } from '@game-sandbox/schema'
import {
  type CameraLimits,
  type CameraView,
  cameraLimits,
  cameraProbeValue,
  fitCamera,
  panCamera,
  pinchCamera,
  viewPoint,
  worldTransform,
  zoomCamera,
} from '@renderers/base/camera.js'
import { type CameraGestures, wireCameraGestures } from '@renderers/base/camera-gestures.js'
import { clear, PixiRenderer } from '@renderers/base/PixiRenderer.js'
import type { RendererDefinition, RenderOptions } from '@renderers/types.js'
import { Assets, Container, Graphics, Sprite, type Texture } from 'pixi.js'

import { type CraneAssetName, craneAssetSources, loadCraneAssets } from './assets.js'
import { drawActivationSeal, drawBattlefield, drawRangeWash, drawZoneMarkers } from './board.js'
import { MONO } from './draw.js'
import { drawHud, drawInspectionCard, type HudPaint } from './hud.js'
import {
  EMPTY_INSPECTION,
  type InspectionEvent,
  type InspectionState,
  inspectionPresentation,
  inspectionTargetLabel,
  pinsInspectionForPointer,
  rangePresentation,
  rangeVisibleDuringEvent,
  reduceInspection,
} from './inspection.js'
import { eventTextMetrics, presentationFor } from './presentation.js'
import { reachableTileKeys } from './reachability.js'
import {
  CRANE_STYLE,
  type CraneReachScene,
  computeScene,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  type SceneEvent,
  type SceneUnit,
} from './scene.js'
import thumbnail from './thumbnail.png'
import {
  type EventTimelineProgress,
  eventBudget,
  eventPhaseAt,
  eventRangeVisibleAt,
  eventTimelineProgress,
  routePositionFor,
  routeTrailFor,
} from './timeline.js'
import {
  captureCueSceneFor,
  captureCuesFor,
  deathSnapshotFor,
  eventHasReaction,
  eventTargetPositionFor,
  isFreshForwardEvent,
  shouldDeferEventUpdate,
  shouldRebuildBattlefield,
  transitionFor,
  transitionSceneFor,
} from './transitions.js'
import { createUnitNode, drawUnit, type UnitNode } from './units.js'

/** A state that arrived while an event was still playing, held until that event finishes. */
interface PendingEventUpdate {
  state: StepState
  options: RenderOptions | undefined
  holdFinalFrame: boolean
}

/** Where an update stands in the deferred-event handoff. The browser suite observes these names. */
type EventHandoff = 'idle' | 'awaiting-final-frame' | 'final-frame-held' | 'pending-installed'

export class CraneReachRenderer extends PixiRenderer {
  readonly internalSize = { width: SCENE_WIDTH, height: SCENE_HEIGHT } as const
  protected override readonly animated = true

  private battlefieldLayer!: Container
  private zoneMarkerLayer!: Container
  private rangeLayer!: Container
  private unitLayer!: Container
  private activationLayer!: Container
  private eventLayer!: Container
  private transientLayer!: Container
  private worldLayer!: Container
  private hudLayer!: Container
  private inspectionLayer!: Container
  private battlefieldKey: string | null = null
  private readonly unitNodes = new Map<string, UnitNode>()
  private readonly textures = new Map<CraneAssetName, Texture>()
  private assetsReady = false
  private battlefieldTextured = false
  private battlefieldBuilds = 0
  private event: SceneEvent | null = null
  private eventProgress = 1
  private eventDurationMs = eventBudget()
  private eventTick: number | null = null
  private previousScene: CraneReachScene | null = null
  private currentScene: CraneReachScene | null = null
  private presentedScene: CraneReachScene | null = null
  private deathSnapshot: SceneUnit | null = null
  private eventAnimating = false
  private pendingEventUpdate: PendingEventUpdate | null = null
  private inspection: InspectionState = EMPTY_INSPECTION
  private camera: CameraView | null = null
  private cameraLimits: CameraLimits | null = null
  private cameraGestures: CameraGestures | null = null
  private cameraRefreshTimer: ReturnType<typeof setTimeout> | null = null

  protected setup(root: Container): void {
    this.battlefieldLayer = new Container()
    this.zoneMarkerLayer = new Container()
    this.rangeLayer = new Container()
    this.unitLayer = new Container()
    this.activationLayer = new Container()
    this.eventLayer = new Container()
    this.transientLayer = new Container()
    this.worldLayer = new Container()
    this.hudLayer = new Container()
    this.inspectionLayer = new Container()
    this.worldLayer.addChild(
      this.battlefieldLayer,
      this.zoneMarkerLayer,
      this.rangeLayer,
      this.unitLayer,
      this.activationLayer,
      this.eventLayer,
      this.transientLayer,
    )
    root.addChild(this.worldLayer, this.hudLayer, this.inspectionLayer)
    root.eventMode = 'passive'
    root.interactiveChildren = true
    const stage = root.parent
    if (stage !== null) {
      stage.eventMode = 'static'
      stage.interactiveChildren = true
    }
    this.cameraGestures = wireCameraGestures(this.ctx.container, {
      toView: (clientPoint) => {
        const bounds = this.ctx.container.getBoundingClientRect()
        const scale = this.displayScale()
        return { x: (clientPoint.x - bounds.left) / scale, y: (clientPoint.y - bounds.top) / scale }
      },
      zoomAt: (factor, anchor) => {
        if (this.camera === null || this.cameraLimits === null) return
        this.camera = zoomCamera(this.camera, this.cameraLimits, this.internalSize, factor, anchor)
        this.applyCamera()
      },
      panBy: (dx, dy) => {
        if (this.camera === null || this.cameraLimits === null) return
        this.camera = panCamera(this.camera, this.cameraLimits, this.internalSize, dx, dy)
        this.applyCamera()
      },
      pinch: (before, after) => {
        if (this.camera === null || this.cameraLimits === null) return
        this.camera = pinchCamera(this.camera, this.cameraLimits, this.internalSize, before, after)
        this.applyCamera()
      },
      reset: () => this.resetCamera(),
    })
    void this.loadTextures()
  }

  protected update(state: StepState, options?: RenderOptions): void {
    const scene = this.sceneFor(state)
    const freshForwardEvent = isFreshForwardEvent(
      this.eventTick,
      state.tick,
      this.event,
      scene.event,
    )
    // Only an explicit seek, mount, or repeat snap stills an event. The OS reduced-motion preference
    // does not: motion is the replay's content, and remote desktop sessions force the preference on.
    const snap = options?.snap === true
    const eventIncomplete =
      this.eventAnimating && this.eventProgress < 1 && this.currentScene !== null
    if (
      shouldDeferEventUpdate(
        eventIncomplete,
        freshForwardEvent,
        snap,
        this.pendingEventUpdate !== null,
      )
    ) {
      if (eventIncomplete) this.completeEvent()
      const holdFinalFrame = this.pendingEventUpdate?.holdFinalFrame ?? true
      this.pendingEventUpdate = {
        state,
        options,
        holdFinalFrame,
      }
      this.setEventHandoff(holdFinalFrame ? 'awaiting-final-frame' : 'final-frame-held')
      return
    }
    this.pendingEventUpdate = null
    this.setEventHandoff('idle')
    this.installSceneUpdate(state, scene, options, freshForwardEvent)
  }

  /** Redraw the retained frame without replacing an active or deferred event with the newest state. */
  protected override refreshVisual(): void {
    const scene = this.presentedScene ?? this.currentScene
    if (scene === null) return
    this.ensureBattlefield(scene)
    this.reconcilePresentedScene(scene, this.eventAnimating)
    this.reconcileEvent()
  }

  protected override onFrame(dtMs: number): boolean {
    if (this.pendingEventUpdate !== null) {
      // The first ticker frame after a deferral holds the completed event so the browser composites
      // it; only the following frame installs the pending event at progress zero.
      if (this.pendingEventUpdate.holdFinalFrame) {
        this.pendingEventUpdate.holdFinalFrame = false
        this.setEventHandoff('final-frame-held')
        return true
      }
      const pending = this.pendingEventUpdate
      this.pendingEventUpdate = null
      const scene = this.sceneFor(pending.state)
      const freshForwardEvent = isFreshForwardEvent(
        this.eventTick,
        pending.state.tick,
        this.event,
        scene.event,
      )
      this.installSceneUpdate(pending.state, scene, pending.options, freshForwardEvent)
      this.setEventHandoff('pending-installed')
      return true
    }
    if (this.event === null || this.eventProgress >= 1) return false
    this.eventProgress = Math.min(1, this.eventProgress + dtMs / this.eventDurationMs)
    if (this.eventProgress < 1) {
      this.updateEventPhaseProbe()
      if (this.presentedScene !== null) {
        this.reconcileEventActivation(this.presentedScene)
        if (
          !rangeVisibleDuringEvent(
            this.inspectedUnit(this.presentedScene) !== null,
            this.eventRangeVisible(),
          )
        ) {
          this.clearRange()
        }
      }
      this.reconcileEvent()
      return true
    }
    this.completeEvent()
    return false
  }

  private sceneFor(state: StepState): CraneReachScene {
    return computeScene(state, {
      terrainEnabled: this.ctx.header.parameters.terrain === true,
      unitAbilities: this.ctx.header.parameters.unit_abilities === true,
    })
  }

  private installSceneUpdate(
    state: StepState,
    scene: CraneReachScene,
    options: RenderOptions | undefined,
    freshForwardEvent: boolean,
  ): void {
    const previousScene = this.currentScene
    this.ensureBattlefield(scene)

    const transition = transitionFor(
      scene.event,
      freshForwardEvent,
      previousScene !== null,
      options,
    )
    const freshForward = transition.animate
    this.previousScene = previousScene
    this.currentScene = scene
    this.eventTick = state.tick
    this.event = scene.event
    this.eventProgress = freshForward ? 0 : 1
    this.eventDurationMs = transition.budgetMs
    this.eventAnimating = freshForward
    this.deathSnapshot = freshForward ? deathSnapshotFor(this.previousScene, scene) : null
    this.updateEventPhaseProbe()

    // A moving event owns the prior frame until its timeline ends. This prevents the next actor,
    // final HUD, and death removal from flashing before the action that produced them is visible.
    const presented = transitionSceneFor(previousScene, scene, freshForward, this.eventProgress)
    this.reconcilePresentedScene(presented, freshForward)
    this.reconcileEvent()
  }

  private completeEvent(): void {
    if (this.currentScene === null) return
    this.eventProgress = 1
    this.eventAnimating = false
    this.setEventHandoff('idle')
    this.updateEventPhaseProbe()
    this.reconcilePresentedScene(this.currentScene, false)
    this.reconcileEvent()
  }

  private reconcilePresentedScene(scene: CraneReachScene, transitioning: boolean): void {
    this.presentedScene = scene
    this.updateInspectionProbe(scene)
    this.reconcileUnits(scene)
    drawZoneMarkers(
      this.zoneMarkerLayer,
      this.sprite,
      scene,
      presentationFor(scene.hexRadius, this.effectiveScale()),
    )
    if (transitioning) {
      this.reconcileEventRange(scene)
      this.reconcileEventActivation(scene)
    } else {
      this.reconcileRange(scene)
      this.reconcileActivation(scene)
    }
    this.reconcileHud(scene)
    this.reconcileInspection(scene)
  }

  private setEventHandoff(value: EventHandoff): void {
    this.ctx.container.dataset.craneEventHandoff = value
  }

  /** What the schedule needs to know about an event: whether it strikes, reacts, and how far it moves. */
  private eventShape(event: SceneEvent): {
    hasTarget: boolean
    hasReaction: boolean
    movementTiles: number
  } {
    return {
      hasTarget: event.targetId !== null,
      hasReaction: eventHasReaction(event),
      movementTiles: event.movementTiles,
    }
  }

  /** Where the event in flight sits on each of its three tracks. */
  private eventTimeline(): EventTimelineProgress {
    const event = this.event
    if (event === null) return { movement: 0, attack: 0, reaction: 0 }
    const shape = this.eventShape(event)
    return eventTimelineProgress(
      this.eventProgress,
      shape.hasTarget,
      shape.hasReaction,
      shape.movementTiles,
    )
  }

  private updateEventPhaseProbe(): void {
    const event = this.event
    if (event === null) {
      this.ctx.container.dataset.craneEventPhase = 'idle'
      delete this.ctx.container.dataset.craneEventActor
      return
    }
    this.ctx.container.dataset.craneEventActor = event.actorId
    const shape = this.eventShape(event)
    this.ctx.container.dataset.craneEventPhase = eventPhaseAt(
      this.eventProgress,
      shape.hasTarget,
      shape.hasReaction,
      this.eventAnimating,
      shape.movementTiles,
    )
  }

  private async loadTextures(): Promise<void> {
    try {
      const sources = craneAssetSources()
      const textures = await loadCraneAssets<Texture>((asset) => Assets.load(sources[asset.name]))
      for (const [name, texture] of Object.entries(textures) as [CraneAssetName, Texture][]) {
        this.textures.set(name, texture)
      }
      this.assetsReady = true
      this.ctx.container.dataset.craneAssets = 'ready'
      this.rerenderCurrentState()
    } catch (error) {
      this.ctx.container.dataset.craneAssets = 'error'
      console.error('Crane Reach could not load its artwork.', error)
    }
  }

  /** Rebuild the static battlefield when the episode changes or its artwork has just arrived. */
  private ensureBattlefield(scene: CraneReachScene): void {
    if (this.battlefieldKey !== scene.battlefieldKey) {
      this.battlefieldBuilds = 0
      this.battlefieldTextured = false
      const tiles = scene.tiles.filter((tile) => tile.terrain !== 'void')
      const horizontalExtent = (Math.sqrt(3) / 2) * scene.hexRadius
      this.cameraLimits = cameraLimits(
        {
          minX: Math.min(...tiles.map((tile) => tile.center.x - horizontalExtent)),
          minY: Math.min(...tiles.map((tile) => tile.center.y - scene.hexRadius)),
          maxX: Math.max(...tiles.map((tile) => tile.center.x + horizontalExtent)),
          maxY: Math.max(...tiles.map((tile) => tile.center.y + scene.hexRadius)),
        },
        this.internalSize,
      )
      this.resetCamera()
    }
    if (
      !shouldRebuildBattlefield(
        this.battlefieldKey,
        scene,
        this.battlefieldTextured,
        this.assetsReady,
      )
    ) {
      return
    }
    if (this.assetsReady) this.battlefieldBuilds += 1
    this.ctx.container.dataset.craneBattlefieldBuilds = String(this.battlefieldBuilds)
    drawBattlefield(this.battlefieldLayer, this.sprite, scene, () =>
      this.setInspection({ type: 'dismiss' }),
    )
    this.battlefieldKey = scene.battlefieldKey
    this.battlefieldTextured = this.assetsReady
  }

  private reconcileUnits(scene: CraneReachScene): void {
    const liveIds = new Set(scene.units.map((unit) => unit.unitId))
    for (const [unitId, node] of this.unitNodes) {
      if (!liveIds.has(unitId)) {
        this.unitNodes.delete(unitId)
        node.root.removeFromParent()
        node.root.destroy({ children: true })
      }
    }
    const level = presentationFor(scene.hexRadius, this.effectiveScale())
    this.ctx.container.dataset.cranePresentation = level
    for (const unit of scene.units) {
      let node = this.unitNodes.get(unit.unitId)
      if (node === undefined) {
        node = createUnitNode(
          unit.unitId,
          (event) => this.setInspection(event),
          pinsInspectionForPointer,
        )
        this.unitNodes.set(unit.unitId, node)
        this.unitLayer.addChild(node.root)
      }
      drawUnit(node, unit, scene.hexRadius, level, this.textureFor)
    }
  }

  private reconcileActivation(scene: CraneReachScene): void {
    clear(this.activationLayer)
    if (scene.activation === null) return
    drawActivationSeal(
      this.activationLayer,
      this.sprite,
      scene.activation.position,
      scene.hexRadius,
    )
  }

  /** During an event the seal travels with the actor instead of sitting on the scene's activation. */
  private reconcileEventActivation(scene: CraneReachScene): void {
    clear(this.activationLayer)
    if (this.event === null) return
    const position = routePositionFor(this.event.route, this.eventTimeline().movement)
    drawActivationSeal(this.activationLayer, this.sprite, position, scene.hexRadius)
  }

  private setInspection(event: InspectionEvent): void {
    if (
      (event.type === 'inspect' || event.type === 'dismiss') &&
      this.cameraGestures?.dragging() === true
    ) {
      return
    }
    this.inspection = reduceInspection(this.inspection, event)
    if (this.presentedScene !== null) {
      if (this.eventAnimating) this.reconcileEventRange(this.presentedScene)
      else this.reconcileRange(this.presentedScene)
      this.reconcileInspection(this.presentedScene)
      this.redrawCurrentFrame()
    }
  }

  private inspectedUnit(scene: CraneReachScene): SceneUnit | null {
    const target = inspectionPresentation(this.inspection).target
    return target?.kind !== 'unit'
      ? null
      : (scene.units.find((unit) => unit.unitId === target.unitId) ?? null)
  }

  /** The range wash follows the inspected unit when there is one, the acting unit otherwise. */
  private reconcileRange(scene: CraneReachScene): void {
    clear(this.rangeLayer)
    if (scene.hud.terminal !== null) {
      this.ctx.container.dataset.craneRangeUnit = 'none'
      return
    }
    const inspected = this.inspectedUnit(scene)
    const unit =
      inspected ??
      (scene.activation === null
        ? null
        : (scene.units.find((candidate) => candidate.unitId === scene.activation?.unitId) ?? null))
    if (unit === null) {
      this.ctx.container.dataset.craneRangeUnit = 'none'
      return
    }
    drawRangeWash(
      this.rangeLayer,
      scene,
      unit.position,
      reachableTileKeys(unit, scene.tiles, scene.units),
      rangePresentation(this.inspection, inspected !== null),
    )
    this.ctx.container.dataset.craneRangeUnit = unit.unitId
  }

  private eventRangeVisible(): boolean {
    return this.event !== null && eventRangeVisibleAt(this.eventProgress, this.event.movementTiles)
  }

  /** The retained acting range stays visible until the event begins resolving. */
  private reconcileEventRange(scene: CraneReachScene): void {
    if (rangeVisibleDuringEvent(this.inspectedUnit(scene) !== null, this.eventRangeVisible())) {
      this.reconcileRange(scene)
    } else {
      this.clearRange()
    }
  }

  private clearRange(): void {
    clear(this.rangeLayer)
    this.ctx.container.dataset.craneRangeUnit = 'none'
  }

  /**
   * Everything that only exists while an event plays: the move trail, the arrow or lunge, the damage
   * numeral, the capture blooms, and the death dissolve. Both layers are rebuilt every frame.
   */
  private reconcileEvent(): void {
    clear(this.eventLayer)
    clear(this.transientLayer)
    if (this.event === null || !this.eventAnimating) return
    const timeline = this.eventTimeline()
    const move = timeline.movement
    const strike = timeline.attack
    const reaction = timeline.reaction
    const hexRadius = this.presentedScene?.hexRadius ?? 10
    const target = this.eventTargetPosition()
    const targetDistance =
      target === null
        ? Number.POSITIVE_INFINITY
        : Math.hypot(target.x - this.event.to.x, target.y - this.event.to.y)
    const melee = targetDistance <= (this.presentedScene?.hexRadius ?? 0) * 1.8
    const event = new Graphics()
    const trail = routeTrailFor(this.event.route, move)
    if (trail.length >= 2 && move < 1) {
      const [first, ...rest] = trail
      if (first !== undefined) {
        event.moveTo(first.x, first.y)
        for (const point of rest) event.lineTo(point.x, point.y)
        event.stroke({ color: CRANE_STYLE.grid, width: 3, alpha: 0.5 * (1 - move) })
      }
    }
    if (target !== null && !melee && strike > 0) {
      // A ranged shot arcs to the side of the straight line, then vanishes on arrival.
      const dx = target.x - this.event.to.x
      const dy = target.y - this.event.to.y
      const length = Math.max(1, Math.hypot(dx, dy))
      const arc = length * 0.12
      event
        .moveTo(this.event.to.x, this.event.to.y)
        .quadraticCurveTo(
          (this.event.to.x + target.x) / 2 - (dy / length) * arc,
          (this.event.to.y + target.y) / 2 + (dx / length) * arc,
          target.x,
          target.y,
        )
        .stroke({ color: CRANE_STYLE.event, width: 1.5, alpha: 1 - strike })
    }
    if (target !== null && this.event.damage > 0 && reaction > 0) {
      // The target flashes bone on impact, then holds a fading ember tint.
      const flash = reaction < 0.25
      event.circle(target.x, target.y, hexRadius * 0.44).fill({
        color: flash ? CRANE_STYLE.text : CRANE_STYLE.danger,
        alpha: flash ? 0.72 * (1 - reaction / 0.25) : 0.5 * (1 - (reaction - 0.25) / 0.75),
      })
    }
    const captureScene = captureCueSceneFor(this.currentScene, this.presentedScene)
    const captureCues = captureScene === null ? [] : captureCuesFor(captureScene, this.event)
    if (reaction > 0) {
      for (const cue of captureCues) {
        event
          .circle(cue.position.x, cue.position.y, hexRadius * (0.18 + reaction * 0.42))
          .stroke({ color: CRANE_STYLE.zoneGlow, width: 3, alpha: 1 - reaction })
      }
    }
    this.eventLayer.addChild(event)
    const textMetrics = eventTextMetrics(this.effectiveScale())
    if (this.event.damage > 0 && reaction > 0) {
      const damage = this.text(
        `-${this.event.damage}`,
        textMetrics.size,
        CRANE_STYLE.danger,
        'center',
        MONO,
        // Keep a two-CSS-pixel opaque edge even when the logical canvas is scaled down.
        { color: '#000000', width: 2 / Math.max(0.01, this.effectiveScale()) },
      )
      damage.resolution = this.textResolution() * (this.camera?.zoom ?? 1)
      damage.position.set(
        target?.x ?? this.event.to.x,
        (target?.y ?? this.event.to.y) - textMetrics.rise * reaction,
      )
      damage.alpha = 1 - reaction
      this.eventLayer.addChild(damage)
    }
    if (reaction > 0) {
      for (const cue of captureCues) {
        const color = cue.side === 'red' ? CRANE_STYLE.red : CRANE_STYLE.blue
        const sign = cue.delta > 0 ? '+' : ''
        const capture = this.text(`${sign}${cue.delta}`, textMetrics.size, color, 'center', MONO)
        capture.resolution = this.textResolution() * (this.camera?.zoom ?? 1)
        capture.position.set(cue.position.x, cue.position.y - textMetrics.rise * reaction)
        capture.alpha = 1 - reaction
        this.eventLayer.addChild(capture)
      }
    }
    const actor = this.unitNodes.get(this.event.actorId)
    if (actor !== undefined) {
      const position = routePositionFor(this.event.route, move)
      let x = position.x
      let y = position.y
      if (target !== null && melee) {
        const lunge = Math.sin(strike * Math.PI) * 0.2
        x += (target.x - this.event.to.x) * lunge
        y += (target.y - this.event.to.y) * lunge
      }
      actor.root.position.set(x, y)
    }
    if (this.event.deathId !== null && reaction > 0) {
      const defeated = this.unitNodes.get(this.event.deathId)
      const defeatedUnit = this.deathSnapshot
      if (defeated !== undefined && defeatedUnit !== null) {
        // The colored prior node remains intact until reaction starts. The reaction replaces it with
        // a dilute-ink snapshot, while final reconciliation performs the actual removal.
        defeated.root.visible = false
        this.drawDeathSnapshot(defeatedUnit, reaction)
      }
    }
  }

  /** The defeated unit in dilute ink, tipping and rising as a wisp before it is simply absent. */
  private drawDeathSnapshot(unit: SceneUnit, reaction: number): void {
    const radius = this.presentedScene?.hexRadius ?? 10
    const level = presentationFor(radius, this.effectiveScale())
    const ghost = createUnitNode(unit.unitId, null, pinsInspectionForPointer)
    drawUnit(ghost, unit, radius, level, this.textureFor, {
      side: CRANE_STYLE.grid,
      deep: CRANE_STYLE.shadow,
      gauge: CRANE_STYLE.mist,
    })
    ghost.root.y -= reaction * 14
    ghost.root.rotation = (unit.side === 'red' ? -1 : 1) * reaction * 0.22
    ghost.root.alpha = 1 - reaction
    this.transientLayer.addChild(ghost.root)
    const wisp = new Graphics()
    wisp
      .moveTo(unit.position.x, unit.position.y - reaction * 14)
      .lineTo(unit.position.x, unit.position.y - 22 - reaction * 20)
      .stroke({ color: CRANE_STYLE.mist, width: 2, alpha: 0.5 * (1 - reaction) })
    this.transientLayer.addChild(wisp)
  }

  private eventTargetPosition(): { x: number; y: number } | null {
    return this.event === null
      ? null
      : eventTargetPositionFor(
          this.event,
          this.currentScene,
          this.previousScene,
          this.deathSnapshot,
        )
  }

  private reconcileHud(scene: CraneReachScene): void {
    clear(this.hudLayer)
    this.ctx.container.dataset.craneHud = 'ready'
    drawHud(this.hudLayer, this.paint(), scene, {
      onInspect: (event) => this.setInspection(event),
      pins: pinsInspectionForPointer,
    })
  }

  private reconcileInspection(scene: CraneReachScene): void {
    clear(this.inspectionLayer)
    this.inspectionLayer.eventMode = 'none'
    delete this.ctx.container.dataset.craneInspectionFields
    delete this.ctx.container.dataset.craneInspectionDetails
    if (scene.hud.terminal !== null) {
      this.ctx.container.dataset.craneInspection = 'none'
      return
    }
    const target = inspectionPresentation(this.inspection).target
    this.ctx.container.dataset.craneInspection = inspectionTargetLabel(target)
    const card = drawInspectionCard(this.inspectionLayer, this.paint(), scene, target, {
      toView: (point) => this.viewPoint(point),
      zoom: this.camera?.zoom ?? 1,
    })
    if (card !== null) {
      this.ctx.container.dataset.craneInspectionFields = card.fields
      if (card.details !== null) this.ctx.container.dataset.craneInspectionDetails = card.details
    }
  }

  /** Anchor for the browser test that hovers a visible unit after camera movement. */
  private updateInspectionProbe(scene: CraneReachScene): void {
    const projected = scene.units.map((unit) => ({ unit, point: this.viewPoint(unit.position) }))
    const visible = projected.filter(
      ({ point }) =>
        point.x >= 0 && point.x <= SCENE_WIDTH && point.y >= 0 && point.y <= SCENE_HEIGHT,
    )
    const stationary = visible.filter(
      ({ unit }) =>
        unit.unitId !== this.event?.actorId && unit.unitId !== this.event?.targetId,
    )
    const probe =
      stationary.find(({ unit }) => unit.type === 'footman') ??
      stationary[0] ??
      visible.find(({ unit }) => unit.type === 'footman') ??
      visible[0] ??
      projected.find(({ unit }) => unit.type === 'footman') ??
      projected[0]
    if (probe === undefined) {
      delete this.ctx.container.dataset.craneInspectUnit
      delete this.ctx.container.dataset.craneInspectUnitX
      delete this.ctx.container.dataset.craneInspectUnitY
      return
    }
    this.ctx.container.dataset.craneInspectUnit = probe.unit.unitId
    this.ctx.container.dataset.craneInspectUnitX = String(probe.point.x)
    this.ctx.container.dataset.craneInspectUnitY = String(probe.point.y)
  }

  /** The board's actual CSS scale combines the host fit and the user camera. */
  private effectiveScale(): number {
    return this.displayScale() * (this.camera?.zoom ?? 1)
  }

  /** Project a world point into the fixed HUD and inspection coordinate space. */
  private viewPoint(point: { x: number; y: number }): { x: number; y: number } {
    const camera = this.camera
    return camera === null ? point : viewPoint(camera, this.internalSize, point)
  }

  /** Apply the camera immediately, then rebuild the retained artwork after gestures settle. */
  private applyCamera(): void {
    if (this.camera === null) return
    const transform = worldTransform(this.camera, this.internalSize)
    this.worldLayer.position.set(transform.x, transform.y)
    this.worldLayer.scale.set(transform.scale)
    this.ctx.container.dataset.craneCamera = cameraProbeValue(this.camera)
    if (this.presentedScene !== null) {
      this.updateInspectionProbe(this.presentedScene)
      this.reconcileInspection(this.presentedScene)
    }
    this.redrawCurrentFrame()
    if (this.cameraRefreshTimer !== null) clearTimeout(this.cameraRefreshTimer)
    this.cameraRefreshTimer = setTimeout(() => {
      this.cameraRefreshTimer = null
      this.rerenderCurrentState()
    }, 100)
  }

  /** Return the current battlefield to the every-tile-visible fit. */
  private resetCamera(): void {
    if (this.cameraLimits === null) return
    this.camera = fitCamera(this.cameraLimits, this.internalSize)
    this.applyCamera()
  }

  override destroy(): void {
    this.cameraGestures?.detach()
    this.cameraGestures = null
    if (this.cameraRefreshTimer !== null) clearTimeout(this.cameraRefreshTimer)
    this.cameraRefreshTimer = null
    super.destroy()
  }

  private paint(): HudPaint {
    return { sprite: this.sprite, text: this.text.bind(this) }
  }

  private readonly sprite = (
    name: CraneAssetName,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Sprite | null => {
    const texture = this.textureFor(name)
    if (texture === null) return null
    const sprite = new Sprite(texture)
    sprite.anchor.set(0.5)
    sprite.position.set(x, y)
    sprite.width = width
    sprite.height = height
    return sprite
  }

  private readonly textureFor = (name: CraneAssetName): Texture | null => {
    return this.textures.get(name) ?? null
  }
}

const definition = {
  key: 'crane-reach-field',
  renderer: CraneReachRenderer,
  thumbnail,
} satisfies RendererDefinition

export default definition
