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
import { PixiRenderer } from '@renderers/base/PixiRenderer.js'
import {
  type RendererContext,
  type RendererDefinition,
  type RenderOptions,
  transitionScaleOf,
} from '@renderers/types.js'
import { Container, Graphics } from 'pixi.js'
import { drawBuildings } from './buildings.js'
import {
  initialVisitorCamera,
  resetVisitorCamera,
  suspendVisitorFollow,
  updateVisitorCamera,
  type VisitorCameraState,
} from './camera.js'
import { type CharacterLayer, createCharacterLayer } from './characters.js'
import { type ChromeLayer, COLLISION_TOGGLE_RECT, createChrome } from './chrome.js'
import { collisionWithPropStates, frameCollision, staticCollision } from './collision.js'
import { type CollisionLayer, createCollisionLayer } from './collision-layer.js'
import { drawMap } from './map-layer.js'
import { expectedCharacterIds, readStatic } from './overlay.js'
import { PALETTE, THREE_BRANCHES_PRESENTATION } from './presentation.js'
import { createPropLayer, type PropLayer } from './props-layer.js'
import { buildStaticScene, computeScene, interpolateScene } from './scene.js'
import thumbnail from './thumbnail.svg'
import type { CollisionShape, FrameScene, StaticScene } from './types.js'

