/**
 * The shared renderer base class. Every environment's renderer is a subclass that supplies only the
 * game (its persistent display objects and the per-state mutation of them); everything common —
 * the PixiJS application lifecycle, the internal→actual scale, resize-in-place, input plumbing, and
 * the headless guard — lives here. See docs/contributors/environments/rendering.md, which is the authority for the
 * model this implements.
 *
 * The class is the {@link Renderer} the registry stores: its static side is the `mount` factory, while
 * its instances are the mounted {@link RendererInstance} and carry the `internalSize`/`aspectRatio`
 * shape. There is no separate module object — a subclass supplies `internalSize` and implements three
 * protected hooks: {@link setup}, {@link update}, and {@link inputs}. The home-card thumbnail is not
 * the renderer's concern: it is passed as a static image asset to `registerRenderer`.
 */
import type { StepState } from '@game-sandbox/schema'
import { Application, Container, Text } from 'pixi.js'

import type { InternalSize, RendererContext, RendererInstance, RenderOptions } from '../types.js'
import './renderer.css'

/** The class assigned to the PixiJS canvas. The end-to-end suite locates the canvas through it. */
export const RENDERER_CANVAS_CLASS = 'renderer-canvas'

/** Debounce window for the resize observer, so a drag-resize settles before we rebuild the surface. */
const RESIZE_DEBOUNCE_MS = 100

/** Empty a layer and release what it held, including any text bitmaps its children baked. */
export function clear(layer: Container): void {
  for (const child of layer.removeChildren()) {
    child.destroy({ children: true })
  }
}

/**
 * A device-input intent a renderer declares from {@link PixiRenderer.inputs}: a gesture (keys and/or
 * a pointer on the stage) mapped to an action sent for a player. The base wires the mechanics — the
 * listeners, `preventDefault`, auto-repeat suppression, and teardown — so a renderer says "Space,
 * ArrowUp, or W, and a pointer, all mean flap" and writes no listener bookkeeping.
 */
export interface InputIntent {
  /** `KeyboardEvent.code` values that trigger this intent (e.g. `['Space', 'ArrowUp', 'KeyW']`). */
  keys?: readonly string[]
  /** When true, a pointer or touch on the stage triggers this intent. */
  pointer?: boolean
  /** The player id the action is sent for; wired only when this player is controlled. */
  playerId: string
  /** The action value sent through the context's `sendAction`. */
  action: unknown
}

/** A concrete renderer constructor: the `this` type {@link PixiRenderer.mount} binds to its caller. */
type RendererCreator = new (ctx: RendererContext) => PixiRenderer

/** True when the environment can give us a WebGL context; false under jsdom (the headless guard). */
function hasWebGL(): boolean {
  try {
    const probe = document.createElement('canvas')
    return probe.getContext('webgl2') !== null || probe.getContext('webgl') !== null
  } catch {
    return false
  }
}

export abstract class PixiRenderer implements RendererInstance {
  // --- Static side: the `Renderer` the registry stores (see types.ts). ---

  /**
   * Construct and mount an instance. The `this` annotation pins the factory to the concrete subclass
   * (so `new this(ctx)` is allowed despite the base being abstract) and binds it to the caller's
   * class, e.g. `FlappyBirdRenderer.mount(ctx)`.
   */
  static mount(this: RendererCreator, ctx: RendererContext): RendererInstance {
    const instance = new this(ctx)
    // Start the lifecycle only after construction is fully complete. A subclass supplies `internalSize`
    // (and other state) through field initializers, which run *after* this base constructor returns — so
    // the constructor must not touch them. `start` runs here, once the instance is whole.
    instance.start()
    return instance
  }

  // --- Instance shape (see RendererInstance) ---

  /** The fixed logical coordinate space this renderer draws in, supplied by each subclass. */
  abstract readonly internalSize: InternalSize

  /** `internalSize.width / internalSize.height`; the layout-facing shape the host reads. */
  get aspectRatio(): number {
    return this.internalSize.width / this.internalSize.height
  }

  protected readonly ctx: RendererContext

  private app: Application | null = null
  private root: Container | null = null
  /** The current root scale (`cssWidth / internalSize.width`); see {@link textResolution}. */
  private scaleFactor = 1
  private latestState: StepState | null = null
  /** Whether the per-frame animation loop is currently attached to the PixiJS ticker. */
  private animating = false
  private ready = false
  private destroyed = false
  private resizeObserver: ResizeObserver | null = null
  private resizeTimer: ReturnType<typeof setTimeout> | null = null
  private devicePixelRatioQuery: MediaQueryList | null = null
  private detachInput: (() => void) | null = null

