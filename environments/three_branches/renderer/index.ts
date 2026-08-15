import type { RecordingHeader, StepState } from '@game-sandbox/schema'
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
import type { GroundView, TiledGround } from '@renderers/base/tiled-ground.js'
import type { RendererContext, RendererDefinition, RenderOptions } from '@renderers/types.js'
import { Assets, ColorMatrixFilter, Container, Graphics, Texture } from 'pixi.js'
import { type AnnotationLayer, createAnnotationLayer } from './annotations.js'
import { replaceFallback, runArtLoad } from './art-loading.js'
import { loadThreeBranchesRuntimeAssets } from './assets.js'
import { drawBuildings } from './buildings.js'
import {
  advanceVisitorReturn,
  beginVisitorReturn,
  initialVisitorCamera,
  recenterVisitorCamera,
  suspendVisitorFollow,
  updateVisitorCamera,
  type VisitorCameraState,
} from './camera.js'
import { type CharacterLayer, createCharacterLayer } from './characters.js'
import { type ChromeLayer, COLLISION_TOGGLE_RECT, createChrome, RECENTER_RECT } from './chrome.js'
import { collisionWithPropStates, frameCollision, staticCollision } from './collision.js'
import { type CollisionLayer, createCollisionLayer } from './collision-layer.js'
import { isTextEntry } from './input.js'
import { drawMap, drawUpperWalls } from './map-layer.js'
import { expectedCharacterIds, readSpeech, readStatic } from './overlay.js'
import {
  HEARTHSIDE_STYLE,
  measureDeliveryGap,
  THREE_BRANCHES_PRESENTATION,
  transitionDurationMs,
} from './presentation.js'
import { createPropLayer, type PropLayer } from './props-layer.js'
import { buildStaticScene, computeScene, interpolateScene } from './scene.js'
import { createTerrainArt } from './terrain-art.js'
import thumbnail from './thumbnail.png'
import type { CollisionShape, FrameScene, StaticScene, WorldPoint } from './types.js'
import { propUseShapes, selectUseTarget } from './use-preview.js'
import { createVisitorInput, type VisitorInputController } from './visitor-input.js'

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
  private worldRoot!: Container
  private mapLayer!: Container
  private upperLayer!: Container
  private mapGround!: GroundView
  private upperGround: TiledGround | null = null
  private buildingOutlines!: Container
  private collision!: CollisionLayer
  private props!: PropLayer
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
    const gradedWorld = new Container()
    this.mapLayer = new Container()
    const sceneryLayer = new Container()
    const propLayer = new Container()
    const characterLayer = new Container()
    this.upperLayer = new Container()
    const emissiveLayer = new Container()
    const annotationLayer = new Container()
    const collisionLayer = new Container()
    const chromeLayer = new Container()
    // The fixed input layer (pad and palette) sits above the world and below the chrome strip.
    const padLayer = new Container()
    const paletteLayer = new Container()
    const inputLayer = new Container()
    inputLayer.addChild(padLayer, paletteLayer)
    gradedWorld.filters = [new ColorMatrixFilter()]
    gradedWorld.addChild(this.mapLayer, sceneryLayer, propLayer, characterLayer, this.upperLayer)
    this.worldRoot = new Container()
    // Nameplates and bubbles ride above the graded world and below the collision overlay, so the
    // information layer is never colour-graded and the diagnostic layer still reads on top of it.
    this.worldRoot.addChild(gradedWorld, emissiveLayer, annotationLayer, collisionLayer)
    this.worldRoot.mask = contentMask
    root.addChild(backdrop, contentMask, this.worldRoot, inputLayer, chromeLayer)

    this.mapGround = drawMap(this.mapLayer, this.staticScene)
    this.buildingOutlines = drawBuildings(this.upperLayer, this.staticScene)
    this.props = createPropLayer(sceneryLayer, propLayer, this.staticScene)
    this.characters = createCharacterLayer(characterLayer)
    this.annotations = createAnnotationLayer(annotationLayer, createText)
    this.collision = createCollisionLayer(collisionLayer, createText)
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
    this.ctx.container.dataset.threeBranchesCollisionToggle = probeRect(COLLISION_TOGGLE_RECT)
    this.ctx.container.dataset.threeBranchesRecenter = probeRect(RECENTER_RECT)
    this.visitorInput = createVisitorInput({
      container: this.ctx.container,
      controlledPlayers: this.ctx.controlledPlayers,
      sendAction: this.ctx.sendAction,
      paceMs: this.ctx.meta.pace_interval_ms ?? 250,
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
    const deliveryGapMs = delivery.gapMs
    this.lastDeliveryAtMs = delivery.nextMs
    const scene = computeScene(state, this.staticScene, this.expectedIds)
    this.currentScene = scene
    const landedVisitor = scene.characters.find((character) => character.id === 'visitor')
    if (landedVisitor !== undefined) {
      this.landedVisitor = { point: landedVisitor.point, heading: landedVisitor.heading }
    }
    this.visitorInput?.handleFrame(scene.dynamic?.terminal ?? false)
    // A replay-position jump shows only the tick it lands on. Animation-only snaps used for resize
    // and asset redraws retain the current bubble ages.
    if (options?.seek === true) this.annotations.clear()
    this.annotations.deliver(readSpeech(state, this.expectedIds))
    this.props.reconcile(scene)
    this.collision.drawStatic(
      collisionWithPropStates(this.staticCollisionShapes, scene),
      this.worldTextResolution(),
    )
    this.chrome.update(scene, state.tick, this.collisionVisible, this.textResolution())
    const durationMs = transitionDurationMs(options, deliveryGapMs)
    const shouldAnimate =
      durationMs > 0 && this.presentedScene !== null && charactersMoved(this.presentedScene, scene)
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
      if (progress >= 1) {
        this.movement = null
        this.settleRemainingMs = HEARTHSIDE_STYLE.transition.settleGraceMs
      }
      return (
        this.movement !== null ||
        this.cameraReturnRequested ||
        this.visitorCamera.returning ||
        this.settleRemainingMs > 0 ||
        speaking
      )
    }
    this.advanceCameraReturn(dtMs, false)
    // A still frame repaints only for the bubbles, including the frame that retires the last one,
    // so a faded bubble leaves the screen rather than holding its final opacity.
    if (speaking || wasSpeaking) this.redrawAnnotations()
    this.settleRemainingMs = Math.max(0, this.settleRemainingMs - dtMs)
    return (
      this.cameraReturnRequested ||
      this.visitorCamera.returning ||
      this.settleRemainingMs > 0 ||
      speaking
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
    const elapsedMs = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0
    const previous = cameraProbeValue(this.visitorCamera.camera)
    this.visitorCamera = advanceVisitorReturn(
      this.visitorCamera,
      this.cameraLimits,
      CONTENT_SIZE,
      elapsedMs,
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
    // Plates and bubbles counter-scale against the camera to hold one readable size, so they follow
    // every camera change as well as every frame.
    this.redrawAnnotations()
    if (this.collisionTextZoom !== this.visitorCamera.camera.zoom) {
      this.collisionTextZoom = this.visitorCamera.camera.zoom
      this.redrawAllCollision()
    }
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
    this.characters.reconcile(scene)
    const visitor = scene.characters.find((character) => character.id === 'visitor')
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
      install: (atlases) => {
        const terrainAtlas = atlases.terrain
        if (!(terrainAtlas instanceof Texture)) {
          throw new Error('Three Branches terrain atlas must be one texture.')
        }
        const terrain = createTerrainArt(terrainAtlas, this.staticScene)
        this.mapGround = replaceFallback(
          this.mapGround,
          () => drawMap(this.mapLayer, this.staticScene, terrain),
          () => this.redrawCurrentFrame(),
        )
        this.upperGround?.destroy()
        this.upperGround = drawUpperWalls(this.upperLayer, this.staticScene, terrain)
        this.buildingOutlines.destroy({ children: true })
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
    const visitor = dynamic?.characters.find((character) => character.id === 'visitor')
    this.ctx.container.dataset.threeBranchesVisitor =
      visitor === undefined
        ? 'pending'
        : `${Math.round(visitor.x * 100)},${Math.round(visitor.y * 100)}`
  }
}

function probeRect(rect: { x: number; y: number; width: number; height: number }): string {
  return `${rect.x},${rect.y},${rect.width},${rect.height}`
}

function within(
  point: { x: number; y: number },
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
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
  const start = from.characters.find((character) => character.id === 'visitor')
  const end = to.characters.find((character) => character.id === 'visitor')
  return (
    start !== undefined &&
    end !== undefined &&
    (start.point.x !== end.point.x || start.point.y !== end.point.y)
  )
}

/** Build header-shaped inputs in tests without reaching into the mounted renderer. */
export function rendererStaticFor(header: RecordingHeader): StaticScene {
  return buildStaticScene(readStatic(header))
}

const definition = {
  key: 'three-branches-village',
  renderer: ThreeBranchesRenderer,
  thumbnail,
  // Students, guides, and observations speak only of the visitor and the NPCs, so the host's chat
  // surfaces name a line's speaker and addressee the same way the village itself does.
  playerNames: (header: RecordingHeader) =>
    Object.fromEntries(
      expectedCharacterIds(header).map((characterId, index) => [`player_${index}`, characterId]),
    ),
} satisfies RendererDefinition

export default definition
