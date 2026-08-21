import type { StepState } from '@game-sandbox/schema'
import {
  type CameraLimits,
  type CameraView,
  cameraLimits,
  cameraProbeValue,
  panCamera,
  pinchCamera,
  worldTransform,
  zoomCamera,
} from '@renderers/base/camera.js'
import { type CameraGestures, wireCameraGestures } from '@renderers/base/camera-gestures.js'
import { PixiRenderer, type RendererTextFactory } from '@renderers/base/PixiRenderer.js'
import type { TiledGround } from '@renderers/base/tiled-ground.js'
import type { RendererContext, RendererDefinition, RenderOptions } from '@renderers/types.js'
import { Assets, Container, Graphics, Texture } from 'pixi.js'

// Atlas manifest and art live beside the barrel; the build and the atlas CLI resolve them from the
// renderer root.
import thumbnail from './assets/thumbnail.png'
import { loadThreeBranchesRuntimeAssets } from './assets.js'

// buildings/
import {
  createRoofArt,
  createRoofLayer,
  drawBuildings,
  type RoofLayer,
} from './buildings/buildings.js'

// characters/
import {
  type CharacterLayer,
  createCharacterArt,
  createCharacterLayer,
} from './characters/characters.js'

// core/
import { runArtLoad } from './core/art-loading.js'
import {
  HEARTHSIDE_STYLE,
  measureDeliveryGap,
  smoothedDeliveryGapMs,
  THREE_BRANCHES_PRESENTATION,
  transitionDurationMs,
} from './core/presentation.js'
import type { CollisionShape, FrameScene, StaticScene, WorldPoint } from './core/types.js'

// map/
import {
  advanceVisitorReturn,
  beginVisitorReturn,
  initialVisitorCamera,
  recenterVisitorCamera,
  suspendVisitorFollow,
  updateVisitorCamera,
  type VisitorCameraState,
} from './map/camera.js'
import { collisionWithPropStates, frameCollision, staticCollision } from './map/collision.js'
import { type CollisionLayer, createCollisionLayer } from './map/collision-layer.js'
import { drawMap, drawUpperWalls, type MapLayerView } from './map/map-layer.js'
import { buildStaticScene, computeScene, interpolateScene } from './map/scene.js'
import { createWorldArtStack, type WorldArtStack } from './map/world-stack.js'

// props/
import {
  createPropArt,
  createPropLayer,
  hasSustainedPropEffectTransition,
  type PropLayer,
} from './props/props-layer.js'

// terrain/
import { createTerrainArt } from './terrain/terrain-art.js'

// ui/
import {
  type AnnotationLayer,
  createAnnotationLayer,
  createExpressionArt,
  nameplateAlpha,
} from './ui/annotations.js'
import {
  type ChromeLayer,
  COLLISION_TOGGLE_RECT,
  createChrome,
  RECENTER_RECT,
} from './ui/chrome.js'
import { isTextEntry } from './ui/input.js'
import { CATALOG, expectedCharacterIds, readSpeech, readStatic } from './ui/overlay.js'
import { plateProbe, within } from './ui/palette.js'
import { propUseShapes, selectUseTarget } from './ui/use-preview.js'
import { createVisitorInput, type VisitorInputController } from './ui/visitor-input.js'

const CONTENT_SIZE = {
  width: THREE_BRANCHES_PRESENTATION.internalSize.width,
  height:
    THREE_BRANCHES_PRESENTATION.internalSize.height - THREE_BRANCHES_PRESENTATION.chromeHeight,
}
const MANUAL_CAMERA_QUIET_MS = 200
const VISITOR_PLAYER = 'player_0'

interface MovementTransition {
  from: FrameScene
  to: FrameScene
  elapsedMs: number
  durationMs: number
}

/** The configurable watch and replay renderer for Days at Three Branches. */
export class ThreeBranchesRenderer extends PixiRenderer {
  /** Fixed logical drawing surface advertised to the host layout. */
  readonly internalSize = THREE_BRANCHES_PRESENTATION.internalSize
  /** Character motion advances from the renderer-owned Pixi ticker between delivered states. */
  protected override readonly animated = true