  constructor(ctx: RendererContext) {
    // The constructor only stores the context: it must not touch subclass field initializers (e.g.
    // `internalSize`), which run after it returns. The lifecycle is kicked off by `start`, which the
    // `mount` factory calls once the instance is fully constructed.
    this.ctx = ctx
  }

  /** Begin the lifecycle: wire input, then kick off the async app init. Called by `mount` only. */
  private start(): void {
    // Input is wired synchronously (it needs no GPU), so it is live before the app finishes init and
    // works under jsdom where the app is skipped entirely.
    this.wireInput()
    // PixiJS v8 initializes asynchronously; kick it off and let `render` cache states until it lands.
    void this.initApp()
  }

  // --- RendererInstance ---

  render(state: StepState, options?: RenderOptions): void {
    this.latestState = state
    if (this.ready && this.app !== null) {
      this.update(state, options)
      // Draw the just-updated scene now, so it is visible and hit-testable this frame rather than only
      // after the next ticker tick (which matters for click-to-play right as a hand rebuilds).
      this.app.render()
      if (this.animated) {
        // An animated renderer then drives its own frames off the ticker: `update` set the new target
        // (and may have started a transition), and `onFrame` advances it until it reports idle.
        this.startAnimating()
      }
    }
  }

  destroy(): void {
    this.destroyed = true
    this.stopAnimating()
    this.detachInput?.()
    this.detachInput = null
    if (this.resizeTimer !== null) {
      clearTimeout(this.resizeTimer)
      this.resizeTimer = null
    }
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.devicePixelRatioQuery?.removeEventListener('change', this.onDevicePixelRatioChange)
    this.devicePixelRatioQuery = null
    if (this.app !== null) {
      // `true` removes the canvas from the DOM; `{ children: true }` frees the scene graph.
      this.app.destroy(true, { children: true })
      this.app = null
    }
    this.root = null
    this.ready = false
  }

  // --- Subclass hooks ---

  /**
   * Whether this renderer animates between states off the PixiJS ticker. Default false: `render`
   * reconciles once and draws, the draw-only behavior the Flappy Bird reference and every
   * scrubber-deterministic renderer rely on. A subclass that overrides {@link onFrame} sets this true.
   */
  protected readonly animated: boolean = false

  /** Build the persistent display objects once, parented to `root`. Called after the app is ready. */
  protected abstract setup(root: Container): void

  /**
   * Mutate the display objects so the frame matches `state`. For a draw-only renderer this must be
   * deterministic in `state` (the scrubber relies on it). An animated renderer sets the new target
   * here and may begin a transition toward it; `options` says whether to snap (a scrub) or how long a
   * budget the transition has (the replay cadence).
   */
  protected abstract update(state: StepState, options?: RenderOptions): void

  /**
   * Redraw after a renderer-owned visual change such as a resize or an asset becoming available.
   * Draw-only renderers retain the established snap-to-latest-state behavior. Animated renderers can
   * override this to preserve an in-flight presentation without replacing their transition target.
   */
  protected refreshVisual(): void {
    if (this.latestState !== null) this.update(this.latestState, { snap: true })
  }

  /**
   * Advance any in-progress animation by `dtMs` wall-clock milliseconds and reconcile the affected
   * display objects. Return true while more frames are still needed (a transition is running, or an
   * ambient animation is live), false when the renderer has settled. Only called on an {@link animated}
   * renderer; the default is unused. Never invoked under jsdom, where the app is skipped entirely.
   */
  protected onFrame(_dtMs: number): boolean {
    return false
  }

  /** Declare the device-input intents. Renderers with no human control may leave this returning []. */
  protected inputs(): readonly InputIntent[] {
    return []
  }

  // --- Animation loop (only used by an `animated` renderer) ---

  /** Attach the per-frame loop to the ticker if it is not already running. */
  private startAnimating(): void {
    if (this.animating || this.app === null) {
      return
    }
    this.animating = true
    this.app.ticker.add(this.onTick)
    this.app.ticker.start()
  }

  /** Detach the per-frame loop and stop the ticker. Safe to call when not animating. */
  private stopAnimating(): void {
    if (!this.animating || this.app === null) {
      this.animating = false
      return
    }
    this.animating = false
    this.app.ticker.remove(this.onTick)
    this.app.ticker.stop()
  }

