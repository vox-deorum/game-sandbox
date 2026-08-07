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
  centerCamera,
  fitCamera,
  panCamera,
  pinchCamera,
  viewPoint,
  worldTransform,
  zoomCamera,
} from '@renderers/base/camera.js'
import { type CameraGestures, wireCameraGestures } from '@renderers/base/camera-gestures.js'
import { MoveClock } from '@renderers/base/move-clock.js'
import { clear, PixiRenderer } from '@renderers/base/PixiRenderer.js'
import type { RendererDefinition, RenderOptions } from '@renderers/types.js'
import { Assets, Container, Graphics, Sprite, type Texture } from 'pixi.js'

import { type CraneAssetName, craneAssetSources, loadCraneAssets } from './assets.js'
import { drawActivationSeal, drawBattlefield, drawRangeWash, drawZoneMarkers } from './board.js'
import {
  drawConfirmButton,
  drawFogVeil,
  drawOrderMarks,
  drawOrderPulse,
  FOG_CROSSFADE_MS,
  fogCrossfade,
  type OrderPlan,
  prefersReducedMotion,
  previewPhase,
  REVERT_PULSE_MS,
  revertPulse,
  wireConfirmButton,
  wireOrderHits,
} from './composition.js'
import { MONO } from './draw.js'
import { eventVisible, type Perspective, perspectiveFor, visibleUnits } from './fog.js'
import { drawHud, drawInspectionCard, type HudPaint } from './hud.js'
import {
  EMPTY_INSPECTION,
  type InspectionEvent,
  type InspectionState,
  inspectionPresentation,
  inspectionTargetLabel,
  pinsInspectionForPointer,
  probeExclusions,
  rangePresentation,
  rangeVisibleDuringEvent,
  reduceInspection,
  selectInspectionProbe,
} from './inspection.js'
import { reachableTileKeys, type WalkField, walkFieldFor } from './legality.js'
import {
  beginOrder,
  clickTile,
  endpointOf,
  type OrderComposition,
  offeredTiles,
  orderAction,
  orderTurnOpen,
  type StrikePreview,
  strikePreview,
} from './orders.js'
import { encodePath } from './paths.js'
import { eventTextMetrics, presentationFor } from './presentation.js'
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
  type EventWindows,
  eventActiveTracks,
  eventPhaseAt,
  eventRangeVisibleAt,
  eventScale,
  eventTimelineProgress,
  eventWindows,
  rangedArcAlpha,
  reactionNumeralAlpha,
  routePositionFor,
  routeTrailFor,
} from './timeline.js'
import {
  captureCueSceneFor,
  captureCuesFor,
  deathSnapshotFor,
  eventShapeFor,
  eventTargetPositionFor,
  isFreshForwardEvent,
  shouldAnimateEvent,
  shouldRebuildBattlefield,
  transitionSceneFor,
} from './transitions.js'
import { createUnitNode, drawUnit, type UnitNode } from './units.js'

/**
 * A beat held after an order you gave has finished playing, before the picture moves on to whoever
 * acts next. Without it your own move resolves and the fog switches in the same instant, and the
 * result of what you just did is gone before you have read it.
 */
const OWN_ORDER_SETTLE_MS = 300

export class CraneReachRenderer extends PixiRenderer {
  readonly internalSize = { width: SCENE_WIDTH, height: SCENE_HEIGHT } as const
  protected override readonly animated = true