  private readonly expectedIds: readonly string[]
  private readonly staticScene: StaticScene
  private readonly staticCollisionShapes: readonly CollisionShape[]
  private readonly propShapes: readonly CollisionShape[]
  private world!: WorldArtStack
  private worldRoot!: Container
  private characterLayer!: Container
  private upperLayer!: Container
  private mapView!: MapLayerView
  private upperGround: TiledGround | null = null
  private buildingOutlines!: Container
  private collision!: CollisionLayer
  private props!: PropLayer
  private roofs!: RoofLayer
  private lastRoofTick: number | null = null
  private characters!: CharacterLayer
  private annotations!: AnnotationLayer
  private chrome!: ChromeLayer
  private cameraLimits!: CameraLimits
  private visitorCamera!: VisitorCameraState
  private readonly returnsCameraDuringPlay: boolean
  private manualCameraQuietUntilMs = 0
  private cameraReturnRequested = false
  private cameraGestures: CameraGestures | null = null
  private collisionVisible = false
  private correctedOpeningTarget = false
  private currentScene: FrameScene | null = null
  private presentedScene: FrameScene | null = null
  private movement: MovementTransition | null = null
  private settleRemainingMs = 0
  private collisionTextZoom = Number.NaN
  private lastDeliveryAtMs: number | null = null
  /** EMA-smoothed delivery gap that paces character motion, or null before the first measured gap. */
  private gapEstimateMs: number | null = null
  /** Whether the previous frame drew a bubble, so the frame that retires the last one still repaints. */
  private wasSpeaking = false
  private visitorInput: VisitorInputController | null = null
  /** The visitor's latest landed pose. Input composition and the use preview never interpolate. */
  private landedVisitor: { point: WorldPoint; heading: number } | null = null

  /** Parse immutable renderer inputs before Pixi builds the retained scene. */
  constructor(ctx: RendererContext) {
    super(ctx)
    this.returnsCameraDuringPlay =
      ctx.sendAction !== undefined && ctx.controlledPlayers.includes(VISITOR_PLAYER)
    // Header data is immutable for the mount. Dynamic states never need to repeat village geometry.
    const village = readStatic(ctx.header)
    this.expectedIds = expectedCharacterIds(ctx.header)
    this.staticScene = buildStaticScene(village)
    this.staticCollisionShapes = staticCollision(this.staticScene)
    this.propShapes = propUseShapes(this.staticScene, this.staticCollisionShapes)
  }

