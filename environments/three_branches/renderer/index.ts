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
import { type RendererDefinition, type RenderOptions, transitionScaleOf } from '@renderers/types.js'
import { Assets, Container, Graphics, type Texture } from 'pixi.js'

import {
  loadThreeBranchesAssets,
  type ThreeBranchesAssetName,
  threeBranchesAssetSources,
} from './assets.js'
import { CharactersLayer } from './characters.js'
import { CHROME_HEIGHT, VillageChrome } from './chrome.js'
import {
  collisionBodies,
  computeDynamicCollisionScene,
  computeStaticCollisionScene,
} from './collision.js'
import { CollisionLayer } from './collision-layer.js'
import { CraneLayer } from './cranes.js'
import { WORLD_SIZE } from './geometry.js'
import { createGround, type HearthsideGround } from './ground.js'
import {
  interpolateDynamicOverlay,
  interpolationProgress,
  smoothedArrivalMs,
  transitionDurationFor,
} from './interpolation.js'
import { type DynamicOverlay, decodeDynamic, decodeStatic, type StaticOverlay } from './overlay.js'
import { PhaseGradeLayer } from './phase-grade.js'
import { PropsLayer } from './props-layer.js'
import { computeScene, motionScene, PALETTE, type Scene, staticScene } from './scene.js'
import thumbnail from './thumbnail.png'
import { createVillage, type VillageArt } from './village.js'

export const WORLD_LAYER_ORDER = [
  'ground-and-washes',
  'lower-village',
  'props',
  'characters',
  'upper-village-and-effects',
  'phase-grade',
  'emissives',
  'collision',
] as const

interface SmoothTransition {
  from: DynamicOverlay
  to: DynamicOverlay
  elapsedMs: number
  durationMs: number
}

/**
 * How long the frame loop keeps running once a transition settles. A realtime village hands over a
 * new tick immediately afterwards, and stopping the ticker in between costs a whole frame restarting
 * it, which reads as a stutter at every tick boundary.
 */
const IDLE_HOLD_MS = 500

/** A near-square logical view for the hundred-meter village and its fixed status strip. */
export class ThreeBranchesRenderer extends PixiRenderer {
  readonly internalSize = { width: 1200, height: 1000 } as const
  protected override readonly animated = true
  private readonly contentSize = {
    width: this.internalSize.width,
    height: this.internalSize.height - CHROME_HEIGHT,
  } as const

  private readonly staticOverlay: StaticOverlay = decodeStatic(this.ctx.header.overlay_static)
  private worldRoot!: Container
  private artWorld!: Container
  private phaseGrade!: PhaseGradeLayer
  private emissives!: Container
  private ground: HearthsideGround | null = null
  private villageArt: VillageArt | null = null
  private propsLayer: PropsLayer | null = null
  private charactersLayer: CharactersLayer | null = null
  private craneLayer: CraneLayer | null = null
  private collisionLayer: CollisionLayer | null = null
  private chrome: VillageChrome | null = null
  private camera: CameraView | null = null
  private cameraLimits: CameraLimits | null = null
  private cameraGestures: CameraGestures | null = null
  private collisionVisible = true
  private latestChrome: Scene['dynamic']['chrome'] | null = null
  private readonly textures = new Map<ThreeBranchesAssetName, Texture>()
  private rendererDestroyed = false
  private presentedDynamic: DynamicOverlay | null = null
  private targetDynamic: DynamicOverlay | null = null
  private smoothTransition: SmoothTransition | null = null
  private idleHoldMs = 0
  /** When the previous state landed, and the running estimate of how often they land. */
  private lastStateMs: number | null = null
  private arrivalMs: number | null = null

