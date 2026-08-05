/** The retained Estuary Ink renderer for Skirmish at Crane Reach. */
import type { StepState } from '@game-sandbox/schema'
import { PixiRenderer } from '@renderers/base/PixiRenderer.js'
import type { RendererDefinition, RenderOptions } from '@renderers/types.js'
import { Assets, Container, Graphics, Sprite, Text, type Texture } from 'pixi.js'

import { type CraneAssetName, craneAssetSources, loadCraneAssets } from './assets.js'
import {
  EMPTY_INSPECTION,
  inspectionPresentation,
  inspectionTargetLabel,
  pinsInspectionForPointer,
  rangePresentation,
  reduceInspection,
  type InspectionEvent,
  type InspectionState,
  type RosterInspectionTarget,
} from './inspection.js'
import { reachableTileKeys } from './reachability.js'
import {
  CRANE_STYLE,
  type CraneReachScene,
  computeScene,
  type FeatureName,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  type SceneEvent,
  type SceneUnit,
  type TerrainName,
  unitCardFor,
} from './scene.js'
import thumbnail from './thumbnail.png'

const UNIT_MAX_HIT_POINTS = { footman: 12, archer: 6, cavalry: 10 } as const

/** One type scale keeps the HUD and inspection cards legible at the renderer's common display sizes. */
export const HUD_TEXT_SIZES = {
  roundLabel: 16,
  roundValue: 30,
  score: 26,
  scoreTarget: 20,
  cardHeading: 17,
  cardStat: 17,
  ability: 16,
} as const

export interface LabelRowItemLayout {
  x: number
  y: number
  anchorX: 0 | 0.5 | 1
  anchorY: 0.5
}

export interface LabelRowLayout {
  mark: LabelRowItemLayout
  texts: LabelRowItemLayout[]
}

/** Lay out an icon and its text on one centerline, in either reading direction. */
export function labelRowLayout(
  markX: number,
  centerY: number,
  markWidth: number,
  textWidths: readonly number[],
  direction: 1 | -1 = 1,
  gap = 6,
): LabelRowLayout {
  let cursor = markX + direction * (markWidth / 2 + gap)
  const anchorX = direction === 1 ? 0 : 1
  const texts = textWidths.map((width) => {
    const item = { x: cursor, y: centerY, anchorX, anchorY: 0.5 } as const
    cursor += direction * (width + gap)
    return item
  })
  return {
    mark: { x: markX, y: centerY, anchorX: 0.5, anchorY: 0.5 },
    texts,
  }
}

interface LabelRowText {
  value: string
  size: number
  fill: string
  fontFamily: string
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

/** How one tile mark is drawn. ``alternate`` gives a mark its scattered second tuft. */
interface MarkSpec {
  asset: CraneAssetName
  alternate?: CraneAssetName
  tint: string
  alpha: number
  shape: 'square' | 'wide' | 'tuft' | 'canopy'
}

/** A tile type earns its mark by appearing here. Anything absent draws its wash alone. */
export const TERRAIN_MARKS: Partial<Record<TerrainName, MarkSpec>> = {
  hill: { asset: 'contour', tint: '#8f7550', alpha: 0.88, shape: 'square' },
  water: { asset: 'ripple', tint: CRANE_STYLE.void, alpha: 0.58, shape: 'wide' },
}

export const FEATURE_MARKS: Partial<Record<FeatureName, MarkSpec>> = {
  forest: { asset: 'canopy', tint: CRANE_STYLE.feature.forest, alpha: 0.88, shape: 'canopy' },
  marsh: {
    asset: 'sedgeA',
    alternate: 'sedgeB',
    tint: CRANE_STYLE.feature.marsh,
    alpha: 0.88,
    shape: 'tuft',
  },
  waste: { asset: 'waste', tint: CRANE_STYLE.feature.waste, alpha: 0.88, shape: 'square' },
}

function cubicCoordinate(t: number, first: number, second: number): number {
  const inverse = 1 - t
  return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t
}

/** Evaluate the host curve cubic-bezier(0.2, 0, 0, 1) at a normalized time. */
export function hostEase(time: number): number {
  const x = Math.max(0, Math.min(1, time))
  let parameter = x
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const estimate = cubicCoordinate(parameter, 0.2, 0) - x
    const inverse = 1 - parameter
    const derivative =
      3 * inverse * inverse * 0.2 + 6 * inverse * parameter * (0 - 0.2) + 3 * parameter * parameter
    if (Math.abs(estimate) < 0.00001 || Math.abs(derivative) < 0.00001) break
    parameter = Math.max(0, Math.min(1, parameter - estimate / derivative))
  }
  return cubicCoordinate(parameter, 0, 1)
}

export type PresentationLevel = 'figure' | 'token' | 'compact'

export interface UnitPresentation {
  level: PresentationLevel
  effectiveHexRadius: number
}

/** Choose artwork from the actual CSS size, not logical battlefield geometry. */
export function presentationFor(hexRadius: number, displayScale: number): UnitPresentation {
  const effectiveHexRadius = hexRadius * displayScale
  return {
    level: effectiveHexRadius >= 18 ? 'figure' : effectiveHexRadius >= 12 ? 'token' : 'compact',
    effectiveHexRadius,
  }
}

/** Keep transient event labels and their rise legible in CSS pixels at every presentation level. */
export function eventTextMetrics(displayScale: number): { size: number; rise: number } {
  const scale = Math.max(0.01, displayScale)
  return { size: Math.max(16, 12 / scale), rise: 12 / scale }
}

export interface GaugeState {
  fraction: number
  color: string
  critical: boolean
}

/** The rim is a state gauge. The exact hit point numeral belongs to the step 4.2 hover chip. */
export function gaugeFor(unit: Pick<SceneUnit, 'type' | 'hitPoints'>): GaugeState {
  const fraction = Math.max(0, Math.min(1, unit.hitPoints / UNIT_MAX_HIT_POINTS[unit.type]))
  return {
    fraction,
    color:
      fraction <= 0.25
        ? CRANE_STYLE.danger
        : fraction <= 0.5
          ? CRANE_STYLE.hpLow
          : CRANE_STYLE.text,
    critical: fraction <= 0.25,
  }
}

/** Every Crane event occupies its full host cadence. */
export function eventBudget(options?: RenderOptions): number {
  return options?.transitionMs ?? 1_000
}

export interface EventTimelineProgress {
  movement: number
  attack: number
  reaction: number
}

export type EventPhase = 'idle' | 'activation' | 'movement' | 'settle' | 'resolution'

export interface EventTimelineBounds {
  activationEnd: number
  movementEnd: number
  resolutionStart: number
  reactionStart: number
}