  protected setup(root: Container): void {
    const createText: RendererTextFactory = (...args) => this.text(...args)
    const backdrop = new Graphics()
      .rect(0, 0, this.internalSize.width, this.internalSize.height)
      .fill(HEARTHSIDE_STYLE.palette.backdrop)
    const contentMask = new Graphics()
      .rect(0, THREE_BRANCHES_PRESENTATION.chromeHeight, CONTENT_SIZE.width, CONTENT_SIZE.height)
      .fill('#ffffff')
    const chromeLayer = new Container()
    // The fixed input layer (pad and palette) sits above the world and below the chrome strip.
    const padLayer = new Container()
    const paletteLayer = new Container()
    const inputLayer = new Container()
    inputLayer.addChild(padLayer, paletteLayer)
    this.mapView = drawMap(this.staticScene)
    this.world = createWorldArtStack(this.mapView)
    this.characterLayer = this.world.characters
    this.upperLayer = this.world.upper
    this.worldRoot = this.world.root
    this.worldRoot.mask = contentMask
    root.addChild(backdrop, contentMask, this.worldRoot, inputLayer, chromeLayer)

    this.buildingOutlines = drawBuildings(this.upperLayer, this.staticScene)
    this.roofs = createRoofLayer(this.world.roofs, this.staticScene)
    this.props = createPropLayer(
      {
        scenery: this.world.scenery,
        shadows: this.world.shadows,
        props: this.world.props,
        effects: this.world.effects,
        emissives: this.world.emissives,
        highlight: this.world.highlight,
      },
      this.staticScene,
    )
    this.characters = createCharacterLayer(this.characterLayer)
    this.annotations = createAnnotationLayer(this.world.annotations, createText)
    this.collision = createCollisionLayer(this.world.collision, createText)
    this.collision.setVisible(this.collisionVisible)
    this.chrome = createChrome(chromeLayer, createText)

    this.cameraLimits = cameraLimits(
      { minX: 0, minY: 0, maxX: this.staticScene.world.width, maxY: this.staticScene.world.height },
      CONTENT_SIZE,
      {
        padding: THREE_BRANCHES_PRESENTATION.cameraPadding,
        maxZoomFactor: THREE_BRANCHES_PRESENTATION.maxZoomFactor,
      },
    )
    this.visitorCamera = initialVisitorCamera(
      this.cameraLimits,
      CONTENT_SIZE,
      this.staticScene.spawn,
    )
    this.applyCamera()
    this.wireCamera(root)
    this.ctx.container.dataset.threeBranchesGround = 'ready'
    this.ctx.container.dataset.threeBranchesAssets = 'loading'
    this.ctx.container.dataset.threeBranchesCollision = this.collisionVisible ? 'on' : 'off'
    this.ctx.container.dataset.threeBranchesCollisionToggle = plateProbe(COLLISION_TOGGLE_RECT)
    this.ctx.container.dataset.threeBranchesRecenter = plateProbe(RECENTER_RECT)
    this.visitorInput = createVisitorInput({
      container: this.ctx.container,
      controlledPlayers: this.ctx.controlledPlayers,
      sendAction: this.ctx.sendAction,
      padLayer,
      paletteLayer,
      createText,
      toView: (client) => this.viewPoint(client),
      currentHeading: () => this.landedVisitor?.heading ?? 0,
      resolution: () => this.textResolution(),
      previewTarget: () =>
        selectUseTarget(
          this.staticScene,
          this.propShapes,
          this.landedVisitor?.point ?? this.staticScene.spawn,
        ),
      targetTransition: (propId) => {
        const prop = this.staticScene.props.find((item) => item.id === propId)
        const kind =
          prop === undefined ? undefined : CATALOG.props.find((item) => item.token === prop.type)
        return kind?.transition ?? 'none'
      },
      onPreview: (propId) => {
        this.props.highlight(propId)
        this.redrawCurrentFrame()
      },
      redraw: () => this.redrawCurrentFrame(),
    })
    void this.loadArt()
  }