const CONTENT_SIZE = {
  width: THREE_BRANCHES_PRESENTATION.internalSize.width,
  height:
    THREE_BRANCHES_PRESENTATION.internalSize.height - THREE_BRANCHES_PRESENTATION.chromeHeight,
}

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
  private readonly visitorIsHumanControlled: boolean
  private worldRoot!: Container
  private collision!: CollisionLayer
  private props!: PropLayer
  private characters!: CharacterLayer
  private chrome!: ChromeLayer
  private cameraLimits!: CameraLimits
  private visitorCamera!: VisitorCameraState
  private cameraGestures: CameraGestures | null = null
  private collisionVisible = true
  private correctedOpeningTarget = false
  private currentScene: FrameScene | null = null
  private presentedScene: FrameScene | null = null
  private movement: MovementTransition | null = null
  private collisionTextZoom = Number.NaN

  /** Parse immutable renderer inputs before Pixi builds the retained scene. */
  constructor(ctx: RendererContext) {
    super(ctx)
    // Header data is immutable for the mount. Dynamic states never need to repeat village geometry.
    const village = readStatic(ctx.header)
    this.expectedIds = expectedCharacterIds(ctx.header)
    this.staticScene = buildStaticScene(village)
    this.staticCollisionShapes = staticCollision(this.staticScene)
    // Human attribution alone is not enough: controlledPlayers is empty for watch, replay, and ended play.
    this.visitorIsHumanControlled = ctx.controlledPlayers.includes('player_0')
  }

  protected setup(root: Container): void {
    const backdrop = new Graphics()
      .rect(0, 0, this.internalSize.width, this.internalSize.height)
      .fill(PALETTE.backdrop)
    const contentMask = new Graphics()
      .rect(0, THREE_BRANCHES_PRESENTATION.chromeHeight, CONTENT_SIZE.width, CONTENT_SIZE.height)
      .fill('#ffffff')
    const gradedWorld = new Container()
    const mapLayer = new Container()
    const buildingLayer = new Container()
    const propLayer = new Container()
    const characterLayer = new Container()
    const collisionLayer = new Container()
    const chromeLayer = new Container()
    gradedWorld.addChild(mapLayer, buildingLayer, propLayer, characterLayer)
    this.worldRoot = new Container()
    this.worldRoot.addChild(gradedWorld, collisionLayer)
    this.worldRoot.mask = contentMask
    root.addChild(backdrop, contentMask, this.worldRoot, chromeLayer)

    drawMap(mapLayer, this.staticScene)
    drawBuildings(buildingLayer, this.staticScene)
    this.props = createPropLayer(propLayer, this.staticScene)
    this.characters = createCharacterLayer(characterLayer)
    this.collision = createCollisionLayer(collisionLayer)
    this.chrome = createChrome(chromeLayer, this.toggleCollision)

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
      this.visitorIsHumanControlled,
    )
    this.applyCamera()
    this.wireCamera(root)
    this.ctx.container.dataset.threeBranchesGround = 'ready'
    this.ctx.container.dataset.threeBranchesCollisionToggle = `${COLLISION_TOGGLE_RECT.x},${COLLISION_TOGGLE_RECT.y},${COLLISION_TOGGLE_RECT.width},${COLLISION_TOGGLE_RECT.height}`
  }

  protected update(state: StepState, options?: RenderOptions): void {
    const scene = computeScene(state, this.staticScene, this.expectedIds)
    this.currentScene = scene
    this.props.reconcile(scene)
    this.collision.drawStatic(
      collisionWithPropStates(this.staticCollisionShapes, scene),
      this.worldTextResolution(),
    )
    this.chrome.update(scene, state.tick, this.collisionVisible, this.textResolution())
    const scale = transitionScaleOf(options)
    const shouldAnimate =
      options?.snap !== true &&
      scale > 0 &&
      this.presentedScene !== null &&
      charactersMoved(this.presentedScene, scene)
    if (shouldAnimate && this.presentedScene !== null) {
      // Movement always follows the renderer transport. It deliberately does not inspect the
      // reduced-motion media query, since continuous character movement is core game state here.
      this.movement = {
        from: this.presentedScene,
        to: scene,
        elapsedMs: 0,
        durationMs: THREE_BRANCHES_PRESENTATION.movementDurationMs * scale,
      }
      this.presentScene(interpolateScene(this.presentedScene, scene, 0))
    } else {
      this.movement = null
      this.presentScene(scene)
    }
    this.updateProbes(state, scene)
  }

  /** Advance character interpolation and its human-controlled visitor camera. */
  protected override onFrame(dtMs: number): boolean {
    const movement = this.movement
    if (movement === null) return false
    movement.elapsedMs += dtMs
    const progress = Math.min(1, movement.elapsedMs / movement.durationMs)
    this.presentScene(interpolateScene(movement.from, movement.to, progress))
    if (progress >= 1) this.movement = null
    return this.movement !== null
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
    this.movement = null
    this.chrome?.destroy()
    super.destroy()
  }

  private wireCamera(root: Container): void {
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
        this.visitorCamera = resetVisitorCamera(
          this.visitorCamera,
          this.cameraLimits,
          CONTENT_SIZE,
          this.visitorIsHumanControlled,
        )
        this.applyCamera()
      },
    })
  }

  private contentPoint(point: { x: number; y: number }): { x: number; y: number } {
    return { x: point.x, y: point.y - THREE_BRANCHES_PRESENTATION.chromeHeight }
  }

  private applyManualCamera(reduce: (camera: CameraView) => CameraView): void {
    // Any deliberate inspection gesture suspends live visitor follow until the explicit reset.
    this.visitorCamera = suspendVisitorFollow(this.visitorCamera)
    this.visitorCamera = {
      ...this.visitorCamera,
      camera: reduce(this.visitorCamera.camera),
    }
    this.applyCamera()
  }

  private applyCamera(): void {
    const transform = worldTransform(this.visitorCamera.camera, CONTENT_SIZE)
    this.worldRoot.position.set(transform.x, THREE_BRANCHES_PRESENTATION.chromeHeight + transform.y)
    this.worldRoot.scale.set(transform.scale)
    this.ctx.container.dataset.threeBranchesCamera = cameraProbeValue(this.visitorCamera.camera)
    if (this.collisionTextZoom !== this.visitorCamera.camera.zoom) {
      this.collisionTextZoom = this.visitorCamera.camera.zoom
      this.redrawAllCollision()
    }
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
  }

  private presentScene(scene: FrameScene): void {
    this.presentedScene = scene
    this.characters.reconcile(scene)
    const visitor = scene.characters.find((character) => character.id === 'visitor')
    if (visitor !== undefined) {
      // The first recorded position corrects static spawn. Later camera motion follows the same
      // interpolated visitor only while the live owner retains human control and has not panned.
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
    return this.textResolution() * this.visitorCamera.camera.zoom
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

/** Build header-shaped inputs in tests without reaching into the mounted renderer. */
export function rendererStaticFor(header: RecordingHeader): StaticScene {
  return buildStaticScene(readStatic(header))
}

const definition = {
  key: 'three-branches-village',
  renderer: ThreeBranchesRenderer,
  thumbnail,
} satisfies RendererDefinition

export default definition