/**
 * Express the one-second choreography as normalized values, allowing the host to scale it without
 * changing the relative beats. Movement grows from 350 ms for one tile to 600 ms for four tiles.
 */
export function eventTimelineBounds(movementTiles: number): EventTimelineBounds {
  const tiles = Math.max(0, Math.min(4, Math.floor(movementTiles)))
  const movementEndMs = tiles === 0 ? 150 : 500 + ((tiles - 1) * 250) / 3
  const resolutionStartMs = tiles === 0 ? 650 : 650 + ((tiles - 1) * 100) / 3
  return {
    activationEnd: 0.15,
    movementEnd: movementEndMs / 1_000,
    resolutionStart: resolutionStartMs / 1_000,
    reactionStart: resolutionStartMs / 1_000 + (1 - resolutionStartMs / 1_000) * 0.25,
  }
}

/**
 * Hold the activation seal before movement. Targeted and capture events pause at the destination so
 * movement settles visibly before the attack or capture reaction begins.
 */
export function eventTimelineProgress(
  progress: number,
  hasTarget: boolean,
  hasReaction = hasTarget,
  movementTiles = 1,
): EventTimelineProgress {
  const value = Math.max(0, Math.min(1, progress))
  const bounds = eventTimelineBounds(movementTiles)
  return {
    movement: movementTiles > 0 ? phase(value, bounds.activationEnd, bounds.movementEnd) : 0,
    attack: hasTarget ? hostEase(phase(value, bounds.resolutionStart, 1)) : 0,
    reaction: hasReaction
      ? hostEase(phase(value, hasTarget ? bounds.reactionStart : bounds.resolutionStart, 1))
      : 0,
  }
}

/** Classify the current sequential phase for browser diagnostics and focused ordering tests. */
export function eventPhaseAt(
  progress: number,
  hasTarget: boolean,
  hasReaction = hasTarget,
  animating = true,
  movementTiles = 1,
): EventPhase {
  if (!animating || progress >= 1) return 'idle'
  const bounds = eventTimelineBounds(movementTiles)
  if (progress < bounds.activationEnd) return 'activation'
  if (movementTiles > 0 && progress < bounds.movementEnd) return 'movement'
  if (hasReaction && progress >= bounds.resolutionStart) return 'resolution'
  return 'settle'
}

/** Move through each entered tile in equal time, applying the host curve independently per leg. */
export function routePositionFor(
  route: ReadonlyArray<{ x: number; y: number }>,
  movementProgress: number,
): { x: number; y: number } {
  const first = route[0]
  if (first === undefined || route.length < 2) return first ?? { x: 0, y: 0 }
  const segments = route.length - 1
  const scaled = Math.max(0, Math.min(1, movementProgress)) * segments
  const index = Math.min(segments - 1, Math.floor(scaled))
  const start = route[index] as { x: number; y: number }
  const end = route[index + 1] as { x: number; y: number }
  const localProgress = scaled === segments ? 1 : scaled - index
  const eased = hostEase(localProgress)
  return { x: start.x + (end.x - start.x) * eased, y: start.y + (end.y - start.y) * eased }
}

/** Return the entered route points plus the animated actor position for a contiguous trail. */
export function routeTrailFor(
  route: ReadonlyArray<{ x: number; y: number }>,
  movementProgress: number,
): Array<{ x: number; y: number }> {
  if (route.length < 2 || movementProgress <= 0) return []
  const segments = route.length - 1
  const scaled = Math.max(0, Math.min(1, movementProgress)) * segments
  const completed = Math.min(segments, Math.floor(scaled))
  const points = route.slice(0, completed + 1).map((point) => ({ ...point }))
  if (completed < segments && scaled > completed) points.push(routePositionFor(route, movementProgress))
  return points
}

function eventHasReaction(event: SceneEvent): boolean {
  return event.targetId !== null || event.redCapture !== 0 || event.blueCapture !== 0
}

/** Retain the prior pure scene until the transition has completely settled. */
export function transitionSceneFor(
  previousScene: CraneReachScene | null,
  finalScene: CraneReachScene,
  animate: boolean,
  progress: number,
): CraneReachScene {
  return animate && progress < 1 && previousScene !== null ? previousScene : finalScene
}

/** Transition eligibility keeps mount, seeks, and repeated ticks deterministic. */
export function transitionFor(
  event: SceneEvent | null,
  freshForwardEvent: boolean,
  hasPriorScene: boolean,
  options: RenderOptions | undefined,
): { budgetMs: number; animate: boolean } {
  const budgetMs = eventBudget(options)
  return {
    budgetMs,
    animate:
      event !== null &&
      freshForwardEvent &&
      hasPriorScene &&
      options?.snap !== true &&
      budgetMs > 0,
  }
}

/** Recognize a new forward state while rejecting repeats and backward seeks. */
export function isFreshForwardEvent(
  previousTick: number | null,
  nextTick: number,
  previousEvent: SceneEvent | null,
  nextEvent: SceneEvent | null,
): boolean {
  if (previousTick === null || nextEvent === null) return false
  return nextTick > previousTick || (nextTick === previousTick && previousEvent === null)
}

/** A fresh nonsnap event waits for the in-flight or already-deferred event to paint its final frame. */
export function shouldDeferEventUpdate(
  eventIncomplete: boolean,
  freshForwardEvent: boolean,
  immediate: boolean,
  hasPendingUpdate: boolean,
): boolean {
  return !immediate && freshForwardEvent && (eventIncomplete || hasPendingUpdate)
}

/** Static terrain survives state changes and rebuilds only for a new battlefield identity. */
export function shouldRebuildBattlefield(
  previousKey: string | null,
  scene: CraneReachScene,
  battlefieldTextured: boolean,
  assetsReady: boolean,
): boolean {
  return previousKey !== scene.battlefieldKey || (assetsReady && !battlefieldTextured)
}

/** A fresh forward death borrows the defeated figure from the preceding pure frame. */
export function deathSnapshotFor(
  previousScene: CraneReachScene | null,
  scene: CraneReachScene,
): SceneUnit | null {
  const deathId = scene.event?.deathId
  if (deathId === null || deathId === undefined || previousScene === null) return null
  return previousScene.units.find((candidate) => candidate.unitId === deathId) ?? null
}

/** Resolve a target across the final scene and the retained death snapshot for every tween frame. */
export function eventTargetPositionFor(
  event: SceneEvent,
  currentScene: CraneReachScene | null,
  previousScene: CraneReachScene | null,
  deathSnapshot: SceneUnit | null,
): { x: number; y: number } | null {
  if (event.targetId === null) return null
  return (
    currentScene?.units.find((unit) => unit.unitId === event.targetId)?.position ??
    previousScene?.units.find((unit) => unit.unitId === event.targetId)?.position ??
    (deathSnapshot?.unitId === event.targetId ? deathSnapshot.position : null)
  )
}