  protected update(state: StepState, options?: RenderOptions): void {
    const delivery = measureDeliveryGap(this.lastDeliveryAtMs, performance.now(), options)
    if (delivery.gapMs !== undefined) {
      this.gapEstimateMs = smoothedDeliveryGapMs(this.gapEstimateMs, delivery.gapMs)
    }
    this.lastDeliveryAtMs = delivery.nextMs
    const scene = computeScene(state, this.staticScene, this.expectedIds)
    this.currentScene = scene
    const landedVisitor = scene.characters.find((character) => character.id === VISITOR_PLAYER)
    if (landedVisitor !== undefined) {
      this.landedVisitor = { point: landedVisitor.point, heading: landedVisitor.heading }
    }
    // A connection that re-delivers the current recorded tick re-presents the same frame, so the
    // roof snaps to its occupancy rather than replaying the fade.
    const dynamicTick = scene.dynamic?.tick
    const snapRoofs =
      options?.snap === true ||
      options?.seek === true ||
      this.presentedScene === null ||
      (dynamicTick !== undefined && dynamicTick === this.lastRoofTick)
    if (dynamicTick !== undefined) this.lastRoofTick = dynamicTick
    this.roofs.setTargets(scene, snapRoofs)
    // A snap re-presentation (resize, DPR change, asset redraw) is not a landed transport frame, so
    // it must not compose or send an action; only real states advance the live input window. The
    // frame itself always lands, so a terminal frame still ends the session's input.
    this.visitorInput?.handleFrame(scene.dynamic?.terminal ?? false, options?.snap !== true)
    // A replay-position jump shows only the tick it lands on. Animation-only snaps used for resize
    // and asset redraws retain the current bubble ages.
    if (options?.seek === true) this.annotations.clear()
    this.annotations.deliver(readSpeech(state, this.expectedIds))
    const durationMs = transitionDurationMs(options, this.gapEstimateMs)
    // A snap re-presentation is not a landed state, so it must not move the expression chip tails;
    // only real states age a held chip or close out a fade over one state's presentation time.
    if (options?.snap !== true) {
      this.annotations.observeExpressions(
        scene,
        durationMs > 0 ? durationMs : HEARTHSIDE_STYLE.transition.naturalMs,
      )
    }
    this.props.reconcile(scene)
    this.props.advance(scene)
    this.collision.drawStatic(
      collisionWithPropStates(this.staticCollisionShapes, scene),
      this.worldTextResolution(),
    )
    this.chrome.update(scene, state.tick, this.collisionVisible, this.textResolution())
    const shouldAnimate =
      durationMs > 0 &&
      this.presentedScene !== null &&
      (charactersMoved(this.presentedScene, scene) ||
        hasSustainedPropEffectTransition(this.presentedScene, scene))
    this.settleRemainingMs = 0
    if (shouldAnimate && this.presentedScene !== null) {
      // Movement always follows the renderer transport. It deliberately does not inspect the
      // reduced-motion media query, since continuous character movement is core game state here.
      this.movement = {
        from: this.presentedScene,
        to: scene,
        elapsedMs: 0,
        durationMs,
      }
      this.presentScene(interpolateScene(this.presentedScene, scene, 0))
    } else {
      this.movement = null
      this.presentScene(scene)
    }
    this.updateProbes(state, scene)
  }

  /** Advance character interpolation, the visitor camera, and the speech bubbles' hold and fade. */
  protected override onFrame(dtMs: number): boolean {
    const roofsFading = this.roofs.advance(dtMs)
    const speaking = this.annotations.advance(dtMs)
    const wasSpeaking = this.wasSpeaking
    this.wasSpeaking = speaking
    const movement = this.movement
    if (movement !== null) {
      // Presenting a frame redraws the annotations along with everything else.
      movement.elapsedMs += dtMs
      const progress = Math.min(1, movement.elapsedMs / movement.durationMs)
      this.presentScene(interpolateScene(movement.from, movement.to, progress))
      this.advanceCameraReturn(dtMs, visitorMoved(movement.from, movement.to))
      this.props.advance(this.presentedScene ?? movement.to)
      if (progress >= 1) {
        this.movement = null
        this.settleRemainingMs = HEARTHSIDE_STYLE.transition.settleGraceMs
      }
      return (
        this.movement !== null ||
        this.cameraReturnRequested ||
        this.visitorCamera.returning ||
        this.settleRemainingMs > 0 ||
        speaking ||
        roofsFading
      )
    }
    this.advanceCameraReturn(dtMs, false)
    // A still frame repaints the bubbles and any expression tails that aged this frame, including
    // the frame that retires the last bubble or completes the last chip fade, so neither holds its
    // final opacity. The probe follows that same screen when it changes.
    if (speaking || wasSpeaking) {
      this.redrawAnnotations()
      this.updateExpressionChipProbe()
    }
    this.settleRemainingMs = Math.max(0, this.settleRemainingMs - dtMs)
    return (
      this.cameraReturnRequested ||
      this.visitorCamera.returning ||
      this.settleRemainingMs > 0 ||
      speaking ||
      roofsFading
    )
  }

  /** Report only the finite state-to-state character transition to the host. */
  protected override transitionActive(): boolean {
    return this.movement !== null
  }

