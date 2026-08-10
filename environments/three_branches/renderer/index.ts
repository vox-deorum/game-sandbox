/** The watch and replay renderer for Days at Three Branches. */
import type { StepState } from '@game-sandbox/schema'
import {
  type CameraLimits,
  type CameraView,
  cameraLimits,
  cameraProbeValue,
  fitCamera,
  panCamera,
  pinchCamera,
  worldTransform,
  zoomCamera,
} from '@renderers/base/camera.js'
import { type CameraGestures, wireCameraGestures } from '@renderers/base/camera-gestures.js'
import { PixiRenderer } from '@renderers/base/PixiRenderer.js'
import type { TiledGround } from '@renderers/base/tiled-ground.js'
import type { RendererDefinition } from '@renderers/types.js'
import { Container, Graphics } from 'pixi.js'

import { CharactersLayer } from './characters.js'
import { CHROME_HEIGHT, VillageChrome } from './chrome.js'
import { computeCollisionScene } from './collision.js'
import { CollisionLayer } from './collision-layer.js'
import { WORLD_SIZE } from './geometry.js'
import { createGround } from './ground.js'
import { decodeDynamic, decodeStatic, type StaticOverlay } from './overlay.js'
import { PropsLayer } from './props-layer.js'
import { computeScene, PALETTE, type Scene, staticScene } from './scene.js'
import thumbnail from './thumbnail.svg'
import { createVillage } from './village.js'

/** A near-square logical view for the hundred-meter village and its fixed status strip. */
export class ThreeBranchesRenderer extends PixiRenderer {
  readonly internalSize = { width: 1200, height: 1000 } as const
  private readonly contentSize = {
    width: this.internalSize.width,
    height: this.internalSize.height - CHROME_HEIGHT,
  } as const

  private readonly staticOverlay: StaticOverlay = decodeStatic(this.ctx.header.overlay_static)
  private worldRoot!: Container
  private gradedWorld!: Container
  private ground: TiledGround | null = null
  private propsLayer: PropsLayer | null = null
  private charactersLayer: CharactersLayer | null = null
  private collisionLayer: CollisionLayer | null = null
  private chrome: VillageChrome | null = null
  private camera: CameraView | null = null
  private cameraLimits: CameraLimits | null = null
  private cameraGestures: CameraGestures | null = null
  private collisionVisible = true
  private latestChrome: Scene['dynamic']['chrome'] | null = null

  protected setup(root: Container): void {
    this.worldRoot = new Container()
    this.gradedWorld = new Container()
    this.worldRoot.addChild(this.gradedWorld)
    const contentMask = new Graphics()
    contentMask
      .rect(0, CHROME_HEIGHT, this.contentSize.width, this.contentSize.height)
      .fill('#ffffff')
    this.worldRoot.mask = contentMask
    root.addChild(contentMask, this.worldRoot)
    this.buildWorld()

    this.chrome = new VillageChrome(() => this.toggleCollision())
    root.addChild(this.chrome.view)
    root.eventMode = 'passive'
    root.interactiveChildren = true
    if (root.parent !== null) {
      root.parent.eventMode = 'static'
      root.parent.interactiveChildren = true
    }

    this.cameraLimits = cameraLimits(
      { minX: 0, minY: 0, maxX: WORLD_SIZE, maxY: WORLD_SIZE },
      this.contentSize,
    )
    this.camera = fitCamera(this.cameraLimits, this.contentSize)
    this.ctx.container.dataset.threeBranchesCollision = 'on'
    this.applyCamera()
    this.cameraGestures = wireCameraGestures(this.ctx.container, {
      toView: (clientPoint) => {
        const bounds = this.ctx.container.getBoundingClientRect()
        const scale = this.displayScale()
        return {
          x: (clientPoint.x - bounds.left) / scale,
          y: (clientPoint.y - bounds.top) / scale - CHROME_HEIGHT,
        }
      },
      // The status strip owns the collision button, so pressing it must not also move the camera.
      accepts: (view) => view.y >= 0,
      zoomAt: (factor, anchor) => {
        if (this.camera === null || this.cameraLimits === null) return
        this.camera = zoomCamera(this.camera, this.cameraLimits, this.contentSize, factor, anchor)
        this.applyCamera()
      },
      panBy: (dx, dy) => {
        if (this.camera === null || this.cameraLimits === null) return
        this.camera = panCamera(this.camera, this.cameraLimits, this.contentSize, dx, dy)
        this.applyCamera()
      },
      pinch: (before, after) => {
        if (this.camera === null || this.cameraLimits === null) return
        this.camera = pinchCamera(this.camera, this.cameraLimits, this.contentSize, before, after)
        this.applyCamera()
      },
      reset: () => this.resetCamera(),
    })
  }

