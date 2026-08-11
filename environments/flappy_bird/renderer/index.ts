/**
 * The Flappy Bird renderer: a {@link PixiRenderer} subclass that draws each state from the per-step
 * overlay and, only during live human play, maps raw device input to the flap action. The same class
 * runs unchanged from a stored recording. With no `sendAction` and no controlled player id, the base wires
 * no input and it is draw-only, which is what the replay viewer relies on.
 *
 * It keeps the pure/retained split the contract's determinism rule rests on: `computeScene` (in
 * scene.ts) is a pure function of state, and `update` reconciles the retained PixiJS scene graph
 * toward the scene it returns. It registers under the metadata key `"flappy-bird"` (see
 * `renderers/index.ts`). See docs/contributors/environments/rendering.md for the architecture.
 */
import type { StepState } from '@game-sandbox/schema'
import { degreesToRadians } from '@renderers/base/math.js'
import { type InputIntent, PixiRenderer } from '@renderers/base/PixiRenderer.js'

import type { RendererDefinition } from '@renderers/types.js'
import { Container, FillGradient, Graphics, Text } from 'pixi.js'
import {
  type BirdShape,
  COLORS,
  computeScene,
  type GradientFill,
  type HudText,
  type RectShape,
  type Scene,
  type Shape,
} from './scene.js'
import thumbnail from './thumbnail.svg'

/** The player Flappy Bird's human controls, and the flap action the harness latches per pace step. */
const HUMAN_PLAYER_ID = 'player_0'
const FLAP_ACTION = 1
/** Keys that flap; the base ignores auto-repeat so a held key is one flap, not a stream. */
const FLAP_KEYS = ['Space', 'ArrowUp', 'KeyW'] as const

/** The beak and eye colors, ported from the old 2D rasterizer so the bird reads the same. */
const BEAK_FILL = '#e8772e'
const BEAK_SHADOW = '#c85f1e'
const EYE_WHITE = '#ffffff'
const EYE_PUPIL = '#222222'

/** The bird body's top-light shading, resolved to a cached gradient like any other shape fill. */
const BIRD_GRADIENT: GradientFill = {
  dir: 'vertical',
  stops: [
    { offset: 0, color: COLORS.birdLight },
    { offset: 0.55, color: COLORS.bird },
    { offset: 1, color: COLORS.birdDark },
  ],
}

export class FlappyBirdRenderer extends PixiRenderer {
  // 288×512 is the pinned game's logical surface (see scene.ts): a tall, narrow space, so the host
  // seats the decision log in the column it leaves free rather than below it.
  readonly internalSize = { width: 288, height: 512 } as const

  /** Persistent layers: the world shapes below, the in-game HUD text above. Built once in setup. */
  private shapeLayer!: Container
  private hudLayer!: Container
  /** Pooled display objects, reconciled toward the scene each update (created/reused/removed). */
  private readonly shapeNodes: Graphics[] = []
  private readonly hudNodes: Text[] = []
  /**
   * Cached `FillGradient` instances, keyed by their definition. A gradient allocates a GPU texture, so
   * we build each look once and reuse it across every shape and frame rather than per draw (which would
   * leak a texture every tick). Freed in {@link destroy}.
   */
  private readonly gradients = new Map<string, FillGradient>()

  protected setup(root: Container): void {
    this.shapeLayer = new Container()
    this.hudLayer = new Container()
    root.addChild(this.shapeLayer)
    root.addChild(this.hudLayer)
  }

  override destroy(): void {
    for (const gradient of this.gradients.values()) {
      gradient.destroy()
    }
    this.gradients.clear()
    super.destroy()
  }

  /** Resolve a scene gradient to a cached `FillGradient`, building (and caching) it on first sight. */
  private gradientFor(grad: GradientFill): FillGradient {
    const key = `${grad.dir}|${grad.stops.map((s) => `${s.offset}:${s.color}`).join(',')}`
    let gradient = this.gradients.get(key)
    if (gradient === undefined) {
      gradient = new FillGradient({
        type: 'linear',
        // Local space: (0,0)→(1,1) is each filled shape's own box, so one instance shades any size.
        start: { x: 0, y: 0 },
        end: grad.dir === 'vertical' ? { x: 0, y: 1 } : { x: 1, y: 0 },
        colorStops: grad.stops,
        textureSpace: 'local',
      })
      this.gradients.set(key, gradient)
    }
    return gradient
  }

  protected update(state: StepState): void {
    const scene = computeScene(state, { paceIntervalMs: this.ctx.meta.pace_interval_ms })
    this.reconcileShapes(scene)
    this.reconcileHud(scene)
  }

  protected override inputs(): readonly InputIntent[] {
    // One intent: Space/ArrowUp/W or a pointer/touch on the stage, all mean flap for the human player.
    return [{ keys: FLAP_KEYS, pointer: true, playerId: HUMAN_PLAYER_ID, action: FLAP_ACTION }]
  }

  /** Reconcile the world shapes: draw each into a pooled Graphics, removing any the scene dropped. */
  private reconcileShapes(scene: Scene): void {
    const { shapes } = scene
    for (let i = 0; i < shapes.length; i++) {
      let node = this.shapeNodes[i]
      if (node === undefined) {
        node = new Graphics()
        this.shapeLayer.addChild(node)
        this.shapeNodes[i] = node
      }
      this.drawShape(node, shapes[i] as Shape)
    }
    removeExtra(this.shapeNodes, shapes.length)
  }