  /** Release DOM gesture and Pixi interaction owners for this mount. */
  override destroy(): void {
    // Browser listeners outlive Pixi nodes unless the renderer releases their shared gesture owner.
    this.cameraGestures?.detach()
    this.cameraGestures = null
    this.visitorInput?.destroy()
    this.visitorInput = null
    this.ctx.container.removeEventListener('click', this.onChromeClick)
    window.removeEventListener('keydown', this.onKeyDown)
    this.movement = null
    this.settleRemainingMs = 0
    this.mapView.destroy()
    this.upperGround?.destroy()
    this.upperGround = null
    this.world.destroy()
    super.destroy()
  }

  /** Map a browser point into the renderer's own logical coordinates. */
  private viewPoint(clientPoint: { x: number; y: number }): { x: number; y: number } {
    const bounds = this.ctx.container.getBoundingClientRect()
    const scale = this.displayScale()
    return { x: (clientPoint.x - bounds.left) / scale, y: (clientPoint.y - bounds.top) / scale }
  }

  /**
   * The chrome strip owns clicks in its own band, which is the half of the split the camera
   * gestures leave alone: they accept only the content below it. Both halves are answered in the
   * browser's own coordinates rather than through display-object hit testing.
   */
  private readonly onChromeClick = (event: MouseEvent): void => {
    const view = this.viewPoint({ x: event.clientX, y: event.clientY })
    if (within(view, COLLISION_TOGGLE_RECT)) this.toggleCollision()
    else if (within(view, RECENTER_RECT)) this.recenterCamera()
  }

  /**
   * Keyboard access to the collision overlay. The page owns the keyboard everywhere else, so a key
   * pressed while a field, a menu, or another handler has it never reaches the toggle.
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey)
      return
    if (event.key !== 'c' && event.key !== 'C') return
    if (isTextEntry(event.target)) return
    this.toggleCollision()
  }

  private wireCamera(root: Container): void {
    root.eventMode = 'passive'
    root.interactiveChildren = true
    this.ctx.container.addEventListener('click', this.onChromeClick)
    window.addEventListener('keydown', this.onKeyDown)
    this.cameraGestures = wireCameraGestures(this.ctx.container, {
      toView: (clientPoint) => this.viewPoint(clientPoint),
      accepts: (view) =>
        view.x >= 0 &&
        view.x <= CONTENT_SIZE.width &&
        view.y >= THREE_BRANCHES_PRESENTATION.chromeHeight &&
        view.y <= this.internalSize.height,
      zoomAt: (factor, anchor) => {
        this.applyManualCamera((camera) =>
          zoomCamera(camera, this.cameraLimits, CONTENT_SIZE, factor, this.contentPoint(anchor)),
        )
      },
      panBy: (dx, dy) => {
        this.applyManualCamera((camera) =>
          panCamera(camera, this.cameraLimits, CONTENT_SIZE, dx, dy),
        )
      },
      pinch: (before, after) => {
        this.applyManualCamera((camera) =>
          pinchCamera(
            camera,
            this.cameraLimits,
            CONTENT_SIZE,
            { midpoint: this.contentPoint(before.midpoint), distance: before.distance },
            { midpoint: this.contentPoint(after.midpoint), distance: after.distance },
          ),
        )
      },
      reset: () => {
        this.recenterCamera()
      },
    })
  }

  /** Recenter on the current visitor at the current zoom and resume following it. */
  private readonly recenterCamera = (): void => {
    const previous = cameraProbeValue(this.visitorCamera.camera)
    this.manualCameraQuietUntilMs = 0
    this.cameraReturnRequested = false
    this.visitorCamera = recenterVisitorCamera(this.visitorCamera, this.cameraLimits, CONTENT_SIZE)
    this.applyCamera()
    this.redrawCameraIfChanged(previous)
  }

  private contentPoint(point: { x: number; y: number }): { x: number; y: number } {
    return { x: point.x, y: point.y - THREE_BRANCHES_PRESENTATION.chromeHeight }
  }