export interface CaptureCue {
  side: 'red' | 'blue'
  delta: number
  position: { x: number; y: number }
}

/** Place each side's aggregate capture change on the zone it most clearly controls. */
export function captureCuesFor(scene: CraneReachScene, event: SceneEvent): CaptureCue[] {
  const cues = (['red', 'blue'] as const).flatMap((side) => {
    const delta = side === 'red' ? event.redCapture : event.blueCapture
    if (delta === 0) return []
    const ranked = scene.zones
      .map((zone) => {
        const tileKeys = new Set(zone.tileKeys)
        const balance = scene.units.reduce(
          (score, unit) =>
            tileKeys.has(unit.tileKey) ? score + (unit.side === side ? 1 : -1) : score,
          0,
        )
        return {
          zone,
          balance,
          distance: Math.hypot(zone.center.x - event.to.x, zone.center.y - event.to.y),
        }
      })
      .sort(
        (left, right) =>
          right.balance - left.balance ||
          left.distance - right.distance ||
          left.zone.key.localeCompare(right.zone.key),
      )
    const position = ranked[0]?.zone.center ?? event.to
    return [{ side, delta, position: { ...position } }]
  })
  if (
    cues.length === 2 &&
    cues[0] !== undefined &&
    cues[1] !== undefined &&
    cues[0].position.x === cues[1].position.x &&
    cues[0].position.y === cues[1].position.y
  ) {
    cues[0].position.x -= scene.hexRadius * 0.28
    cues[1].position.x += scene.hexRadius * 0.28
  }
  return cues
}

/** Capture ownership is a result of the completed action, so placement reads final occupancy. */
export function captureCueSceneFor(
  finalScene: CraneReachScene | null,
  presentedScene: CraneReachScene | null,
): CraneReachScene | null {
  return finalScene ?? presentedScene
}

interface UnitNode {
  root: Container
  unitId: string
  shadowArt: Sprite
  shadow: Graphics
  body: Graphics
  artEdge: Sprite
  art: Sprite
}

interface DeathSnapshot {
  unit: SceneUnit
}

interface PendingEventUpdate {
  state: StepState
  options: RenderOptions | undefined
  holdFinalFrame: boolean
}