  protected update(state: StepState): void {
    const dynamic = decodeDynamic(state.overlay, this.staticOverlay)
    const scene = computeScene(dynamic, this.staticOverlay)
    const screenTextResolution = this.textResolution()
    const worldTextResolution = screenTextResolution * (this.camera?.zoom ?? 1)
    this.propsLayer?.update(scene.dynamic, worldTextResolution)
    this.charactersLayer?.update(scene.dynamic, worldTextResolution)
    this.collisionLayer?.update(
      computeCollisionScene(dynamic, this.staticOverlay),
      this.collisionVisible,
      worldTextResolution,
    )
    this.chrome?.update(scene.dynamic.chrome, this.collisionVisible, screenTextResolution)
    this.latestChrome = scene.dynamic.chrome
    this.updateProbes(dynamic)
  }

  override destroy(): void {
    this.cameraGestures?.detach()
    this.cameraGestures = null
    this.ground?.destroy()
    this.ground = null
    this.propsLayer?.destroy()
    this.propsLayer = null
    this.charactersLayer?.destroy()
    this.charactersLayer = null
    this.collisionLayer?.destroy()
    this.collisionLayer = null
    this.chrome?.destroy()
    this.chrome = null
    delete this.ctx.container.dataset.threeBranchesGround
    delete this.ctx.container.dataset.threeBranchesTick
    delete this.ctx.container.dataset.threeBranchesPhase
    delete this.ctx.container.dataset.threeBranchesCollision
    delete this.ctx.container.dataset.threeBranchesVisitor
    delete this.ctx.container.dataset.threeBranchesCamera
    delete this.ctx.container.dataset.threeBranchesTerminal
    delete this.ctx.container.dataset.threeBranchesOpening
    super.destroy()
  }

  /** Draw the village once. The recording header pins one static overlay for the whole session. */
  private buildWorld(): void {
    const village = staticScene(this.staticOverlay)
    this.ground = createGround(village, PALETTE)
    this.propsLayer = new PropsLayer(village, PALETTE)
    this.charactersLayer = new CharactersLayer(PALETTE)
    this.collisionLayer = new CollisionLayer(PALETTE)
    this.gradedWorld.addChild(
      this.ground.view,
      createVillage(village, PALETTE),
      this.propsLayer.view,
      this.charactersLayer.view,
    )
    this.worldRoot.addChild(this.collisionLayer.view)
    this.ctx.container.dataset.threeBranchesGround = 'ready'
  }

  private toggleCollision(): void {
    this.collisionVisible = !this.collisionVisible
    if (this.collisionLayer !== null) this.collisionLayer.view.visible = this.collisionVisible
    this.ctx.container.dataset.threeBranchesCollision = this.collisionVisible ? 'on' : 'off'
    // Toggle artwork belongs to the current frame. Updating it changes no game state and never sends
    // an action, so it is safe in spectate and replay contexts.
    if (this.chrome !== null && this.latestChrome !== null) {
      this.chrome.update(this.latestChrome, this.collisionVisible, this.textResolution())
    }
    this.redrawCurrentFrame()
  }

  private applyCamera(): void {
    if (this.camera === null) return
    const transform = worldTransform(this.camera, this.contentSize)
    this.worldRoot.position.set(transform.x, transform.y + CHROME_HEIGHT)
    this.worldRoot.scale.set(transform.scale)
    const worldTextResolution = this.textResolution() * this.camera.zoom
    this.propsLayer?.setTextResolution(worldTextResolution)
    this.charactersLayer?.setTextResolution(worldTextResolution)
    this.collisionLayer?.setTextResolution(worldTextResolution)
    this.chrome?.setTextResolution(this.textResolution())
    this.ctx.container.dataset.threeBranchesCamera = cameraProbeValue(this.camera)
    this.redrawCurrentFrame()
  }

  private resetCamera(): void {
    if (this.cameraLimits === null) return
    this.camera = fitCamera(this.cameraLimits, this.contentSize)
    this.applyCamera()
  }

  private updateProbes(dynamic: ReturnType<typeof decodeDynamic>): void {
    const visitor = dynamic.characters.find((character) => character.id === 'visitor')
    if (dynamic.tick === 1) this.ctx.container.dataset.threeBranchesOpening = 'seen'
    this.ctx.container.dataset.threeBranchesTick = String(dynamic.tick)
    this.ctx.container.dataset.threeBranchesPhase = dynamic.phase
    this.ctx.container.dataset.threeBranchesCollision = this.collisionVisible ? 'on' : 'off'
    this.ctx.container.dataset.threeBranchesVisitor =
      visitor === undefined
        ? 'none'
        : `${Math.round(visitor.position.x * 100)},${Math.round(visitor.position.y * 100)}`
    this.ctx.container.dataset.threeBranchesTerminal = String(dynamic.terminal)
  }
}

const definition = {
  key: 'three-branches-village',
  renderer: ThreeBranchesRenderer,
  thumbnail,
} satisfies RendererDefinition

export default definition