  private applyManualCamera(reduce: (camera: CameraView) => CameraView): void {
    const previous = cameraProbeValue(this.visitorCamera.camera)
    // Manual input cancels any in-progress return. Live play may begin another return once input
    // has gone quiet and the visitor moves; watch and replay remain suspended until Recenter.
    this.manualCameraQuietUntilMs = performance.now() + MANUAL_CAMERA_QUIET_MS
    this.cameraReturnRequested = false
    this.visitorCamera = suspendVisitorFollow(this.visitorCamera)
    this.visitorCamera = {
      ...this.visitorCamera,
      camera: reduce(this.visitorCamera.camera),
    }
    this.applyCamera()
    this.redrawCameraIfChanged(previous)
  }

  /** Ease a live play inspection view back to a moving visitor once camera input has stopped. */
  private advanceCameraReturn(dtMs: number, visitorIsMoving: boolean): void {
    if (!this.returnsCameraDuringPlay || this.visitorCamera.following) {
      this.cameraReturnRequested = false
      return
    }
    if (this.cameraGestures?.dragging() === true) {
      this.cameraReturnRequested = false
      return
    }
    if (visitorIsMoving) this.cameraReturnRequested = true
    if (!this.visitorCamera.returning) {
      if (!this.cameraReturnRequested || performance.now() < this.manualCameraQuietUntilMs) return
      this.visitorCamera = beginVisitorReturn(this.visitorCamera)
      this.cameraReturnRequested = false
    }
    const previous = cameraProbeValue(this.visitorCamera.camera)
    this.visitorCamera = advanceVisitorReturn(
      this.visitorCamera,
      this.cameraLimits,
      CONTENT_SIZE,
      dtMs,
    )
    if (previous !== cameraProbeValue(this.visitorCamera.camera)) this.applyCamera()
  }

  /** Present an inspection-camera transform immediately, but never redraw an unchanged camera. */
  private redrawCameraIfChanged(previous: string): void {
    if (previous !== cameraProbeValue(this.visitorCamera.camera)) this.redrawCurrentFrame()
  }

  private applyCamera(): void {
    const transform = worldTransform(this.visitorCamera.camera, CONTENT_SIZE)
    this.worldRoot.position.set(transform.x, THREE_BRANCHES_PRESENTATION.chromeHeight + transform.y)
    this.worldRoot.scale.set(transform.scale)
    this.ctx.container.dataset.threeBranchesCamera = cameraProbeValue(this.visitorCamera.camera)
    this.redrawCharacters()
    // Plates and bubbles counter-scale against the camera to hold one readable size, so they follow
    // every camera change as well as every frame.
    this.redrawAnnotations()
    // The expression chip shows only at the full-nameplate zoom, so its probe follows the camera
    // too, not just the landed states that {@link updateProbes} observes.
    this.updateExpressionChipProbe()
    if (this.collisionTextZoom !== this.visitorCamera.camera.zoom) {
      this.collisionTextZoom = this.visitorCamera.camera.zoom
      this.redrawAllCollision()
    }
  }

  /**
   * The expression chip title the annotation layer draws above the visitor, or none while no
   * expression shows or the camera sits below the full-nameplate zoom. The retained tail map is
   * authoritative once a state has been observed, but a snap presentation (a replay seek, an asset
   * redraw, the very first state) reconciles the live scene without any tail, so the presented
   * scene's own expression title stands in then. Zooming below full-plate opacity hides the chip,
   * so the probe reports the same visibility the layer draws.
   */
  private updateExpressionChipProbe(): void {
    const visitor = this.presentedScene?.characters.find(
      (character) => character.id === VISITOR_PLAYER,
    )
    const title =
      this.annotations.expressionChipTitle(VISITOR_PLAYER) ?? visitor?.expressionTitle ?? null
    this.ctx.container.dataset.threeBranchesExpressionChip =
      title !== null &&
      nameplateAlpha(this.visitorCamera.camera.zoom, this.cameraLimits.minZoom) === 1
        ? title
        : 'none'
  }

  private redrawAnnotations(): void {
    const scene = this.presentedScene
    if (scene === null) return
    this.annotations.reconcile(
      scene,
      this.visitorCamera.camera.zoom,
      this.cameraLimits.minZoom,
      this.textResolution(),
    )
  }