  private battlefieldLayer!: Container
  private zoneMarkerLayer!: Container
  private fogLayer!: Container
  /** The glaze being cross-dissolved away while a perspective switch settles. */
  private fadingFogLayer!: Container
  private rangeLayer!: Container
  private orderHitLayer!: Container
  private unitLayer!: Container
  private activationLayer!: Container
  private orderMarkLayer!: Container
  /** The strike preview and the revert pulse, which breathe and so are redrawn every frame. */
  private orderPulseLayer!: Container
  /** The confirmation button's artwork, screen-fixed above the world like the rest of the HUD. */
  private orderControlLayer!: Container
  /**
   * The confirmation button's hit target, built once. A hit target rebuilt between a press and its
   * release would never complete a tap, and the clock above it redraws on every frame.
   */
  private orderButtonLayer!: Container
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
  /** How far into the current event's schedule we are, in wall-clock milliseconds. */
  private eventElapsedMs = 0
  private eventSchedule: EventWindows | null = null
  private eventTick: number | null = null
  private previousScene: CraneReachScene | null = null
  private currentScene: CraneReachScene | null = null
  private presentedScene: CraneReachScene | null = null
  private deathSnapshot: SceneUnit | null = null
  private eventAnimating = false
  /** Whether this event resolves an order from a player at this screen, so its result is held. */
  private eventIsOurs = false
  /** What is left of that hold, once the event's own schedule has finished. */
  private settleRemainingMs = 0
  private inspection: InspectionState = EMPTY_INSPECTION
  /** The perspective the presented frame is drawn through; null when nothing is hidden. */
  private perspective: Perspective | null = null
  /** How far into the glaze cross-dissolve a perspective switch is. */
  private fogElapsedMs = FOG_CROSSFADE_MS
  /** The order being composed on a controlled activation, with the field its legality came from. */
  private order: OrderComposition | null = null
  private orderField: WalkField | null = null
  private orderTick: number | null = null
  /** The player whose order the confirmation button sends. */
  private orderPlayerId: string | null = null
  /** The plan the settled marks were last drawn from, reused by the per-frame redraw. */
  private orderPlan: OrderPlan | null = null
  /** The tiles currently wired for clicks, so they are rebuilt only when the set actually changes. */
  private clickableKey: string | null = null
  /** True once this activation's order has been sent, so the controls go inert until the next state. */
  private orderSent = false
  /** Drives the automatic-strike preview's swell. */
  private humanElapsedMs = 0
  /** The tile a step was just taken back from, and how far into its single pulse we are. */
  private revertedTile: string | null = null
  private revertElapsedMs = REVERT_PULSE_MS
  private readonly moveClock = new MoveClock()
  private camera: CameraView | null = null
  private cameraLimits: CameraLimits | null = null
  private cameraGestures: CameraGestures | null = null
  private cameraRefreshTimer: ReturnType<typeof setTimeout> | null = null

  protected setup(root: Container): void {
    this.battlefieldLayer = new Container()
    this.zoneMarkerLayer = new Container()
    this.fogLayer = new Container()
    this.fadingFogLayer = new Container()
    this.rangeLayer = new Container()
    this.orderHitLayer = new Container()
    this.unitLayer = new Container()
    this.activationLayer = new Container()
    this.orderMarkLayer = new Container()
    this.orderPulseLayer = new Container()
    this.orderControlLayer = new Container()
    this.orderButtonLayer = new Container()
    this.eventLayer = new Container()
    this.transientLayer = new Container()
    this.worldLayer = new Container()
    this.hudLayer = new Container()
    this.inspectionLayer = new Container()
    // The order's hit areas sit under the units so a unit stays hoverable, and its marks sit over
    // them so composition always reads above a hover wash. No unit can stand on an offered tile.
    this.orderMarkLayer.eventMode = 'none'
    this.orderPulseLayer.eventMode = 'none'
    this.fogLayer.eventMode = 'none'
    this.fadingFogLayer.eventMode = 'none'
    this.worldLayer.addChild(
      this.battlefieldLayer,
      this.zoneMarkerLayer,
      this.fadingFogLayer,
      this.fogLayer,
      this.rangeLayer,
      this.orderHitLayer,
      this.unitLayer,
      this.activationLayer,
      this.orderMarkLayer,
      this.orderPulseLayer,
      this.eventLayer,
      this.transientLayer,
    )
    root.addChild(
      this.worldLayer,
      this.hudLayer,
      this.orderControlLayer,
      this.orderButtonLayer,
      this.inspectionLayer,
    )
    this.orderButtonLayer.visible = false
    wireConfirmButton(this.orderButtonLayer, () => this.sendOrder())
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
    // A host paces its delivery on this renderer's own completion, so a state normally arrives with
    // nothing in flight. One that arrives anyway (an unpaced live burst) finishes the scene it lands
    // on first, so the interrupted action is fully reconciled rather than left half-drawn beneath the
    // next one. Only an explicit seek, mount, or repeat snap stills an event outright; the OS
    // reduced-motion preference does not, because motion is the replay's content and remote desktop
    // sessions force that preference on.
    if (this.eventAnimating) this.completeEvent()
    this.installSceneUpdate(state, scene, options, freshForwardEvent)
  }