  /** Draw one scene shape into a (reused) Graphics, resetting any transform a prior shape set. */
  private drawShape(g: Graphics, shape: Shape): void {
    g.clear()
    g.position.set(0, 0)
    g.rotation = 0
    if (shape.kind === 'rect') {
      this.drawRect(g, shape)
      return
    }
    if (shape.kind === 'circle') {
      g.circle(shape.x, shape.y, shape.radius).fill({ color: shape.fill, alpha: shape.alpha ?? 1 })
      return
    }
    this.drawBird(g, shape)
  }

  /** Draw a rect, honoring its optional gradient fill, rounded corners, outline, and alpha. */
  private drawRect(g: Graphics, shape: RectShape): void {
    if (shape.radius !== undefined && shape.radius > 0) {
      g.roundRect(shape.x, shape.y, shape.w, shape.h, shape.radius)
    } else {
      g.rect(shape.x, shape.y, shape.w, shape.h)
    }
    g.fill(
      shape.gradient !== undefined
        ? this.gradientFor(shape.gradient)
        : { color: shape.fill, alpha: shape.alpha ?? 1 },
    )
    if (shape.stroke !== undefined) {
      g.stroke({ color: shape.stroke.color, width: shape.stroke.width })
    }
  }

  /** The bird: a top-lit body with a flapping wing, beak, and eye, drawn around its center. */
  private drawBird(g: Graphics, bird: BirdShape): void {
    g.position.set(bird.x, bird.y)
    g.rotation = degreesToRadians(bird.rot)
    const r = bird.radius
    // Wing behind the body: ellipse() has no per-call rotation, so the flap is sold by lifting the
    // wing's center — high on the upstroke (wing > 0), low on the downstroke.
    g.ellipse(-r * 0.2, r * 0.15 - bird.wing * r * 0.35, r * 0.7, r * 0.42)
      .fill(COLORS.birdDark)
      .stroke({ color: bird.edge, width: 1.5 })
    // Body.
    g.ellipse(0, 0, r * 1.2, r)
      .fill(this.gradientFor(BIRD_GRADIENT))
      .stroke({ color: bird.edge, width: 2 })
    // Beak with a thin shadow under it, then the eye with a catch-light pupil.
    g.poly([r * 1.1, -2, r * 1.75, 1, r * 1.1, 6]).fill(BEAK_SHADOW)
    g.poly([r * 1.1, -3, r * 1.7, 0, r * 1.1, 3]).fill(BEAK_FILL)
    g.circle(r * 0.4, -r * 0.4, r * 0.35).fill(EYE_WHITE)
    g.circle(r * 0.5, -r * 0.4, r * 0.15).fill(EYE_PUPIL)
  }

  /** Reconcile the HUD text nodes, mutating in place so an unchanged label needs no re-layout. */
  private reconcileHud(scene: Scene): void {
    const { hud } = scene
    // The bitmap each Text bakes must match its on-screen size, or the root's upscale blurs it.
    const resolution = this.textResolution()
    for (let i = 0; i < hud.length; i++) {
      let node = this.hudNodes[i]
      if (node === undefined) {
        node = new Text({ text: '' })
        this.hudLayer.addChild(node)
        this.hudNodes[i] = node
      }
      applyHud(node, hud[i] as HudText, resolution)
    }
    removeExtra(this.hudNodes, hud.length)
  }
}

/** Destroy and drop every pooled node at or beyond `keep`, the count the current scene still needs. */
function removeExtra(pool: Array<Graphics | Text>, keep: number): void {
  for (let i = keep; i < pool.length; i++) {
    pool[i]?.destroy()
  }
  pool.length = keep
}

function alignAnchor(align: HudText['align']): number {
  return align === 'left' ? 0 : align === 'right' ? 1 : 0.5
}

const definition = {
  key: 'flappy-bird',
  renderer: FlappyBirdRenderer,
  thumbnail,
} satisfies RendererDefinition

export default definition

/**
 * Apply one HUD entry to a (reused) Text node: text, position, alignment, size, outline, and shadow.
 * `resolution` is the device-pixel density to bake the glyph bitmap at (see `PixiRenderer.textResolution`),
 * so the text stays crisp under the root container's upscale rather than magnifying a low-res bitmap.
 */
function applyHud(node: Text, hud: HudText, resolution: number): void {
  node.resolution = resolution
  node.text = hud.text
  node.anchor.set(alignAnchor(hud.align), 0.5)
  node.position.set(hud.x, hud.y)
  node.style.fontFamily = 'system-ui, sans-serif'
  node.style.fontWeight = 'bold'
  node.style.fontSize = hud.size
  node.style.fill = hud.fill
  // An optional outline (the big score) keeps it crisp over busy pipes; clear it when absent so a
  // reused node never carries a prior entry's stroke.
  node.style.stroke =
    hud.stroke !== undefined
      ? { color: hud.stroke.color, width: hud.stroke.width }
      : { width: 0, color: '#000000' }
  // A soft drop shadow so the white HUD stays legible over the sky and pipes (the old paint.ts effect).
  node.style.dropShadow = {
    color: '#000000',
    alpha: 0.45,
    blur: 0,
    distance: 1.5,
    angle: Math.PI / 4,
  }
}