  private redrawCharacters(): void {
    const scene = this.presentedScene
    if (scene === null) return
    this.characters.reconcile(scene, this.visitorCamera.camera.zoom, this.cameraLimits.minZoom)
  }

  private readonly toggleCollision = (): void => {
    this.collisionVisible = !this.collisionVisible
    this.collision.setVisible(this.collisionVisible)
    if (this.currentScene !== null) {
      this.chrome.update(
        this.currentScene,
        this.currentScene.dynamic?.tick ?? 0,
        this.collisionVisible,
        this.textResolution(),
      )
    }
    this.ctx.container.dataset.threeBranchesCollision = this.collisionVisible ? 'on' : 'off'
    this.redrawCurrentFrame()
  }

  private presentScene(scene: FrameScene): void {
    this.presentedScene = scene
    // Only the exact night phase darkens the world. Opening, day, the other named phases, and any
    // unknown value stay ungraded, and the switch never fades.
    this.world.setNightGrade(scene.dynamic?.phase === 'night')
    const visitor = scene.characters.find((character) => character.id === VISITOR_PLAYER)
    if (visitor !== undefined) {
      // The first recorded position corrects static spawn. Later camera motion follows the same
      // interpolated visitor. A manual gesture suspends it until the mode-specific return policy.
      this.visitorCamera = updateVisitorCamera(
        this.visitorCamera,
        this.cameraLimits,
        CONTENT_SIZE,
        visitor.point,
        !this.correctedOpeningTarget,
      )
      this.correctedOpeningTarget = true
    }
    this.applyCamera()
    this.collision.drawDynamic(frameCollision(scene), this.worldTextResolution())
  }

  private redrawAllCollision(): void {
    const scene = this.presentedScene
    this.collision.drawStatic(
      collisionWithPropStates(this.staticCollisionShapes, scene),
      this.worldTextResolution(),
    )
    this.collision.drawDynamic(
      scene === null ? [] : frameCollision(scene),
      this.worldTextResolution(),
    )
  }

  private worldTextResolution(): number {
    return this.textResolution(this.visitorCamera.camera.zoom)
  }

  private async loadArt(): Promise<void> {
    await runArtLoad({
      load: () => loadThreeBranchesRuntimeAssets<Texture>((source) => Assets.load<Texture>(source)),
      active: () => !this.isDestroyed,
      install: (assets) => {
        const textures = [
          assets.terrain,
          assets.props,
          assets.monuments,
          assets.buildings,
          assets.scenery,
          assets.characters.body,
          assets.characters.clothing,
          assets.characters.arms,
          assets.characters.details,
          assets.effects,
        ]
        if (!textures.every((texture) => texture instanceof Texture)) {
          throw new Error('Three Branches runtime atlases must be textures.')
        }
        const terrain = createTerrainArt(assets.terrain, this.staticScene)
        const propArt = createPropArt({
          props: assets.props,
          monuments: assets.monuments,
          scenery: assets.scenery,
          effects: assets.effects,
        })
        const characterArt = createCharacterArt({ ...assets.characters, effects: assets.effects })
        let nextMapView: MapLayerView | null = null
        const nextCharacterLayer = new Container()
        const nextUpperLayer = new Container()
        let nextUpperGround: TiledGround | null = null
        try {
          nextMapView = drawMap(this.staticScene, terrain)
          nextUpperGround = drawUpperWalls(nextUpperLayer, this.staticScene, terrain)
          const nextCharacters = createCharacterLayer(nextCharacterLayer)
          nextCharacters.install(characterArt)
          if (this.presentedScene !== null) {
            nextCharacters.reconcile(
              this.presentedScene,
              this.visitorCamera.camera.zoom,
              this.cameraLimits.minZoom,
            )
          }

          this.props.install(propArt)
          if (this.presentedScene !== null) this.props.advance(this.presentedScene)
          this.roofs.install(createRoofArt(assets.buildings))
          if (this.presentedScene !== null) this.roofs.setTargets(this.presentedScene, true)
          this.annotations.install(createExpressionArt(assets.effects))
          // The expression chip's pictogram and accent textures only resolve once a state named the
          // character's expression, so reconcile re-applies them to the retained nodes right away.
          if (this.presentedScene !== null) {
            this.annotations.reconcile(
              this.presentedScene,
              this.visitorCamera.camera.zoom,
              this.cameraLimits.minZoom,
              this.textResolution(),
            )
          }

          const previousMapView = this.mapView
          const previousCharacterLayer = this.characterLayer
          const previousUpperLayer = this.upperLayer
          const previousUpperGround = this.upperGround
          replaceMapLayerView(previousMapView, nextMapView)
          replaceSceneLayer(previousCharacterLayer, nextCharacterLayer)
          replaceSceneLayer(previousUpperLayer, nextUpperLayer)
          this.mapView = nextMapView
          this.characterLayer = nextCharacterLayer
          this.upperLayer = nextUpperLayer
          this.upperGround = nextUpperGround
          this.characters = nextCharacters

          previousMapView.destroy()
          previousUpperGround?.destroy()
          this.buildingOutlines.destroy({ children: true })
          previousCharacterLayer.destroy({ children: true })
          previousUpperLayer.destroy({ children: true })
        } catch (error) {
          nextMapView?.destroy()
          nextUpperGround?.destroy()
          nextCharacterLayer.destroy({ children: true })
          nextUpperLayer.destroy({ children: true })
          throw error
        }
        this.redrawCurrentFrame()
      },
      status: (status) => {
        this.ctx.container.dataset.threeBranchesAssets = status
      },
      report: (error) => {
        console.error('Three Branches could not load its artwork.', error)
      },
    })
  }

