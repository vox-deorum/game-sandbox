/**
 * The Flappy Bird renderer: a {@link PixiRenderer} subclass that draws each state from the per-step
 * overlay and, only during live human play, maps raw device input to the flap action. The same class
 * runs unchanged from a stored recording — with no `sendAction` and no controlled slot the base wires
 * no input and it is draw-only, which is what the replay viewer relies on.
 *
 * It keeps the pure/retained split the contract's determinism rule rests on: `computeScene` (in
 * scene.ts) is a pure function of state, and `update` reconciles the retained PixiJS scene graph
 * toward the scene it returns. It registers under the metadata key `"flappy-bird"` (see
 * `renderers/index.ts`). See docs/contributors/rendering.md for the architecture.
 */
import type { StepState } from '@game-sandbox/schema'
import { Container, Graphics, Text } from 'pixi.js'

import { defineRenderer } from '../base/defineRenderer.js'
import { type InputIntent, PixiRenderer } from '../base/PixiRenderer.js'
import { type BirdShape, computeScene, type HudText, type Scene, type Shape } from './scene.js'

/** The slot Flappy Bird's human plays, and the flap action value the harness latches per pace step. */
const HUMAN_SLOT = 'player_0'
const FLAP_ACTION = 1
/** Keys that flap; the base ignores auto-repeat so a held key is one flap, not a stream. */
const FLAP_KEYS = ['Space', 'ArrowUp', 'KeyW'] as const

/** The beak and eye colors, ported from the old 2D rasterizer so the bird reads the same. */
const BEAK_FILL = '#e8772e'
const EYE_WHITE = '#ffffff'
const EYE_PUPIL = '#222222'

export class FlappyBirdRenderer extends PixiRenderer {
  // 288×512 is the pinned game's logical surface (see scene.ts): a tall, narrow space, so the host
  // seats the decision log in the column it leaves free rather than below it.
  static readonly internalSize = { width: 288, height: 512 } as const

  /** Persistent layers: the world shapes below, the in-game HUD text above. Built once in setup. */
  private shapeLayer!: Container
  private hudLayer!: Container
  /** Pooled display objects, reconciled toward the scene each update (created/reused/removed). */
  private readonly shapeNodes: Graphics[] = []
  private readonly hudNodes: Text[] = []

  protected setup(root: Container): void {
    this.shapeLayer = new Container()
    this.hudLayer = new Container()
    root.addChild(this.shapeLayer)
    root.addChild(this.hudLayer)
  }

  protected update(state: StepState): void {
    const scene = computeScene(state, { paceIntervalMs: this.ctx.meta.pace_interval_ms })
    this.reconcileShapes(scene)
    this.reconcileHud(scene)
  }

  protected override inputs(): readonly InputIntent[] {
    // One intent: Space/ArrowUp/W or a pointer/touch on the stage, all mean flap for the human slot.
    return [{ keys: FLAP_KEYS, pointer: true, slot: HUMAN_SLOT, action: FLAP_ACTION }]
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
      drawShape(node, shapes[i] as Shape)
    }
    removeExtra(this.shapeNodes, shapes.length)
  }

  /** Reconcile the HUD text nodes, mutating in place so an unchanged label needs no re-layout. */
  private reconcileHud(scene: Scene): void {
    const { hud } = scene
    for (let i = 0; i < hud.length; i++) {
      let node = this.hudNodes[i]
      if (node === undefined) {
        node = new Text({ text: '' })
        this.hudLayer.addChild(node)
        this.hudNodes[i] = node
      }
      applyHud(node, hud[i] as HudText)
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

/** Draw one scene shape into a (reused) Graphics, resetting the transform a prior shape may have set. */
function drawShape(g: Graphics, shape: Shape): void {
  g.clear()
  g.position.set(0, 0)
  g.rotation = 0
  if (shape.kind === 'rect') {
    g.rect(shape.x, shape.y, shape.w, shape.h).fill(shape.fill)
    return
  }
  drawBird(g, shape)
}

/** The bird: a rotated body with a small beak and eye, drawn around its center (ported from paint.ts). */
function drawBird(g: Graphics, bird: BirdShape): void {
  g.position.set(bird.x, bird.y)
  g.rotation = (bird.rot * Math.PI) / 180
  const r = bird.radius
  g.ellipse(0, 0, r * 1.2, r)
    .fill(bird.fill)
    .stroke({ color: bird.edge, width: 2 })
  g.poly([r * 1.1, -2, r * 1.7, 0, r * 1.1, 4]).fill(BEAK_FILL)
  g.circle(r * 0.4, -r * 0.4, r * 0.35).fill(EYE_WHITE)
  g.circle(r * 0.5, -r * 0.4, r * 0.15).fill(EYE_PUPIL)
}

function alignAnchor(align: HudText['align']): number {
  return align === 'left' ? 0 : align === 'right' ? 1 : 0.5
}

/** Apply one HUD entry to a (reused) Text node: text, position, alignment, size, and the soft shadow. */
function applyHud(node: Text, hud: HudText): void {
  node.text = hud.text
  node.anchor.set(alignAnchor(hud.align), 0.5)
  node.position.set(hud.x, hud.y)
  node.style.fontFamily = 'system-ui, sans-serif'
  node.style.fontWeight = 'bold'
  node.style.fontSize = hud.size
  node.style.fill = hud.fill
  // A soft drop shadow so the white HUD stays legible over the sky and pipes (the old paint.ts effect).
  node.style.dropShadow = {
    color: '#000000',
    alpha: 0.45,
    blur: 0,
    distance: 1.5,
    angle: Math.PI / 4,
  }
}

// A flat-color vector thumbnail for the home card: sky, two pipes, and the bird, matching the renderer.
const THUMBNAIL =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">' +
      '<rect width="320" height="180" fill="#4ec0ca"/>' +
      '<rect x="90" y="0" width="40" height="60" fill="#5bb33a"/>' +
      '<rect x="86" y="48" width="48" height="12" fill="#3f8c28"/>' +
      '<rect x="90" y="120" width="40" height="60" fill="#5bb33a"/>' +
      '<rect x="86" y="120" width="48" height="12" fill="#3f8c28"/>' +
      '<rect x="220" y="0" width="40" height="90" fill="#5bb33a"/>' +
      '<rect x="216" y="78" width="48" height="12" fill="#3f8c28"/>' +
      '<rect x="0" y="160" width="320" height="20" fill="#ded895"/>' +
      '<ellipse cx="160" cy="92" rx="22" ry="18" fill="#f4d03f" stroke="#c79a1e" stroke-width="3"/>' +
      '<polygon points="180,88 196,92 180,98" fill="#e8772e"/>' +
      '<circle cx="168" cy="84" r="6" fill="#fff"/><circle cx="170" cy="84" r="3" fill="#222"/>' +
      '</svg>',
  )

export const flappyBirdRenderer = defineRenderer(FlappyBirdRenderer, { thumbnail: THUMBNAIL })
