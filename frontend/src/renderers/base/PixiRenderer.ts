/**
 * The shared renderer base class. Every environment's renderer is a subclass that supplies only the
 * game (its persistent display objects and the per-state mutation of them); everything common —
 * the PixiJS application lifecycle, the internal→actual scale, resize-in-place, input plumbing, and
 * the headless guard — lives here. See docs/contributors/rendering.md, which is the authority for the
 * model this implements.
 *
 * The class is the {@link Renderer} the registry stores: its static side is the `mount` factory, while
 * its instances are the mounted {@link RendererInstance} and carry the `internalSize`/`aspectRatio`
 * shape. There is no separate module object — a subclass supplies `internalSize` and implements three
 * protected hooks: {@link setup}, {@link update}, and {@link inputs}. The home-card thumbnail is not
 * the renderer's concern: it is passed as an SVG asset to `registerRenderer`.
 */
import type { StepState } from '@game-sandbox/schema'
import { Application, Container } from 'pixi.js'

import type { InternalSize, RendererContext, RendererInstance } from '../types.js'
import './renderer.css'

/** The class assigned to the PixiJS canvas. The end-to-end suite locates the canvas through it. */
export const RENDERER_CANVAS_CLASS = 'renderer-canvas'

/** Debounce window for the resize observer, so a drag-resize settles before we rebuild the surface. */
const RESIZE_DEBOUNCE_MS = 100

/**
 * A device-input intent a renderer declares from {@link PixiRenderer.inputs}: a gesture (keys and/or
 * a pointer on the stage) mapped to an action sent for a slot. The base wires the mechanics — the
 * listeners, `preventDefault`, auto-repeat suppression, and teardown — so a renderer says "Space,
 * ArrowUp, or W, and a pointer, all mean flap" and writes no listener bookkeeping.
 */
export interface InputIntent {
  /** `KeyboardEvent.code` values that trigger this intent (e.g. `['Space', 'ArrowUp', 'KeyW']`). */
  keys?: readonly string[]
  /** When true, a pointer or touch on the stage triggers this intent. */
  pointer?: boolean
  /** The slot the action is sent for; wired only when this slot is among the controlled slots. */
  slot: string
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
  private ready = false
  private destroyed = false
  private resizeObserver: ResizeObserver | null = null
  private resizeTimer: ReturnType<typeof setTimeout> | null = null
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

  render(state: StepState): void {
    this.latestState = state
    if (this.ready && this.app !== null) {
      this.update(state)
      this.app.render()
    }
  }

  destroy(): void {
    this.destroyed = true
    this.detachInput?.()
    this.detachInput = null
    if (this.resizeTimer !== null) {
      clearTimeout(this.resizeTimer)
      this.resizeTimer = null
    }
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    if (this.app !== null) {
      // `true` removes the canvas from the DOM; `{ children: true }` frees the scene graph.
      this.app.destroy(true, { children: true })
      this.app = null
    }
    this.root = null
    this.ready = false
  }

  // --- Subclass hooks ---

  /** Build the persistent display objects once, parented to `root`. Called after the app is ready. */
  protected abstract setup(root: Container): void

  /** Mutate the display objects so the frame matches `state`. Must be deterministic in `state`. */
  protected abstract update(state: StepState): void

  /** Declare the device-input intents. Renderers with no human control may leave this returning []. */
  protected inputs(): readonly InputIntent[] {
    return []
  }

  // --- Lifecycle ---

  private async initApp(): Promise<void> {
    // Headless guard: under jsdom there is no WebGL/WebGPU context, so skip PixiJS entirely. The pure
    // scene layer stays unit-testable and pixels are the end-to-end suite's job.
    if (!hasWebGL()) {
      return
    }
    const app = new Application()
    const { width, height } = this.measure()
    await app.init({
      width,
      height,
      resolution: window.devicePixelRatio || 1,
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
    this.applyScale(width)

    this.ready = true
    this.observeResize()

    // Apply whatever state arrived before we were ready.
    if (this.latestState !== null) {
      this.update(this.latestState)
      app.render()
    }
  }

  /** The container's current content-box size in CSS pixels, falling back to the internal size. */
  private measure(): { width: number; height: number } {
    const rect = this.ctx.container.getBoundingClientRect()
    return {
      width: rect.width > 0 ? rect.width : this.internalSize.width,
      height: rect.height > 0 ? rect.height : this.internalSize.height,
    }
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
    return (window.devicePixelRatio || 1) * this.scaleFactor
  }

  private observeResize(): void {
    this.resizeObserver = new ResizeObserver(() => this.scheduleResize())
    this.resizeObserver.observe(this.ctx.container)
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
    const { width, height } = this.measure()
    this.app.renderer.resize(width, height)
    this.applyScale(width)
    if (this.latestState !== null) {
      this.update(this.latestState)
    }
    this.app.render()
  }

  // --- Input ---

  private wireInput(): void {
    const sendAction = this.ctx.sendAction
    if (sendAction === undefined) {
      return
    }
    // Only intents whose slot this user controls are live; the rest stay inert (spectator / replay).
    const active = this.inputs().filter((intent) => this.ctx.controlledSlots.includes(intent.slot))
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
      sendAction(intent.slot, intent.action)
    }
    window.addEventListener('keydown', onKeyDown)

    let detachPointer: (() => void) | null = null
    if (pointerIntent !== undefined) {
      const onPointer = (event: Event): void => {
        // Prevent pointer/touch from scrolling or zooming the play surface; one gesture is one action.
        event.preventDefault()
        sendAction(pointerIntent.slot, pointerIntent.action)
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