  private updateProbes(state: StepState, scene: FrameScene): void {
    const dynamic = scene.dynamic
    this.ctx.container.dataset.threeBranchesOpening =
      Object.keys(state.agents).length === 0 ? 'received' : 'complete'
    this.ctx.container.dataset.threeBranchesTick = String(dynamic?.tick ?? state.tick)
    this.ctx.container.dataset.threeBranchesPhase = dynamic?.phase ?? 'opening'
    this.ctx.container.dataset.threeBranchesCollision = this.collisionVisible ? 'on' : 'off'
    this.ctx.container.dataset.threeBranchesTerminal = String(dynamic?.terminal ?? false)
    const visitor = dynamic?.characters.find((character) => character.id === VISITOR_PLAYER)
    this.ctx.container.dataset.threeBranchesVisitor =
      visitor === undefined
        ? 'pending'
        : `${Math.round(visitor.x * 100)},${Math.round(visitor.y * 100)}`
    this.updateExpressionChipProbe()
  }
}

function replaceSceneLayer(current: Container, replacement: Container): void {
  const parent = current.parent
  if (parent === null) throw new Error('Three Branches scene layer is detached.')
  parent.addChildAt(replacement, parent.getChildIndex(current))
}

/** Attach both replacement map branches before the prior view releases either live branch. */
function replaceMapLayerView(current: MapLayerView, replacement: MapLayerView): void {
  replaceSceneLayer(current.naturalView, replacement.naturalView)
  replaceSceneLayer(current.architectureView, replacement.architectureView)
}

function charactersMoved(from: FrameScene, to: FrameScene): boolean {
  const prior = new Map(from.characters.map((character) => [character.id, character]))
  return to.characters.some((character) => {
    const start = prior.get(character.id)
    return (
      start !== undefined &&
      (start.point.x !== character.point.x ||
        start.point.y !== character.point.y ||
        start.heading !== character.heading)
    )
  })
}

function visitorMoved(from: FrameScene, to: FrameScene): boolean {
  const start = from.characters.find((character) => character.id === VISITOR_PLAYER)
  const end = to.characters.find((character) => character.id === VISITOR_PLAYER)
  return (
    start !== undefined &&
    end !== undefined &&
    (start.point.x !== end.point.x || start.point.y !== end.point.y)
  )
}

const definition = {
  key: 'three-branches-village',
  renderer: ThreeBranchesRenderer,
  thumbnail,
} satisfies RendererDefinition

export default definition