interface UnitPalette {
  side: string
  deep: string
  gauge: string
}

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
  private deathSnapshot: DeathSnapshot | null = null
  private eventAnimating = false
  private pendingEventUpdate: PendingEventUpdate | null = null
  private inspection: InspectionState = EMPTY_INSPECTION

  protected setup(root: Container): void {
    this.battlefieldLayer = new Container()
    this.zoneMarkerLayer = new Container()
    this.rangeLayer = new Container()
    this.unitLayer = new Container()
    this.activationLayer = new Container()
    this.eventLayer = new Container()
    this.transientLayer = new Container()
    this.hudLayer = new Container()
    this.inspectionLayer = new Container()
    root.addChild(
      this.battlefieldLayer,
      this.zoneMarkerLayer,
      this.rangeLayer,
      this.unitLayer,
      this.activationLayer,
      this.eventLayer,
      this.transientLayer,
      this.hudLayer,
      this.inspectionLayer,
    )
    root.eventMode = 'passive'
    root.interactiveChildren = true
    const stage = root.parent
    if (stage !== null) {
      stage.eventMode = 'static'
      stage.interactiveChildren = true
    }
    void this.loadTextures()
  }

  protected update(state: StepState, options?: RenderOptions): void {
    const scene = computeScene(state, { unitAbilities: this.ctx.header.parameters.unit_abilities === true })
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
      this.ctx.container.dataset.craneEventHandoff = holdFinalFrame
        ? 'awaiting-final-frame'
        : 'final-frame-held'
      return
    }
    this.pendingEventUpdate = null
    this.ctx.container.dataset.craneEventHandoff = 'idle'
    this.installSceneUpdate(state, scene, options, freshForwardEvent)
  }

  /** Redraw the retained frame without replacing an active or deferred event with the newest state. */
  protected override refreshVisual(): void {
    const scene = this.presentedScene ?? this.currentScene
    if (scene === null) return
    if (this.battlefieldKey !== scene.battlefieldKey) {
      this.battlefieldBuilds = 0
      this.battlefieldTextured = false
    }
    if (
      shouldRebuildBattlefield(
        this.battlefieldKey,
        scene,
        this.battlefieldTextured,
        this.assetsReady,
      )
    ) {
      this.rebuildBattlefield(scene)
      this.battlefieldKey = scene.battlefieldKey
      this.battlefieldTextured = this.assetsReady
    }
    this.reconcilePresentedScene(scene, this.eventAnimating)
    this.reconcileEvent()
  }

  protected override onFrame(dtMs: number): boolean {
    if (this.pendingEventUpdate !== null) {
      // The first ticker frame after a deferral holds the completed event so the browser composites
      // it; only the following frame installs the pending event at progress zero.
      if (this.pendingEventUpdate.holdFinalFrame) {
        this.pendingEventUpdate.holdFinalFrame = false
        this.ctx.container.dataset.craneEventHandoff = 'final-frame-held'
        return true
      }
      const pending = this.pendingEventUpdate
      this.pendingEventUpdate = null
      const scene = computeScene(pending.state, {
        unitAbilities: this.ctx.header.parameters.unit_abilities === true,
      })
      const freshForwardEvent = isFreshForwardEvent(
        this.eventTick,
        pending.state.tick,
        this.event,
        scene.event,
      )
      this.installSceneUpdate(pending.state, scene, pending.options, freshForwardEvent)
      this.ctx.container.dataset.craneEventHandoff = 'pending-installed'
      return true
    }
    if (this.event === null || this.eventProgress >= 1) return false
    this.eventProgress = Math.min(1, this.eventProgress + dtMs / this.eventDurationMs)
    if (this.eventProgress < 1) {
      this.updateEventPhaseProbe()
      if (this.presentedScene !== null) this.reconcileEventActivation(this.presentedScene)
      this.reconcileEvent()
      return true
    }
    this.completeEvent()
    return false
  }

  private installSceneUpdate(
    state: StepState,
    scene: CraneReachScene,
    options: RenderOptions | undefined,
    freshForwardEvent: boolean,
  ): void {
    const previousScene = this.currentScene
    if (this.battlefieldKey !== scene.battlefieldKey) {
      this.battlefieldBuilds = 0
      this.battlefieldTextured = false
    }
    if (
      shouldRebuildBattlefield(
        this.battlefieldKey,
        scene,
        this.battlefieldTextured,
        this.assetsReady,
      )
    ) {
      this.rebuildBattlefield(scene)
      this.battlefieldKey = scene.battlefieldKey
      this.battlefieldTextured = this.assetsReady
    }

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
    this.deathSnapshot = freshForward ? this.snapshotDeath(scene) : null
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
    this.ctx.container.dataset.craneEventHandoff = 'idle'
    this.updateEventPhaseProbe()
    this.reconcilePresentedScene(this.currentScene, false)
    this.reconcileEvent()
  }

  private reconcilePresentedScene(scene: CraneReachScene, transitioning: boolean): void {
    this.presentedScene = scene
    this.updateInspectionProbe(scene)
    this.reconcileUnits(scene)
    this.reconcileZoneMarkers(scene)
    if (transitioning) {
      clear(this.rangeLayer)
      this.reconcileEventActivation(scene)
    } else {
      this.reconcileRange(scene)
      this.reconcileActivation(scene)
    }
    this.reconcileHud(scene)
    this.reconcileInspection(scene)
  }

  private updateEventPhaseProbe(): void {
    const event = this.event
    this.ctx.container.dataset.craneEventPhase =
      event === null
        ? 'idle'
        : eventPhaseAt(
            this.eventProgress,
            event.targetId !== null,
            eventHasReaction(event),
            this.eventAnimating,
            event.movementTiles,
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

  private rebuildBattlefield(scene: CraneReachScene): void {
    if (this.assetsReady) this.battlefieldBuilds += 1
    this.ctx.container.dataset.craneBattlefieldBuilds = String(this.battlefieldBuilds)
    clear(this.battlefieldLayer)
    const board = new Graphics()
    board.eventMode = 'static'
    board.on('pointertap', () => this.setInspection({ type: 'dismiss' }))
    board.rect(0, 0, scene.width, scene.height).fill(CRANE_STYLE.backdrop)
    const outer = scene.tiles.filter((tile) => tile.terrain !== 'void')
    const field = bleedPolygon(
      convexHull(outer.flatMap((tile) => tile.corners)),
      scene.hexRadius,
      5,
    )
    board.poly(points(field)).fill(CRANE_STYLE.board)
    for (const tile of outer) {
      board.poly(points(tile.corners)).fill(CRANE_STYLE.terrain[tile.terrain])
      board.poly(points(tile.corners)).stroke({ color: CRANE_STYLE.grid, width: 1.5, alpha: 0.55 })
    }
    this.battlefieldLayer.addChild(board)

    const paper = this.sprite(
      'paperField',
      SCENE_WIDTH / 2,
      SCENE_HEIGHT / 2,
      SCENE_WIDTH,
      SCENE_HEIGHT,
    )
    if (paper !== null) {
      paper.alpha = 0.26
      paper.blendMode = 'multiply'
      const mask = new Graphics().poly(points(field)).fill('#ffffff')
      paper.mask = mask
      this.battlefieldLayer.addChild(mask)
      this.battlefieldLayer.addChild(paper)
    }
    for (const tile of outer) this.drawTerrainMark(tile, scene.hexRadius)
    this.drawBoundaryAndMist(outer, scene.hexRadius)
    this.drawZones(scene)
  }

  private drawTerrainMark(tile: CraneReachScene['tiles'][number], radius: number): void {
    const wash = this.sprite(
      ['washHexA', 'washHexB', 'washHexC'][hash(tile.key) % 3] as CraneAssetName,
      tile.center.x,
      tile.center.y,
      radius * 2,
      radius * 2,
    )
    if (wash !== null) {
      wash.tint = CRANE_STYLE.terrain[tile.terrain]
      wash.alpha = tile.terrain === 'grass' ? 0.3 : 0.5
      wash.rotation = (hash(`${tile.key}:turn`) % 6) * (Math.PI / 3)
      this.battlefieldLayer.addChild(wash)
    }
    // Terrain draws first so a feature sitting on a hill reads over its contours. Grass and
    // the empty feature carry no mark: the muted reed wash leaves room for the salient ones.
    const terrainMark = TERRAIN_MARKS[tile.terrain]
    if (terrainMark !== undefined) this.drawMark(terrainMark, tile, radius)
    const featureMark = FEATURE_MARKS[tile.feature]
    if (featureMark !== undefined) this.drawMark(featureMark, tile, radius)
  }

  private drawMark(
    spec: MarkSpec,
    tile: CraneReachScene['tiles'][number],
    radius: number,
  ): void {
    const alternate = spec.alternate
    const flipped = alternate !== undefined && hash(tile.key) % 2 !== 0
    const width =
      spec.shape === 'canopy'
        ? Math.sqrt(3) * radius * 0.75
        : spec.shape === 'wide'
          ? radius * 1.4
          : radius * 1.45
    const height = spec.shape === 'wide' ? width / 3 : spec.shape === 'tuft' ? width / 2 : width
    const sprite = this.sprite(
      flipped && alternate !== undefined ? alternate : spec.asset,
      tile.center.x,
      tile.center.y,
      width,
      height,
    )
    if (sprite !== null) {
      sprite.tint = spec.tint
      sprite.alpha = spec.alpha
      this.battlefieldLayer.addChild(sprite)
    }
    if (alternate === undefined || hash(`${tile.key}:second-sedge`) % 2 !== 0) return
    const second = this.sprite(
      flipped ? spec.asset : alternate,
      tile.center.x + radius * 0.2,
      tile.center.y + radius * 0.12,
      width * 0.72,
      height * 0.72,
    )
    if (second !== null) {
      second.tint = spec.tint
      second.alpha = 0.78
      this.battlefieldLayer.addChild(second)
    }
  }

  private drawBoundaryAndMist(tiles: CraneReachScene['tiles'], radius: number): void {
    const byKey = new Set(tiles.map((tile) => tile.key))
    const boundaryEdges: Array<{
      key: string
      tile: CraneReachScene['tiles'][number]
      current: { x: number; y: number }
      next: { x: number; y: number }
    }> = []
    for (const tile of tiles) {
      for (let index = 0; index < tile.corners.length; index += 1) {
        const next = tile.corners[(index + 1) % tile.corners.length]
        const current = tile.corners[index]
        if (next === undefined || current === undefined) continue
        const [dq, dr] = HEX_DIRECTIONS[index] as readonly [number, number]
        if (!byKey.has(`${tile.q + dq},${tile.r + dr}`)) {
          boundaryEdges.push({ key: `${tile.key}:${index}`, tile, current, next })
          const stroke = this.sprite(
            'edgeStroke',
            (current.x + next.x) / 2,
            (current.y + next.y) / 2,
            radius * 1.75,
            radius * 0.28,
          )
          if (stroke !== null) {
            stroke.tint = CRANE_STYLE.grid
            stroke.alpha = 0.64
            stroke.rotation = Math.atan2(next.y - current.y, next.x - current.x)
            this.battlefieldLayer.addChild(stroke)
          }
        }
      }
    }
    for (const [index, edge] of boundaryEdges
      .sort((left, right) => hash(left.key) - hash(right.key))
      .slice(0, 6)
      .entries()) {
      const midpoint = {
        x: (edge.current.x + edge.next.x) / 2,
        y: (edge.current.y + edge.next.y) / 2,
      }
      const normal = {
        x: midpoint.x - edge.tile.center.x,
        y: midpoint.y - edge.tile.center.y,
      }
      const normalLength = Math.max(1, Math.hypot(normal.x, normal.y))
      const mist = this.sprite(
        index % 2 === 0 ? 'mistBandA' : 'mistBandB',
        midpoint.x + (normal.x / normalLength) * radius * 0.25,
        midpoint.y + (normal.y / normalLength) * radius * 0.25,
        radius * 3.8,
        radius * 1.4,
      )
      if (mist !== null) {
        mist.tint = CRANE_STYLE.mist
        mist.alpha = 0.2
        mist.rotation = Math.atan2(edge.next.y - edge.current.y, edge.next.x - edge.current.x)
        this.battlefieldLayer.addChild(mist)
      }
    }
  }

  private drawZones(scene: CraneReachScene): void {
    const tilesByKey = new Map(scene.tiles.map((tile) => [tile.key, tile]))
    const wash = new Graphics()
    this.battlefieldLayer.addChild(wash)
    for (const zone of scene.zones) {
      for (const key of zone.tileKeys) {
        const tile = tilesByKey.get(key)
        if (tile !== undefined)
          wash.poly(points(tile.corners)).fill({ color: CRANE_STYLE.zone, alpha: 0.16 })
      }
      wash
        .circle(zone.center.x, zone.center.y, scene.hexRadius * 0.18)
        .fill({ color: CRANE_STYLE.zoneGlow, alpha: 0.38 })
      const zoneTiles = zone.tileKeys
        .map((key) => tilesByKey.get(key))
        .filter((tile): tile is CraneReachScene['tiles'][number] => tile !== undefined)
      const zoneKeys = new Set(zoneTiles.map((tile) => tile.key))
      for (const tile of zoneTiles) {
        for (let index = 0; index < tile.corners.length; index += 1) {
          const [dq, dr] = HEX_DIRECTIONS[index] as readonly [number, number]
          if (zoneKeys.has(`${tile.q + dq},${tile.r + dr}`)) continue
          const current = tile.corners[index]
          const next = tile.corners[(index + 1) % tile.corners.length]
          if (current === undefined || next === undefined) continue
          const dash = this.sprite(
            'zoneDash',
            (current.x + next.x) / 2,
            (current.y + next.y) / 2,
            scene.hexRadius * 1.6,
            scene.hexRadius * 0.2,
          )
          if (dash !== null) {
            dash.tint = CRANE_STYLE.zoneGlow
            dash.rotation = Math.atan2(next.y - current.y, next.x - current.x)
            this.battlefieldLayer.addChild(dash)
          }
        }
      }
    }
  }

  private reconcileZoneMarkers(scene: CraneReachScene): void {
    clear(this.zoneMarkerLayer)
    const level = presentationFor(scene.hexRadius, this.displayScale()).level
    for (const zone of scene.zones) {
      const marker =
        level === 'figure'
          ? this.sprite(
              'pennant',
              zone.center.x,
              zone.center.y - scene.hexRadius * 0.14,
              scene.hexRadius * 0.48,
              scene.hexRadius * 0.65,
            )
          : this.sprite(
              'sealRing',
              zone.center.x,
              zone.center.y,
              scene.hexRadius * 0.82,
              scene.hexRadius * 0.82,
            )
      if (marker !== null) {
        marker.tint = CRANE_STYLE.zone
        this.zoneMarkerLayer.addChild(marker)
      }
    }
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
    const presentation = presentationFor(scene.hexRadius, this.displayScale())
    this.ctx.container.dataset.cranePresentation = presentation.level
    for (const unit of scene.units) {
      let node = this.unitNodes.get(unit.unitId)
      if (node === undefined) {
        node = this.createUnitNode(unit.unitId)
        this.unitNodes.set(unit.unitId, node)
        this.unitLayer.addChild(node.root)
      }
      this.drawUnit(node, unit, scene.hexRadius, presentation.level)
    }
  }

  private createUnitNode(unitId: string, inspectable = true): UnitNode {
    const root = new Container()
    if (inspectable) {
      root.eventMode = 'static'
      root.cursor = 'pointer'
      root.on('pointerover', () => this.setInspection({ type: 'hover-unit', unitId }))
      root.on('pointerout', () => this.setInspection({ type: 'hover-unit', unitId: null }))
      root.on('pointertap', (event) => {
        event.stopPropagation()
        if (!pinsInspectionForPointer(event.pointerType)) return
        this.setInspection({ type: 'inspect', target: { kind: 'unit', unitId } })
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

  private drawUnit(
    node: UnitNode,
    unit: SceneUnit,
    hexRadius: number,
    level: PresentationLevel,
    palette?: UnitPalette,
  ): void {
    const side = palette?.side ?? (unit.side === 'red' ? CRANE_STYLE.red : CRANE_STYLE.blue)
    const deep = palette?.deep ?? (unit.side === 'red' ? CRANE_STYLE.redDeep : CRANE_STYLE.blueDeep)
    const radius = Math.max(
      5,
      hexRadius * (level === 'figure' ? 0.55 : level === 'token' ? 0.62 : 0.36),
    )
    const unitGauge = gaugeFor(unit)
    const gauge = palette === undefined ? unitGauge : { ...unitGauge, color: palette.gauge }
    node.root.position.set(unit.position.x, unit.position.y)
    node.root.visible = true
    node.root.alpha = 1
    node.root.rotation = 0
    const shadowTexture = this.textureFor('shadowOval')
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
      const texture = this.textureFor(figureAsset(unit.type))
      if (texture !== null) {
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
      const texture = this.textureFor(glyphAsset(unit.type))
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

  private reconcileActivation(scene: CraneReachScene): void {
    clear(this.activationLayer)
    if (scene.activation === null) return
    this.drawActivation(scene.activation.position, scene.hexRadius)
  }

  private reconcileEventActivation(scene: CraneReachScene): void {
    clear(this.activationLayer)
    if (this.event === null) return
    const timeline = eventTimelineProgress(
      this.eventProgress,
      this.event.targetId !== null,
      eventHasReaction(this.event),
      this.event.movementTiles,
    )
    const position = routePositionFor(this.event.route, timeline.movement)
    this.drawActivation(position, scene.hexRadius)
  }

  private drawActivation(position: { x: number; y: number }, hexRadius: number): void {
    const glow = new Graphics()
    glow
      .circle(position.x, position.y, hexRadius * 0.74)
      .fill({ color: CRANE_STYLE.activation, alpha: 0.12 })
    glow
      .circle(position.x, position.y, hexRadius * 0.82)
      .stroke({ color: CRANE_STYLE.activation, width: Math.max(2, hexRadius * 0.08) })
    this.activationLayer.addChild(glow)
    const ring = this.sprite(
      'sealRing',
      position.x,
      position.y,
      hexRadius * 1.8,
      hexRadius * 1.8,
    )
    if (ring !== null) {
      ring.tint = CRANE_STYLE.activation
      this.activationLayer.addChild(ring)
    }
  }

  private setInspection(event: InspectionEvent): void {
    this.inspection = reduceInspection(this.inspection, event)
    if (this.presentedScene !== null) {
      if (this.eventAnimating) clear(this.rangeLayer)
      else this.reconcileRange(this.presentedScene)
      this.reconcileInspection(this.presentedScene)
      this.redrawCurrentFrame()
    }
  }

  private inspectedUnit(scene: CraneReachScene): SceneUnit | null {
    const target = inspectionPresentation(this.inspection).target
    return target?.kind !== 'unit'
      ? null
      : scene.units.find((unit) => unit.unitId === target.unitId) ?? null
  }

  private reconcileRange(scene: CraneReachScene): void {
    clear(this.rangeLayer)
    if (scene.hud.terminal !== null) return
    const inspected = this.inspectedUnit(scene)
    const unit = inspected ?? (scene.activation === null ? null : scene.units.find((candidate) => candidate.unitId === scene.activation?.unitId) ?? null)
    if (unit === null) return
    const presentation = rangePresentation(this.inspection, inspected !== null)
    const color = presentation.wash === 'bone' ? CRANE_STYLE.text : CRANE_STYLE.activation
    const outlineColor = presentation.outlineInk === 'dilute-ink' ? CRANE_STYLE.grid : CRANE_STYLE.activation
    const reachable = reachableTileKeys(unit, scene.tiles, scene.units)
    const range = new Graphics()
    for (const tile of scene.tiles) {
      if (!reachable.has(tile.key)) continue
      range.poly(points(tile.corners)).fill({ color, alpha: presentation.alpha })
      for (let index = 0; index < tile.corners.length; index += 1) {
        const [dq, dr] = HEX_DIRECTIONS[index] as readonly [number, number]
        if (reachable.has(`${tile.q + dq},${tile.r + dr}`)) continue
        const current = tile.corners[index]
        const next = tile.corners[(index + 1) % tile.corners.length]
        if (current !== undefined && next !== undefined)
          drawRangeEdge(range, current, next, outlineColor, presentation.outline === 'dashed')
      }
    }
    this.rangeLayer.addChild(range)
    if (presentation.ring) {
      const ring = new Graphics()
      ring
        .circle(unit.position.x, unit.position.y, scene.hexRadius * 0.69)
        .stroke({ color: CRANE_STYLE.text, width: Math.max(2, scene.hexRadius * 0.055) })
      this.rangeLayer.addChild(ring)
    }
  }

  private reconcileEvent(): void {
    clear(this.eventLayer)
    clear(this.transientLayer)
    if (this.event === null || !this.eventAnimating) return
    const progress = this.eventProgress
    const timeline = eventTimelineProgress(
      progress,
      this.event.targetId !== null,
      eventHasReaction(this.event),
      this.event.movementTiles,
    )
    const move = timeline.movement
    const strike = timeline.attack
    const reaction = timeline.reaction
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
      const flash = reaction < 0.25
      event.circle(target.x, target.y, (this.presentedScene?.hexRadius ?? 10) * 0.44).fill({
        color: flash ? CRANE_STYLE.text : CRANE_STYLE.danger,
        alpha: flash ? 0.72 * (1 - reaction / 0.25) : 0.5 * (1 - (reaction - 0.25) / 0.75),
      })
    }
    const captureScene = captureCueSceneFor(this.currentScene, this.presentedScene)
    const captureCues = captureScene === null ? [] : captureCuesFor(captureScene, this.event)
    if (reaction > 0) {
      for (const cue of captureCues) {
        event
          .circle(
            cue.position.x,
            cue.position.y,
            (this.presentedScene?.hexRadius ?? 10) * (0.18 + reaction * 0.42),
          )
          .stroke({ color: CRANE_STYLE.zoneGlow, width: 3, alpha: 1 - reaction })
      }
    }
    this.eventLayer.addChild(event)
    const textMetrics = eventTextMetrics(this.displayScale())
    if (this.event.damage > 0 && reaction > 0) {
      const damage = this.makeText(
        `-${this.event.damage}`,
        textMetrics.size,
        CRANE_STYLE.danger,
        'center',
        'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        // Keep a two-CSS-pixel opaque edge even when the logical canvas is scaled down.
        { color: '#000000', width: 2 / Math.max(0.01, this.displayScale()) },
      )
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
        const capture = this.makeText(`${sign}${cue.delta}`, textMetrics.size, color, 'center', mono())
        capture.position.set(
          cue.position.x,
          cue.position.y - textMetrics.rise * reaction,
        )
        capture.alpha = 1 - reaction
        this.eventLayer.addChild(capture)
      }
    }
    const actor = this.unitNodes.get(this.event.actorId)
    this.ctx.container.dataset.craneEventActor = this.event.actorId
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
      this.ctx.container.dataset.craneEventActorPosition = `${x.toFixed(2)},${y.toFixed(2)}`
    } else {
      this.ctx.container.dataset.craneEventActorPosition = 'missing'
    }
    if (this.event.deathId !== null && reaction > 0) {
      const defeated = this.unitNodes.get(this.event.deathId)
      const defeatedUnit = this.deathSnapshot?.unit
      if (defeated !== undefined && defeatedUnit !== undefined) {
        // The colored prior node remains intact until reaction starts. The reaction replaces it with
        // a dilute-ink snapshot, while final reconciliation performs the actual removal.
        defeated.root.visible = false
        this.drawDeathSnapshot(defeatedUnit, reaction)
      }
    }
  }

  private drawDeathSnapshot(unit: SceneUnit, reaction: number): void {
    const radius = this.presentedScene?.hexRadius ?? 10
    const level = presentationFor(radius, this.displayScale()).level
    const ghost = this.createUnitNode(unit.unitId, false)
    this.drawUnit(ghost, unit, radius, level, {
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
          this.deathSnapshot?.unit ?? null,
        )
  }

  private snapshotDeath(scene: CraneReachScene): DeathSnapshot | null {
    const unit = deathSnapshotFor(this.previousScene, scene)
    return unit === null ? null : { unit }
  }

  private reconcileHud(scene: CraneReachScene): void {
    clear(this.hudLayer)
    this.ctx.container.dataset.craneHud = 'ready'
    const roundLabel = this.makeText(
      'ROUND',
      HUD_TEXT_SIZES.roundLabel,
      CRANE_STYLE.mutedText,
      'left',
      lato(),
    )
    const round = this.makeText(
      String(scene.hud.round),
      HUD_TEXT_SIZES.roundValue,
      CRANE_STYLE.text,
      'left',
      mono(),
    )
    roundLabel.position.set(28, 28)
    round.position.set(28, 43)
    this.hudLayer.addChild(roundLabel, round)
    if (scene.hud.capture !== null) this.drawCaptureStrip(scene.hud.capture)
    this.drawRoster(scene, 'red')
    this.drawRoster(scene, 'blue')
  }

  private reconcileInspection(scene: CraneReachScene): void {
    clear(this.inspectionLayer)
    this.inspectionLayer.eventMode = 'none'
    delete this.ctx.container.dataset.craneInspectionFields
    if (scene.hud.terminal !== null) {
      this.ctx.container.dataset.craneInspection = 'none'
      return
    }
    const target = inspectionPresentation(this.inspection).target
    this.ctx.container.dataset.craneInspection = inspectionTargetLabel(target)
    if (target?.kind === 'unit') {
      const unit = scene.units.find((candidate) => candidate.unitId === target.unitId)
      if (unit !== undefined) this.drawUnitCard(scene, unit)
    } else if (target?.kind === 'roster') {
      this.drawRosterCard(scene, target)
    }
  }

  private updateInspectionProbe(scene: CraneReachScene): void {
    const unit = scene.units[0]
    if (unit === undefined) {
      delete this.ctx.container.dataset.craneInspectUnit
      delete this.ctx.container.dataset.craneInspectUnitX
      delete this.ctx.container.dataset.craneInspectUnitY
      return
    }
    this.ctx.container.dataset.craneInspectUnit = unit.unitId
    this.ctx.container.dataset.craneInspectUnitX = String(unit.position.x)
    this.ctx.container.dataset.craneInspectUnitY = String(unit.position.y)
  }

  private drawCaptureStrip(capture: { red: number; blue: number; target: number }): void {
    const group = new Container()
    const entries = [
      { side: 'red' as const, value: capture.red, x: SCENE_WIDTH - 258 },
      { side: 'blue' as const, value: capture.blue, x: SCENE_WIDTH - 150 },
    ]
    for (const entry of entries) {
      this.drawLabelRow(group, {
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
            fontFamily: mono(),
          },
        ],
        gap: 7,
      })
    }
    const target = this.makeText(
      `/ ${capture.target}`,
      HUD_TEXT_SIZES.scoreTarget,
      CRANE_STYLE.mutedText,
      'left',
      mono(),
    )
    target.anchor.set(0, 0.5)
    target.position.set(SCENE_WIDTH - 83, 43)
    group.addChild(target)
    this.hudLayer.addChild(group)
  }

  private drawRoster(scene: CraneReachScene, side: 'red' | 'blue'): void {
    const types: SceneUnit['type'][] = ['footman', 'archer', 'cavalry']
    const direction = side === 'red' ? 1 : -1
    const start = side === 'red' ? 28 : SCENE_WIDTH - 28
    for (const [index, type] of types.entries()) {
      const x = start + direction * index * 78
      const pair = new Container()
      this.drawLabelRow(pair, {
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
            fontFamily: mono(),
          },
        ],
        gap: 4,
      })
      if (scene.hud.terminal === null) {
        const hit = new Graphics()
        const hitX = direction === 1 ? x - 4 : x - 64
        hit.roundRect(hitX, 780, 68, 48, 6).fill({ color: CRANE_STYLE.board, alpha: 0.001 })
        hit.eventMode = 'static'
        hit.cursor = 'pointer'
        hit.on('pointerover', () => {
          this.setInspection({ type: 'hover-roster', target: { kind: 'roster', side, type } })
        })
        hit.on('pointerout', () => this.setInspection({ type: 'hover-roster', target: null }))
        hit.on('pointertap', (event) => {
          event.stopPropagation()
          if (!pinsInspectionForPointer(event.pointerType)) return
          this.setInspection({ type: 'inspect', target: { kind: 'roster', side, type } })
        })
        pair.addChild(hit)
      }
      this.hudLayer.addChild(pair)
    }
  }

  private drawUnitCard(scene: CraneReachScene, unit: SceneUnit): void {
    const x = Math.min(SCENE_WIDTH - 254, Math.max(18, unit.position.x + scene.hexRadius * 0.75))
    const y = Math.min(670, Math.max(106, unit.position.y - scene.hexRadius * 1.2))
    this.drawCard(x, y, unit.unitId, mono(), unit.type, unit.hitPoints, scene.hud.unitAbilities)
  }

  private drawRosterCard(scene: CraneReachScene, target: RosterInspectionTarget): void {
    const x = target.side === 'red' ? 28 : SCENE_WIDTH - 254
    this.drawCard(x, 656, target.type.toUpperCase(), lato(), target.type, null, scene.hud.unitAbilities)
  }

  private drawCard(
    x: number,
    y: number,
    title: string,
    titleFont: string,
    type: SceneUnit['type'],
    currentHitPoints: number | null,
    abilities: boolean,
  ): void {
    const height = abilities && type !== 'archer' ? 150 : 128
    const card = new Container()
    const parchment = new Graphics()
    parchment
      .roundRect(x, y, 236, height, 7)
      .fill({ color: CRANE_STYLE.board, alpha: 0.97 })
      .stroke({ color: CRANE_STYLE.grid, width: 2, alpha: 0.85 })
    card.addChild(parchment)
    const heading = this.makeText(
      title,
      HUD_TEXT_SIZES.cardHeading,
      CRANE_STYLE.shadow,
      'left',
      titleFont,
    )
    heading.position.set(x + 14, y + 12)
    card.addChild(heading)
    const specification = unitCardFor(type, currentHitPoints, abilities)
    for (const [index, field] of specification.fields.entries()) {
      const column = index % 2
      const row = Math.floor(index / 2)
      this.drawStat(
        card,
        field.icon,
        field.label,
        field.value,
        x + 14 + column * 108,
        y + 47 + row * 28,
      )
    }
    if (specification.ability !== null) {
      const ability = this.makeText(
        specification.ability,
        HUD_TEXT_SIZES.ability,
        CRANE_STYLE.grid,
        'left',
        lato(),
      )
      ability.anchor.set(0, 0.5)
      ability.position.set(x + 14, y + 130)
      card.addChild(ability)
    }
    this.ctx.container.dataset.craneInspectionFields = specification.fields
      .map((field) => `${field.icon}:${field.label}`)
      .join(',')
    card.eventMode = 'none'
    this.inspectionLayer.addChild(card)
  }

  private drawStat(
    card: Container,
    icon: CraneAssetName,
    label: string,
    value: string,
    x: number,
    y: number,
  ): void {
    this.drawLabelRow(card, {
      markX: x + 9,
      centerY: y,
      mark: { kind: 'asset', name: icon, width: 19, height: 19, tint: CRANE_STYLE.grid },
      texts: [
        {
          value: label,
          size: HUD_TEXT_SIZES.cardStat,
          fill: CRANE_STYLE.grid,
          fontFamily: lato(),
          layoutWidth: 40,
        },
        {
          value,
          size: HUD_TEXT_SIZES.cardStat,
          fill: CRANE_STYLE.shadow,
          fontFamily: mono(),
        },
      ],
      gap: 4,
    })
  }

  private drawLabelRow(parent: Container, options: LabelRowOptions): void {
    const direction = options.direction ?? 1
    const texts = options.texts.map((item) =>
      this.makeText(
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
      const mark = this.sprite(
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
      mark
        .circle(layout.mark.x, layout.mark.y, options.mark.diameter / 2)
        .fill(options.mark.color)
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

  private sprite(
    name: CraneAssetName,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Sprite | null {
    const texture = this.textureFor(name)
    if (texture === null) return null
    const sprite = new Sprite(texture)
    sprite.anchor.set(0.5)
    sprite.position.set(x, y)
    sprite.width = width
    sprite.height = height
    return sprite
  }

  private textureFor(name: CraneAssetName): Texture | null {
    return this.textures.get(name) ?? null
  }

  private displayScale(): number {
    const width = this.ctx.container.getBoundingClientRect().width
    return width > 0 ? width / SCENE_WIDTH : 1
  }

  private makeText(
    value: string,
    size: number,
    fill: string,
    align: 'left' | 'center' | 'right',
    fontFamily = 'system-ui, sans-serif',
    stroke?: { color: string; width: number },
  ): Text {
    const text = new Text({
      text: value,
      style: { fontFamily, fontWeight: 'bold', fontSize: size, fill, stroke },
    })
    text.resolution = this.textResolution()
    text.anchor.set(
      align === 'left' ? 0 : align === 'right' ? 1 : 0.5,
      align === 'center' ? 0.5 : 0,
    )
    return text
  }
}

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
    for (let index = 0; index < 4; index += 1) {
      const segment = start + index * Math.PI * 0.5
      graphics
        .arc(0, 0, radius * 1.15, segment, segment + Math.PI * 0.25)
        .stroke({ color: gauge.color, width: Math.max(1, radius * 0.07) })
    }
  }
}

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

function figureAsset(type: SceneUnit['type']): CraneAssetName {
  return type === 'footman' ? 'figFootman' : type === 'archer' ? 'figArcher' : 'figCavalry'
}

function lato(): string {
  return 'Lato, system-ui, sans-serif'
}

function mono(): string {
  return 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
}

function glyphAsset(type: SceneUnit['type']): CraneAssetName {
  return type === 'footman' ? 'glyphSword' : type === 'archer' ? 'glyphBow' : 'glyphHorse'
}

function phase(progress: number, start: number, end: number): number {
  return Math.max(0, Math.min(1, (progress - start) / (end - start)))
}

function hash(value: string): number {
  let total = 2166136261
  for (const char of value) total = Math.imul(total ^ char.charCodeAt(0), 16777619)
  return total >>> 0
}

const HEX_DIRECTIONS = [
  [1, -1],
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
] as const

function convexHull(points: ReadonlyArray<{ x: number; y: number }>): { x: number; y: number }[] {
  const sorted = [...points].sort((left, right) => left.x - right.x || left.y - right.y)
  const cross = (
    origin: { x: number; y: number },
    left: { x: number; y: number },
    right: { x: number; y: number },
  ) => (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x)
  const half = (source: ReadonlyArray<{ x: number; y: number }>) => {
    const hull: { x: number; y: number }[] = []
    for (const point of source) {
      while (
        hull.length >= 2 &&
        cross(
          hull[hull.length - 2] as { x: number; y: number },
          hull[hull.length - 1] as { x: number; y: number },
          point,
        ) <= 0
      )
        hull.pop()
      hull.push(point)
    }
    return hull
  }
  return [...half(sorted).slice(0, -1), ...half([...sorted].reverse()).slice(0, -1)]
}

function bleedPolygon(
  points: ReadonlyArray<{ x: number; y: number }>,
  radius: number,
  bleed: number,
): { x: number; y: number }[] {
  const center = points.reduce(
    (total, point) => ({
      x: total.x + point.x / points.length,
      y: total.y + point.y / points.length,
    }),
    { x: 0, y: 0 },
  )
  return points.map((point) => {
    const length = Math.hypot(point.x - center.x, point.y - center.y)
    const scale = length === 0 ? 1 : (length + Math.min(bleed, radius * 0.12)) / length
    return {
      x: center.x + (point.x - center.x) * scale,
      y: center.y + (point.y - center.y) * scale,
    }
  })
}

function points(corners: ReadonlyArray<{ x: number; y: number }>): number[] {
  return corners.flatMap((corner) => [corner.x, corner.y])
}

/** The hovered range reads as a hand-dashed dilute-ink perimeter, not a grid of hex outlines. */
function drawRangeEdge(
  graphics: Graphics,
  start: { x: number; y: number },
  end: { x: number; y: number },
  color: string,
  dashed: boolean,
): void {
  if (!dashed) {
    graphics.moveTo(start.x, start.y).lineTo(end.x, end.y).stroke({ color, width: 1.2, alpha: 0.72 })
    return
  }
  const length = Math.hypot(end.x - start.x, end.y - start.y)
  const segments = Math.max(2, Math.floor(length / 10))
  for (let index = 0; index < segments; index += 2) {
    const from = index / segments
    const to = Math.min(1, (index + 0.62) / segments)
    graphics
      .moveTo(start.x + (end.x - start.x) * from, start.y + (end.y - start.y) * from)
      .lineTo(start.x + (end.x - start.x) * to, start.y + (end.y - start.y) * to)
      .stroke({ color, width: 1.5, alpha: 0.82 })
  }
}

function clear(layer: Container): void {
  for (const child of layer.removeChildren()) child.destroy({ children: true })
}

const definition = {
  key: 'crane-reach-field',
  renderer: CraneReachRenderer,
  thumbnail,
} satisfies RendererDefinition

export default definition