  /** Redraw the retained frame without replacing an in-flight event with the newest state. */
  protected override refreshVisual(): void {
    const scene = this.presentedScene ?? this.currentScene
    if (scene === null) return
    this.ensureBattlefield(scene)
    this.reconcilePresentedScene(scene, this.eventAnimating)
    this.reconcileEvent()
  }

  protected override transitionActive(): boolean {
    return this.eventAnimating
  }

  protected override onFrame(dtMs: number): boolean {
    // Three things can want frames: the event in flight, a perspective switch cross-dissolving, and a
    // live human turn, whose clock drains and whose strike preview breathes for as long as it lasts.
    const event = this.advanceEvent(dtMs)
    const fog = this.advanceFog(dtMs)
    const human = this.advanceHumanTurn(dtMs)
    return event || fog || human
  }

  private advanceEvent(dtMs: number): boolean {
    const schedule = this.eventSchedule
    if (!this.eventAnimating || schedule === null) return false
    if (this.settleRemainingMs > 0) {
      this.settleRemainingMs -= dtMs
      if (this.settleRemainingMs > 0) return true
      this.completeEvent()
      this.followActivation()
      return false
    }
    this.eventElapsedMs = Math.min(schedule.durationMs, this.eventElapsedMs + dtMs)
    if (this.eventElapsedMs < schedule.durationMs) {
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
    if (this.eventIsOurs) {
      // Hold the finished frame for a beat, so your own move lands before the fog follows the next
      // unit. The host waits on the transition, so the session pauses with the picture.
      this.eventIsOurs = false
      this.settleRemainingMs = OWN_ORDER_SETTLE_MS
      return true
    }
    this.completeEvent()
    return false
  }

  /** Cross-dissolve the glaze when the perspective switches, so the picture never pops. */
  private advanceFog(dtMs: number): boolean {
    if (this.fogElapsedMs >= FOG_CROSSFADE_MS) return false
    this.fogElapsedMs = Math.min(FOG_CROSSFADE_MS, this.fogElapsedMs + dtMs)
    this.applyFogCrossfade()
    return this.fogElapsedMs < FOG_CROSSFADE_MS
  }

  /** Keep drawing while a human is on the clock: the perimeter drains and the preview breathes. */
  private advanceHumanTurn(dtMs: number): boolean {
    if (this.order === null || this.presentedScene === null) return false
    this.humanElapsedMs += dtMs
    this.revertElapsedMs = Math.min(REVERT_PULSE_MS, this.revertElapsedMs + dtMs)
    this.refreshOrderFrame(this.presentedScene)
    return true
  }

  /**
   * Redraw only what moves during a human turn: the draining perimeter, the strike preview, and a
   * reverted tile's pulse. The settled marks stay as they are, because they bake text and rebuilding
   * them every frame for a turn that may last a minute would be pure waste.
   */
  private refreshOrderFrame(scene: CraneReachScene): void {
    const plan = this.orderPlan
    if (plan === null) return
    const reducedMotion = prefersReducedMotion()
    const revert =
      this.revertedTile === null
        ? null
        : { tileKey: this.revertedTile, strength: revertPulse(this.revertElapsedMs, reducedMotion) }
    const frame: OrderPlan = { ...plan, revert, clock: this.moveClock.read() }
    this.orderPlan = frame
    clear(this.orderPulseLayer)
    drawOrderPulse(
      this.orderPulseLayer,
      scene,
      frame,
      previewPhase(this.humanElapsedMs, reducedMotion),
    )
    clear(this.orderControlLayer)
    drawConfirmButton(this.orderControlLayer, this.sprite, frame)
    this.ctx.container.dataset.craneClock =
      frame.clock === null ? 'none' : String(frame.clock.seconds)
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

    // A person under fog watches only what their side perceives. An activation resolved out of
    // sight installs its result without animating, so the picture never traces an unseen unit.
    const animate =
      shouldAnimateEvent(scene.event, freshForwardEvent, previousScene !== null, options) &&
      this.eventVisibleDuring(previousScene, scene)
    // Only a genuinely new state reopens the controls. Redrawing the same one (a resize, a camera
    // move settling, artwork arriving) must not let an order already sent be sent a second time.
    if (state.tick !== this.eventTick) this.orderSent = false
    this.previousScene = previousScene
    this.currentScene = scene
    this.eventTick = state.tick
    this.event = scene.event
    this.eventSchedule =
      scene.event === null ? null : eventWindows(eventShapeFor(scene.event), eventScale(options))
    this.eventElapsedMs = animate ? 0 : (this.eventSchedule?.durationMs ?? 0)
    this.eventAnimating = animate
    this.eventIsOurs = animate && this.actorIsControlled(scene)
    this.settleRemainingMs = 0
    this.deathSnapshot = animate ? deathSnapshotFor(this.previousScene, scene) : null
    this.updateEventPhaseProbe()

    // A moving event owns the prior frame until its schedule ends. This prevents the next actor,
    // final HUD, and death removal from flashing before the action that produced them is visible.
    const presented = transitionSceneFor(previousScene, scene, animate)
    this.reconcilePresentedScene(presented, animate)
    this.reconcileEvent()
  }

  /**
   * Bring the unit acting next into the middle of the view, once your own move has landed and its
   * beat has passed. A unit the perspective cannot see is never followed, since panning to it would
   * say where it stands; and at the fitted zoom the whole board is already on screen, so nothing
   * moves there either.
   */
  private followActivation(): void {
    const activation = this.currentScene?.activation
    if (activation === undefined || activation === null) return
    if (this.camera === null || this.cameraLimits === null) return
    if (this.perspective !== null && !this.perspective.units.has(activation.unitId)) return
    this.camera = centerCamera(
      this.camera,
      this.cameraLimits,
      this.internalSize,
      activation.position,
    )
    this.applyCamera()
  }

  /** Whether the activation that just resolved was one a player at this screen ordered. */
  private actorIsControlled(scene: CraneReachScene): boolean {
    const actorId = scene.event?.actorId
    if (actorId === undefined || this.ctx.sendAction === undefined) return false
    const entry = scene.roster.find((slot) => slot.unitId === actorId)
    return entry !== undefined && this.ctx.controlledPlayers.includes(entry.playerId)
  }

  private completeEvent(): void {
    if (this.currentScene === null) return
    this.eventElapsedMs = this.eventSchedule?.durationMs ?? 0
    this.eventAnimating = false
    this.eventIsOurs = false
    this.settleRemainingMs = 0
    this.updateEventPhaseProbe()
    this.reconcilePresentedScene(this.currentScene, false)
    this.reconcileEvent()
  }

  private reconcilePresentedScene(scene: CraneReachScene, transitioning: boolean): void {
    this.presentedScene = scene
    this.reconcileFog(scene)
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
    this.reconcileOrder(scene)
    this.reconcileInspection(scene)
  }

  /** The perspective a frame is drawn through: the fog rule, applied to this viewer. */
  private perspectiveOf(scene: CraneReachScene): Perspective | null {
    return perspectiveFor(scene, this.ctx.controlledPlayers, this.ctx.header.seats)
  }

  /**
   * Whether the resolved activation happened where this viewer could see it.
   *
   * The event plays over the frame that preceded it, so that frame's perspective is the one that
   * decides. Asking the arriving frame instead judges the move through the eyes of whoever acts
   * next, which skips a unit's own move whenever the next unit to act cannot see it.
   */
  private eventVisibleDuring(
    previousScene: CraneReachScene | null,
    scene: CraneReachScene,
  ): boolean {
    return eventVisible(this.perspectiveOf(previousScene ?? scene), scene.event?.actorId ?? null)
  }

  /**
   * Rebuild the glaze, cross-dissolving from the previous one whenever the perspective changes. The
   * observers are the identity of a perspective: the same eyes always see the same ground.
   */
  private reconcileFog(scene: CraneReachScene): void {
    const perspective = this.perspectiveOf(scene)
    const before = this.perspective?.observers.join(' ') ?? 'none'
    const after = perspective?.observers.join(' ') ?? 'none'
    if (before !== after) {
      clear(this.fadingFogLayer)
      for (const child of [...this.fogLayer.children]) this.fadingFogLayer.addChild(child)
      this.fogElapsedMs = 0
    }
    this.perspective = perspective
    clear(this.fogLayer)
    if (perspective !== null) drawFogVeil(this.fogLayer, this.sprite, scene, perspective)
    this.ctx.container.dataset.craneFog = after
    if (before !== after && prefersReducedMotion()) this.fogElapsedMs = FOG_CROSSFADE_MS
    this.applyFogCrossfade()
  }

  private applyFogCrossfade(): void {
    const settled = fogCrossfade(this.fogElapsedMs, prefersReducedMotion())
    this.fogLayer.alpha = settled
    this.fadingFogLayer.alpha = 1 - settled
    if (settled >= 1) clear(this.fadingFogLayer)
  }

  /** Where the event in flight sits on each of its animated tracks. */
  private eventTimeline(): EventTimelineProgress {
    return this.eventSchedule === null
      ? { movement: 0, attack: 0, reaction: 0 }
      : eventTimelineProgress(this.eventElapsedMs, this.eventSchedule)
  }

  /**
   * Publish the event's sequential phase and the set of beats currently running, so the browser suite
   * can assert both the order of the beats and the overlap between the attack and its reaction.
   */
  private updateEventPhaseProbe(): void {
    const event = this.event
    const schedule = this.eventSchedule
    if (event === null || schedule === null) {
      this.ctx.container.dataset.craneEventPhase = 'idle'
      this.ctx.container.dataset.craneEventTracks = ''
      delete this.ctx.container.dataset.craneEventActor
      return
    }
    this.ctx.container.dataset.craneEventActor = event.actorId
    this.ctx.container.dataset.craneEventPhase = eventPhaseAt(
      this.eventElapsedMs,
      schedule,
      this.eventAnimating,
    )
    this.ctx.container.dataset.craneEventTracks = this.eventAnimating
      ? eventActiveTracks(this.eventElapsedMs, schedule).join(' ')
      : ''
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
    // Units outside the perspective are absent, not ghosted: the past lives in a unit's own code.
    const drawn = visibleUnits(scene, this.perspective)
    const liveIds = new Set(drawn.map((unit) => unit.unitId))
    for (const [unitId, node] of this.unitNodes) {
      if (!liveIds.has(unitId)) {
        this.unitNodes.delete(unitId)
        node.root.removeFromParent()
        node.root.destroy({ children: true })
      }
    }
    const level = presentationFor(scene.hexRadius, this.effectiveScale())
    this.ctx.container.dataset.cranePresentation = level
    for (const unit of drawn) {
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
    // The seal names the actor, so it appears only where the perspective can already see it.
    if (this.perspective !== null && !this.perspective.units.has(scene.activation.unitId)) return
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
      : (visibleUnits(scene, this.perspective).find((unit) => unit.unitId === target.unitId) ??
          null)
  }

  /** The range wash follows the inspected unit when there is one, the acting unit otherwise. */
  private reconcileRange(scene: CraneReachScene): void {
    clear(this.rangeLayer)
    if (scene.hud.terminal !== null) {
      this.ctx.container.dataset.craneRangeUnit = 'none'
      return
    }
    const inspected = this.inspectedUnit(scene)
    // An actor the perspective cannot see gets no range wash, which would otherwise trace it.
    const unit =
      inspected ??
      (scene.activation === null
        ? null
        : (visibleUnits(scene, this.perspective).find(
            (candidate) => candidate.unitId === scene.activation?.unitId,
          ) ?? null))
    // While a person is composing this unit's order, the offered continuations are its range, and a
    // second wash under them only flickers as the pointer crosses the unit. Its card still opens.
    if (unit !== null && this.controlledActor(scene)?.unitId === unit.unitId) {
      this.clearRange()
      return
    }
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
    return (
      this.eventSchedule !== null && eventRangeVisibleAt(this.eventElapsedMs, this.eventSchedule)
    )
  }

  /** The retained acting range stays visible until the actor strikes or takes ground. */
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
      // A ranged shot arcs to the side of the straight line, fading as it flies. It is still three
      // quarters visible when the target starts reacting and gone as the attack beat ends.
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
        .stroke({ color: CRANE_STYLE.event, width: 1.5, alpha: rangedArcAlpha(strike) })
    }
    if (target !== null && this.event.damage > 0 && reaction > 0) {
      // The target holds an ember tint that fades over the whole reaction.
      event
        .circle(target.x, target.y, hexRadius * 0.44)
        .fill({ color: CRANE_STYLE.danger, alpha: 0.5 * (1 - reaction) })
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
    // One curve drives both a numeral's opacity and its rise, so it sits still at full strength while
    // it is being read and then lifts away as it fades.
    const numeralFade = reactionNumeralAlpha(reaction)
    const numeralRise = textMetrics.rise * (1 - numeralFade)
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
        (target?.y ?? this.event.to.y) - numeralRise,
      )
      damage.alpha = numeralFade
      this.eventLayer.addChild(damage)
    }
    if (reaction > 0) {
      for (const cue of captureCues) {
        const color = cue.side === 'red' ? CRANE_STYLE.red : CRANE_STYLE.blue
        const sign = cue.delta > 0 ? '+' : ''
        const capture = this.text(`${sign}${cue.delta}`, textMetrics.size, color, 'center', MONO)
        capture.resolution = this.textResolution() * (this.camera?.zoom ?? 1)
        capture.position.set(cue.position.x, cue.position.y - numeralRise)
        capture.alpha = numeralFade
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
    // A living-unit count is knowledge no unit has: an agent is told both starting rosters and sees
    // only what is within vision, so it never learns that an ally or an enemy out of sight has died.
    // Under fog the rosters go, and the strip they occupied carries the order controls instead.
    const rosters = this.perspective === null
    drawHud(this.hudLayer, this.paint(), scene, {
      onInspect: (event) => this.setInspection(event),
      pins: pinsInspectionForPointer,
      rosters,
    })
    this.ctx.container.dataset.craneRosters = rosters ? 'shown' : 'hidden'
  }

  /**
   * The order controls, on a controlled activation and nowhere else. A spectator, a replay viewer, a
   * companion's turn, an opponent's turn, a finished match, and an activation whose order has already
   * been sent all leave the board with nothing clickable on it.
   */
  private reconcileOrder(scene: CraneReachScene): void {
    clear(this.orderMarkLayer)
    clear(this.orderPulseLayer)
    clear(this.orderControlLayer)
    const unit = this.controlledActor(scene)
    if (unit === null) {
      clear(this.orderHitLayer)
      this.clickableKey = null
      this.orderButtonLayer.visible = false
      this.order = null
      this.orderField = null
      this.orderTick = null
      this.orderPlayerId = null
      this.orderPlan = null
      this.moveClock.close()
      const data = this.ctx.container.dataset
      data.craneOrder = 'none'
      data.craneOrderPath = 'none'
      data.craneConfirm = 'none'
      data.craneClock = 'none'
      data.craneStrikePreview = 'none'
      delete data.craneOfferedTile
      delete data.craneOfferedX
      delete data.craneOfferedY
      return
    }
    if (
      this.order === null ||
      this.order.unitId !== unit.unitId ||
      this.orderTick !== this.eventTick
    ) {
      this.orderField = walkFieldFor(unit, scene.tiles, scene.units)
      this.order = beginOrder(unit, this.orderField)
      this.orderTick = this.eventTick
      this.humanElapsedMs = 0
      this.revertedTile = null
    }
    const field = this.orderField as WalkField
    const order = this.order
    this.orderPlayerId = unit.playerId
    this.moveClock.open(String(this.eventTick), this.ctx.meta.human_timeout_ms)

    const offered = new Set(offeredTiles(field, order).keys())
    const endpoint = endpointOf(order)
    const preview = strikePreview(unit, endpoint, visibleUnits(scene, this.perspective))
    const previewPositions = (preview?.targets ?? [])
      .map((unitId) => scene.units.find((candidate) => candidate.unitId === unitId)?.position)
      .filter((position): position is { x: number; y: number } => position !== undefined)
    const plan: OrderPlan = {
      order,
      unitPosition: unit.position,
      offered,
      preview,
      previewPositions,
      revert:
        this.revertedTile === null
          ? null
          : {
              tileKey: this.revertedTile,
              strength: revertPulse(this.revertElapsedMs, prefersReducedMotion()),
            },
      clock: this.moveClock.read(),
    }

    this.orderPlan = plan
    drawOrderMarks(this.orderMarkLayer, this.text.bind(this), scene, plan)
    this.drawEndpointGhost(scene, unit, endpoint)
    // Clicking the endpoint takes a step back and clicking the unit's own tile clears; everything
    // else on the board stays inert, so a composed path can only ever be a legal one.
    const clickable = new Set([...offered, endpoint, order.path.tiles[0] as string])
    const clickableKey = [...clickable].sort().join(' ')
    if (this.clickableKey !== clickableKey) {
      clear(this.orderHitLayer)
      wireOrderHits(this.orderHitLayer, scene, clickable, (tileKey) => this.pickTile(tileKey))
      this.clickableKey = clickableKey
    }
    this.orderButtonLayer.visible = true
    this.publishOrderProbes(scene, plan, offered)
    this.refreshOrderFrame(scene)
  }

  /** The unit this viewer is being asked to order right now, if any. */
  private controlledActor(scene: CraneReachScene): SceneUnit | null {
    const activation = scene.activation
    const open = orderTurnOpen({
      actingPlayerId: activation?.playerId ?? null,
      controlledPlayers: this.ctx.controlledPlayers,
      canSend: this.ctx.sendAction !== undefined,
      terminal: scene.hud.terminal !== null,
      animating: this.eventAnimating,
      sent: this.orderSent,
    })
    if (!open || activation === null) return null
    return scene.units.find((unit) => unit.unitId === activation.unitId) ?? null
  }

  /** The unit shown where it would end up, so the projected final tile reads as a real position. */
  private drawEndpointGhost(scene: CraneReachScene, unit: SceneUnit, endpoint: string): void {
    if (endpoint === unit.tileKey) return
    const tile = scene.tiles.find((candidate) => candidate.key === endpoint)
    if (tile === undefined) return
    const ghost = createUnitNode(unit.unitId, null, pinsInspectionForPointer)
    drawUnit(
      ghost,
      { ...unit, position: tile.center },
      scene.hexRadius,
      presentationFor(scene.hexRadius, this.effectiveScale()),
      this.textureFor,
    )
    ghost.root.alpha = 0.5
    this.orderMarkLayer.addChild(ghost.root)
  }

  private pickTile(tileKey: string): void {
    const field = this.orderField
    const scene = this.presentedScene
    if (this.order === null || field === null || scene === null) return
    if (this.cameraGestures?.dragging() === true) return
    const before = this.order
    this.order = clickTile(field, before, tileKey)
    // A step taken back pulses the tile it left, so a revision is visible without a reset control.
    const reverted = this.order.path.directions.length < before.path.directions.length
    this.revertedTile = reverted ? tileKey : null
    this.revertElapsedMs = 0
    this.humanElapsedMs = 0
    this.reconcileOrder(scene)
    this.redrawCurrentFrame()
  }

  private sendOrder(): void {
    const order = this.order
    const scene = this.presentedScene
    const playerId = this.orderPlayerId
    if (order === null || scene === null || playerId === null) return
    this.ctx.sendAction?.(playerId, orderAction(order))
    this.orderSent = true
    this.reconcileOrder(scene)
    this.redrawCurrentFrame()
  }

  /** What the browser suite reads instead of pixels: the order, what is offered, and the clock. */
  private publishOrderProbes(
    scene: CraneReachScene,
    plan: OrderPlan,
    offered: ReadonlySet<string>,
  ): void {
    const data = this.ctx.container.dataset
    data.craneOrder = plan.order.path.directions.join('')
    data.craneOrderPath = String(encodePath(plan.order.path.directions))
    data.craneConfirm = 'ready'
    data.craneClock = plan.clock === null ? 'none' : String(plan.clock.seconds)
    data.craneStrikePreview = previewProbe(plan.preview)
    const first = scene.tiles.find((tile) => offered.has(tile.key))
    if (first === undefined) {
      delete data.craneOfferedTile
      delete data.craneOfferedX
      delete data.craneOfferedY
      return
    }
    const point = this.viewPoint(first.center)
    data.craneOfferedTile = first.key
    data.craneOfferedX = String(point.x)
    data.craneOfferedY = String(point.y)
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
    const projected = visibleUnits(scene, this.perspective).map((unit) => ({
      unit,
      point: this.viewPoint(unit.position),
    }))
    const excluded = probeExclusions(this.event, this.eventAnimating)
    const probe = selectInspectionProbe(projected, this.internalSize, excluded)
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
      // The offered-tile probe is a view coordinate, so it moves with the camera.
      if (this.order !== null) this.reconcileOrder(this.presentedScene)
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

/** The preview, as one readable value for the browser suite. */
function previewProbe(preview: StrikePreview | null): string {
  if (preview === null) return 'none'
  return `${preview.uncertain ? 'one-of' : 'unique'}:${preview.targets.join(' ')}`
}

const definition = {
  key: 'crane-reach-field',
  renderer: CraneReachRenderer,
  thumbnail,
} satisfies RendererDefinition

export default definition