  protected setup(root: Container): void {
    this.worldRoot = new Container()
    this.artWorld = new Container()
    this.phaseGrade = new PhaseGradeLayer()
    this.emissives = new Container()
    this.worldRoot.addChild(this.artWorld, this.phaseGrade.view, this.emissives)
    const contentMask = new Graphics()
    contentMask
      .rect(0, CHROME_HEIGHT, this.contentSize.width, this.contentSize.height)
      .fill('#ffffff')
    this.worldRoot.mask = contentMask
    root.addChild(contentMask, this.worldRoot)
    this.buildWorld()
    void this.loadTextures()

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

  protected update(state: StepState, options?: RenderOptions): void {
    const target = decodeDynamic(state.overlay, this.staticOverlay)
    const targetScene = computeScene(target, this.staticOverlay)
    const screenTextResolution = this.textResolution()
    const scale = transitionScaleOf(options)
    const presented = this.presentedDynamic
    const snap =
      options?.snap === true || scale === 0 || presented === null || presented.tick === target.tick
    this.targetDynamic = target
    const landedMs = performance.now()
    if (this.lastStateMs !== null) {
      this.arrivalMs = smoothedArrivalMs(this.arrivalMs, landedMs - this.lastStateMs)
    }
    this.lastStateMs = landedMs
    // The decoded target owns every state treatment for the whole transition, so it is resolved once
    // here; the frames in between only carry the cast from one position to the next.
    this.reconcileWorld(target)
    if (snap) {
      this.smoothTransition = null
      this.presentedDynamic = target
      this.applyMotion(target)
    } else {
      this.smoothTransition = {
        from: presented,
        to: target,
        elapsedMs: 0,
        durationMs: transitionDurationFor(options?.transitionScale, this.arrivalMs),
      }
      this.applyMotion(presented)
    }
    this.chrome?.update(targetScene.dynamic.chrome, this.collisionVisible, screenTextResolution)
    this.latestChrome = targetScene.dynamic.chrome
    this.updateProbes(target)
  }

  protected override onFrame(dtMs: number): boolean {
    const transition = this.smoothTransition
    if (transition === null) {
      this.idleHoldMs = Math.max(0, this.idleHoldMs - dtMs)
      return this.idleHoldMs > 0
    }
    transition.elapsedMs = Math.min(transition.durationMs, transition.elapsedMs + dtMs)
    const progress = interpolationProgress(transition.elapsedMs, transition.durationMs)
    const presented = interpolateDynamicOverlay(transition.from, transition.to, progress)
    this.presentedDynamic = presented
    this.applyMotion(presented)
    if (progress >= 1) {
      this.smoothTransition = null
      this.idleHoldMs = IDLE_HOLD_MS
    }
    return true
  }

  protected override transitionActive(): boolean {
    return this.smoothTransition !== null
  }

  protected override refreshVisual(): void {
    if (this.presentedDynamic === null) return
    this.reconcileWorld(this.targetDynamic ?? this.presentedDynamic)
    this.applyMotion(this.presentedDynamic)
  }

  override destroy(): void {
    this.rendererDestroyed = true
    this.smoothTransition = null
    this.idleHoldMs = 0
    this.lastStateMs = null
    this.arrivalMs = null
    this.presentedDynamic = null
    this.targetDynamic = null
    this.cameraGestures?.detach()
    this.cameraGestures = null
    this.ground?.destroy()
    this.ground = null
    this.propsLayer?.destroy()
    this.propsLayer = null
    this.charactersLayer?.destroy()
    this.charactersLayer = null
    this.craneLayer?.destroy()
    this.craneLayer = null
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
    delete this.ctx.container.dataset.threeBranchesAssets
    delete this.ctx.container.dataset.threeBranchesLayers
    delete this.ctx.container.dataset.threeBranchesStaticBuilds
    super.destroy()
  }

  /** Draw the village once. The recording header pins one static overlay for the whole session. */
  private buildWorld(): void {
    const village = staticScene(this.staticOverlay)
    this.ground = createGround(village, PALETTE)
    this.villageArt = createVillage(village, PALETTE)
    this.propsLayer = new PropsLayer(village, PALETTE, this.textureFor)
    this.charactersLayer = new CharactersLayer(PALETTE, this.textureFor)
    this.craneLayer = new CraneLayer(village.layoutKey, PALETTE, this.textureFor)
    this.collisionLayer = new CollisionLayer(PALETTE)
    this.collisionLayer.mountStatic(computeStaticCollisionScene(this.staticOverlay))
    const backdrop = new Graphics()
    backdrop.rect(-WORLD_SIZE, -WORLD_SIZE, WORLD_SIZE * 3, WORLD_SIZE * 3).fill(PALETTE.backdrop)
    const groundLayer = new Container()
    groundLayer.label = WORLD_LAYER_ORDER[0]
    groundLayer.addChild(backdrop, this.ground.view)
    this.villageArt.lower.label = WORLD_LAYER_ORDER[1]
    this.propsLayer.view.label = WORLD_LAYER_ORDER[2]
    this.charactersLayer.view.label = WORLD_LAYER_ORDER[3]
    const upper = new Container()
    upper.label = WORLD_LAYER_ORDER[4]
    upper.addChild(this.villageArt.upper, this.propsLayer.effectsView, this.craneLayer.view)
    this.artWorld.addChild(
      groundLayer,
      this.villageArt.lower,
      this.propsLayer.view,
      this.charactersLayer.view,
      upper,
    )
    this.phaseGrade.view.label = WORLD_LAYER_ORDER[5]
    this.emissives.label = WORLD_LAYER_ORDER[6]
    this.propsLayer.emissivesView.label = 'prop-emissives'
    this.emissives.addChild(this.propsLayer.emissivesView)
    this.collisionLayer.view.label = WORLD_LAYER_ORDER[7]
    this.worldRoot.addChild(this.collisionLayer.view)
    this.ctx.container.dataset.threeBranchesGround = 'ready'
    this.ctx.container.dataset.threeBranchesLayers = WORLD_LAYER_ORDER.join('|')
    this.ctx.container.dataset.threeBranchesStaticBuilds = '1'
  }

  private async loadTextures(): Promise<void> {
    try {
      const sources = threeBranchesAssetSources()
      const textures = await loadThreeBranchesAssets<Texture>((asset) =>
        Assets.load(sources[asset.name]),
      )
      if (this.rendererDestroyed) return
      for (const [name, texture] of Object.entries(textures) as [
        ThreeBranchesAssetName,
        Texture,
      ][]) {
        this.textures.set(name, texture)
      }
      this.ground?.setTextures(this.textureFor)
      this.villageArt?.setTextures(this.textureFor)
      this.ctx.container.dataset.threeBranchesAssets = 'ready'
      this.rerenderCurrentState()
      this.redrawCurrentFrame()
    } catch (error) {
      if (this.rendererDestroyed) return
      this.ctx.container.dataset.threeBranchesAssets = 'error'
      console.error('Three Branches could not load its Hearthside artwork.', error)
    }
  }

  /** Resolve every state treatment for one decoded tick: artwork, labels, and the phase grade. */
  private reconcileWorld(dynamic: DynamicOverlay): void {
    const scene = computeScene(dynamic, this.staticOverlay)
    const worldCssScale = this.displayScale() * (this.camera?.zoom ?? 1)
    const worldTextResolution = this.textResolution() * (this.camera?.zoom ?? 1)
    this.propsLayer?.update(scene.dynamic)
    this.charactersLayer?.update(scene.dynamic, worldCssScale)
    this.phaseGrade.update(scene.dynamic.phase)
    if (this.collisionVisible) {
      this.collisionLayer?.updateDynamic(
        computeDynamicCollisionScene(dynamic, this.staticOverlay),
        true,
        worldTextResolution,
      )
    } else {
      this.collisionLayer?.setVisible(false)
    }
  }

  /** Carry the world to one in-between frame. Nothing here resolves artwork or reads a prop state. */
  private applyMotion(dynamic: DynamicOverlay): void {
    const motion = motionScene(dynamic)
    this.charactersLayer?.applyMotion(motion)
    this.propsLayer?.animate(motion.tick)
    this.craneLayer?.update(motion.tick)
    if (this.collisionVisible) this.collisionLayer?.applyMotion(collisionBodies(dynamic))
  }

  private toggleCollision(): void {
    this.collisionVisible = !this.collisionVisible
    this.collisionLayer?.setVisible(this.collisionVisible)
    if (this.collisionVisible && this.presentedDynamic !== null) {
      const worldTextResolution = this.textResolution() * (this.camera?.zoom ?? 1)
      this.collisionLayer?.updateDynamic(
        computeDynamicCollisionScene(this.presentedDynamic, this.staticOverlay),
        true,
        worldTextResolution,
      )
    }
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
    this.collisionLayer?.setTextResolution(worldTextResolution)
    this.chrome?.setTextResolution(this.textResolution())
    this.ctx.container.dataset.threeBranchesCamera = cameraProbeValue(this.camera)
    this.rerenderCurrentState()
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

  private readonly textureFor = (name: ThreeBranchesAssetName): Texture | null => {
    return this.textures.get(name) ?? null
  }
}

const definition = {
  key: 'three-branches-village',
  renderer: ThreeBranchesRenderer,
  thumbnail,
} satisfies RendererDefinition

export default definition