  /** The ticker callback: advance the animation and stop the loop once it settles. */
  private readonly onTick = (): void => {
    if (this.app === null) {
      return
    }
    // No explicit render here: a PixiJS Application registers its own renderer on this ticker at
    // UPDATE_PRIORITY.LOW, and this callback runs at the default (higher) priority, so the frame is
    // drawn right after `onFrame` mutates the scene. Rendering again would double the GPU work.
    const more = this.onFrame(this.app.ticker.deltaMS)
    if (!more) {
      this.stopAnimating()
    }
  }

  // --- Lifecycle ---

  private async initApp(): Promise<void> {
    // Headless guard: under jsdom there is no WebGL/WebGPU context, so skip PixiJS entirely. The pure
    // scene layer stays unit-testable and pixels are the end-to-end suite's job.
    if (!hasWebGL()) {
      return
    }
    const app = new Application()
    const initialSize = this.measure() ?? this.internalSize
    const { width, height } = initialSize
    await app.init({
      width,
      height,
      resolution: this.devicePixelRatio(),
      autoDensity: true,
      autoStart: false, // we render on state changes and resizes, not on a continuous ticker
      sharedTicker: false,
      backgroundAlpha: 0, // the host paints the stage backdrop behind the canvas
      antialias: true,
    })
    // The instance may have been destroyed while init was in flight; if so, tear down what we built.
    if (this.destroyed) {
      app.destroy(true, { children: true })
      return
    }
    this.app = app
    const canvas = app.canvas as HTMLCanvasElement
    canvas.classList.add(RENDERER_CANVAS_CLASS)
    this.ctx.container.appendChild(canvas)

    const root = new Container()
    this.root = root
    app.stage.addChild(root)
    this.setup(root)

    // App initialization can happen before the host has its final layout. Measure it again once the
    // canvas is attached, so the Pixi screen and backing store immediately match a settled host rather
    // than retaining the logical fallback size.
    this.resizeSurface(this.measure() ?? initialSize)

    this.ready = true
    this.observeResize()

    // Apply whatever state arrived before we were ready. The first state snaps (there is no prior
    // state to animate a transition from); after that, live `render` calls drive any animation.
    if (this.latestState !== null) {
      this.update(this.latestState, { snap: true })
      app.render()
      if (this.animated) {
        this.startAnimating()
      }
    }
  }

