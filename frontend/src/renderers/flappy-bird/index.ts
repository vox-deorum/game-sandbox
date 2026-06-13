/**
 * The Flappy Bird renderer module: it mounts a canvas into the host's container, paints each state
 * through the scene/paint split, and — only during live human play — wires raw device input to the
 * flap action. The same module runs unchanged from a stored recording: with no `sendAction` and no
 * controlled slot it is draw-only, every input path inert, which is what the replay viewer relies on.
 *
 * It implements the contract from `renderers/types.ts` and registers under the metadata key
 * `"flappy-bird"` (see `renderers/index.ts`).
 */
import type { StepState } from '@game-sandbox/schema'

import type { RendererContext, RendererInstance, RendererModule } from '../types.js'
import './flappy.css'
import { paint } from './paint.js'
import { computeScene } from './scene.js'

/** The slot Flappy Bird's human plays, and the flap action value the harness latches per pace step. */
const HUMAN_SLOT = 'player_0'
const FLAP_ACTION = 1
/** Keys that flap; we ignore auto-repeat so a held key is one flap, not a stream. */
const FLAP_KEYS = new Set(['Space', 'ArrowUp', 'KeyW'])

function mount(ctx: RendererContext): RendererInstance {
  const canvas = document.createElement('canvas')
  // Presentation (size, display) is in flappy.css under this class; the class also anchors the e2e
  // locator. The drawing-buffer width/height attributes are still set per state below.
  canvas.className = 'flappy-canvas'
  // jsdom returns null here (no rasterizer); painting is then skipped and only the e2e suite draws.
  const context2d = canvas.getContext('2d')
  ctx.container.appendChild(canvas)

  let sized = false
  const paceIntervalMs = ctx.meta.pace_interval_ms

  function render(state: StepState): void {
    const scene = computeScene(state, { paceIntervalMs })
    if (!sized) {
      canvas.width = scene.width
      canvas.height = scene.height
      sized = true
    }
    if (context2d !== null) {
      paint(context2d, scene)
    }
  }

  // Input attaches only for the owner of a live human session: `sendAction` present and the human
  // slot among the controlled slots. Spectators and the replay viewer take neither branch and get a
  // draw-only renderer with zero input code active.
  const canControl = ctx.sendAction !== undefined && ctx.controlledSlots.includes(HUMAN_SLOT)
  const sendAction = ctx.sendAction
  let detachInput: (() => void) | null = null

  if (canControl && sendAction !== undefined) {
    const flap = (): void => sendAction(HUMAN_SLOT, FLAP_ACTION)

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!FLAP_KEYS.has(event.code)) {
        return
      }
      // Prevent Space from scrolling the page while the renderer owns input.
      event.preventDefault()
      if (event.repeat) {
        return
      }
      flap()
    }
    const onPointerDown = (event: Event): void => {
      event.preventDefault()
      flap()
    }
    const onTouchStart = (event: Event): void => {
      // Prevent touch scroll/zoom on the play surface; one touch is one flap.
      event.preventDefault()
      flap()
    }

    window.addEventListener('keydown', onKeyDown)
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('touchstart', onTouchStart, { passive: false })

    detachInput = (): void => {
      window.removeEventListener('keydown', onKeyDown)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('touchstart', onTouchStart)
    }
  }

  return {
    render,
    destroy(): void {
      detachInput?.()
      detachInput = null
      canvas.remove()
    },
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

// 288×512 is the pinned game's logical surface (see scene.ts): a tall, narrow canvas, so the host
// seats the decision log in the column it leaves free rather than below it.
export const flappyBirdRenderer: RendererModule = {
  mount,
  thumbnail: THUMBNAIL,
  targetCanvasSize: { width: 288, height: 512 },
}