  /** The container's current displayed size in CSS pixels, or null before it has been laid out. */
  private measure(): { width: number; height: number } | null {
    const rect = this.ctx.container.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      return null
    }
    return { width: rect.width, height: rect.height }
  }

  /** The current browser pixel density, with a safe default for unusual browser environments. */
  private devicePixelRatio(): number {
    return window.devicePixelRatio || 1
  }

  /** Scale the root so one internal unit maps to the right number of CSS pixels for the current size.
   *  The host lays the element out at the renderer's aspect ratio, so a single uniform scale fits. */
  private applyScale(cssWidth: number): void {
    this.scaleFactor = cssWidth / this.internalSize.width
    if (this.root !== null) {
      this.root.scale.set(this.scaleFactor)
    }
  }

  /**
   * The device-pixel resolution a `Text` node must bake its bitmap at to stay crisp. PixiJS `Graphics`
   * are vector and re-rasterize sharply under any transform, but `Text` bakes a fixed bitmap (at the
   * app's `resolution`, i.e. `devicePixelRatio`) that the root's scale then *magnifies* — soft text.
   * Multiplying by {@link scaleFactor} makes the texture's native density match its on-screen size.
   * A subclass sets `node.resolution = this.textResolution()` when it applies a `Text`; because a
   * resize re-runs `update`, the value tracks the live size with no extra wiring.
   */
  protected textResolution(): number {
    return this.devicePixelRatio() * this.scaleFactor
  }

  /** The canvas width in CSS pixels over the logical scene width, tracked on every resize. */
  protected displayScale(): number {
    return this.scaleFactor
  }

  /**
   * A `Text` node baked at the right device resolution (see {@link textResolution}). `left` and
   * `right` anchor at the top edge, so a caller positions from the top of the line; `center` anchors
   * at the middle, so a caller positions from the center point. The font and the optional outline are
   * the caller's, since type is part of a game's visual identity.
   */
  protected text(
    value: string,
    size: number,
    fill: string,
    align: 'left' | 'center' | 'right',
    fontFamily = 'system-ui, sans-serif',
    stroke?: { color: string; width: number },
  ): Text {
    const node = new Text({
      text: value,
      style: { fontFamily, fontWeight: 'bold', fontSize: size, fill, stroke },
    })
    node.resolution = this.textResolution()
    node.anchor.set(
      align === 'left' ? 0 : align === 'right' ? 1 : 0.5,
      align === 'center' ? 0.5 : 0,
    )
    return node
  }

  /** Reapply and draw the latest state after an asynchronous renderer resource becomes ready. */
  protected rerenderCurrentState(): void {
    if (this.app === null || !this.ready || this.latestState === null) {
      return
    }
    this.refreshVisual()
    this.app.render()
  }

  /** Draw display-object mutations that do not come from a new game state, such as view-only hover. */
  protected redrawCurrentFrame(): void {
    if (this.app === null || !this.ready) return
    this.app.render()
  }

  private observeResize(): void {
    this.resizeObserver = new ResizeObserver(() => this.scheduleResize())
    this.resizeObserver.observe(this.ctx.container)
    this.observeDevicePixelRatio()
  }

  /**
   * A ResizeObserver tracks host geometry but not every display-density change, such as moving the
   * window between monitors. Listen to the current DPR media query and replace it after each change so
   * the next DPR transition is observed too.
   */
  private observeDevicePixelRatio(): void {
    this.devicePixelRatioQuery?.removeEventListener('change', this.onDevicePixelRatioChange)
    this.devicePixelRatioQuery = window.matchMedia(`(resolution: ${this.devicePixelRatio()}dppx)`)
    this.devicePixelRatioQuery.addEventListener('change', this.onDevicePixelRatioChange)
  }

  private readonly onDevicePixelRatioChange = (): void => {
    this.observeDevicePixelRatio()
    this.scheduleResize()
  }

  private scheduleResize(): void {
    if (this.resizeTimer !== null) {
      clearTimeout(this.resizeTimer)
    }
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null
      this.applyResize()
    }, RESIZE_DEBOUNCE_MS)
  }

  /** Resize in place: the PixiJS app and its GPU context survive — no teardown, no flash. */
  private applyResize(): void {
    if (this.app === null || !this.ready) {
      return
    }
    const size = this.measure()
    if (size === null) {
      return
    }
    this.resizeSurface(size)
    this.refreshVisual()
    this.app.render()
  }

  /**
   * Keep Pixi's CSS screen equal to the host and its physical backing store equal to CSS pixels times
   * the current DPR. The root scale maps only logical coordinates to CSS pixels, so it is deliberately
   * not folded into the renderer resolution.
   */
  private resizeSurface({ width, height }: { width: number; height: number }): void {
    if (this.app === null) {
      return
    }
    this.app.renderer.resize(width, height, this.devicePixelRatio())
    this.applyScale(width)
  }

  // --- Input ---

  private wireInput(): void {
    const sendAction = this.ctx.sendAction
    if (sendAction === undefined) {
      return
    }
    // Only intents whose player this user controls are live; the rest stay inert (spectator / replay).
    const active = this.inputs().filter((intent) =>
      this.ctx.controlledPlayers.includes(intent.playerId),
    )
    if (active.length === 0) {
      return
    }

    const keyMap = new Map<string, InputIntent>()
    for (const intent of active) {
      for (const code of intent.keys ?? []) {
        keyMap.set(code, intent)
      }
    }
    const pointerIntent = active.find((intent) => intent.pointer === true)

    const onKeyDown = (event: KeyboardEvent): void => {
      const intent = keyMap.get(event.code)
      if (intent === undefined) {
        return
      }
      // Prevent Space/arrows from scrolling the page while the renderer owns input.
      event.preventDefault()
      // A held key is one action, not a stream.
      if (event.repeat) {
        return
      }
      sendAction(intent.playerId, intent.action)
    }
    window.addEventListener('keydown', onKeyDown)

    let detachPointer: (() => void) | null = null
    if (pointerIntent !== undefined) {
      const onPointer = (event: Event): void => {
        // Prevent pointer/touch from scrolling or zooming the play surface; one gesture is one action.
        event.preventDefault()
        sendAction(pointerIntent.playerId, pointerIntent.action)
      }
      const target = this.ctx.container
      target.addEventListener('pointerdown', onPointer)
      target.addEventListener('touchstart', onPointer, { passive: false })
      detachPointer = (): void => {
        target.removeEventListener('pointerdown', onPointer)
        target.removeEventListener('touchstart', onPointer)
      }
    }

    this.detachInput = (): void => {
      window.removeEventListener('keydown', onKeyDown)
      detachPointer?.()
    }
  }
}
