/**
 * The pure half of the Flappy Bird renderer: one `StepState` in, one {@link Scene} out, with no
 * canvas and no accumulated history. This is where all the drawing logic lives, so it is unit-testable
 * in plain Vitest (jsdom has no canvas) and the contract's determinism rule is mechanically checkable:
 * the same state always yields the same scene, which is the property the replay scrubber depends on.
 *
 * The overlay is the whole truth — Stage 2's `extract_overlay` carries everything in unnormalized
 * screen pixels: the logical `width`/`height`, the `player` (`x`/`y` top-left, `vel_y`, `rot` degrees),
 * the `pipes` (`x` left edge, `gap_top`/`gap_bottom` the gap edges), and `pipes_passed`. The art is
 * original flat-color vector drawing; no sprites from the original game ship here.
 *
 * Everything decorative — the gradient sky, the drifting clouds, the horizon hills, and the ground
 * texture — is derived purely from the state too (the surface size, and `tick` for the parallax
 * drift), so the scrubber stays frame-exact: scrub to tick N and you get N's clouds, not the live
 * clock's.
 */
import type { StepState } from '@game-sandbox/schema'

/** The bird sprite's logical size; (x, y) in the overlay is its top-left, so the body centers here. */
export const PLAYER_WIDTH = 34
export const PLAYER_HEIGHT = 24
/**
 * Pipe column width. The overlay carries no pipe width deliberately — it is a visual constant of the
 * pinned game (flappy-bird-gymnasium's `PIPE_WIDTH`), not per-step data. A later overlay field can
 * replace the constant if a variant ever varies it.
 */
export const PIPE_WIDTH = 52
/** How far the rounded cap overhangs each side of the pipe column, and how tall the cap is. */
const PIPE_CAP_OVERHANG = 5
const PIPE_CAP_HEIGHT = 18
/**
 * Fraction of the surface height at which the ground's top edge sits. This is the game's authoritative
 * collision line: `flappy_bird_env` sets `self._ground["y"] = screen_height * 0.79` and a ground crash
 * fires when the bird's bottom reaches it. The drawn ground top MUST match this, or the bird looks like
 * it ends the game floating in mid-air (the painted ground was 52px too low under the old 56px constant).
 */
export const GROUND_RATIO = 0.79
/** Fallback logical surface when the overlay omits it (a degenerate state); the pinned game is 288×512. */
const DEFAULT_WIDTH = 288
const DEFAULT_HEIGHT = 512

/** Flat-color palette for the original vector art. */
export const COLORS = {
  // Sky reads as a soft vertical wash from a pale top to the game's signature teal.
  skyTop: '#bdeef2',
  sky: '#4ec0ca',
  cloud: '#ffffff',
  // Rolling hills sit on the horizon, a muted green so the foreground pipes still pop.
  hill: '#84cf6b',
  hillFar: '#9ad97f',
  // Pipes are shaded like glossy cylinders: dark rim, a bright highlight band, body, then shadow.
  pipe: '#5bb33a',
  pipeLight: '#86d957',
  pipeDark: '#3f8c28',
  pipeShadow: '#2f6b1d',
  pipeEdge: '#3f8c28',
  // The ground is a grass cap over a dirt body, each with a little internal shading and texture.
  grass: '#9ad24f',
  grassDark: '#74ab38',
  ground: '#ded895',
  groundDark: '#c8bf72',
  groundEdge: '#5bb33a',
  groundDash: '#cabf6c',
  // The bird body is shaded top-light; the beak and eye are ported from the old 2D rasterizer.
  bird: '#f4d03f',
  birdLight: '#ffe45e',
  birdDark: '#e3b520',
  birdEdge: '#c79a1e',
  hud: '#ffffff',
  hudShadow: 'rgba(0,0,0,0.45)',
} as const

/**
 * A multi-stop linear gradient fill, resolved by the renderer into a cached PixiJS `FillGradient`.
 * `dir` is the axis in the shape's own local box (0→1), so one gradient instance reshades any size.
 */
export interface GradientFill {
  dir: 'vertical' | 'horizontal'
  stops: Array<{ offset: number; color: string }>
}

/** A filled rectangle (sky, pipes, ground), optionally gradient-shaded, rounded, and/or outlined. */
export interface RectShape {
  kind: 'rect'
  x: number
  y: number
  w: number
  h: number
  fill: string
  /** When present, fills with this gradient instead of the flat `fill`. */
  gradient?: GradientFill
  /** Corner radius for rounded rectangles (the pipe caps); 0/absent draws square corners. */
  radius?: number
  /** A thin outline (the pipe caps use it to read crisply against the body). */
  stroke?: { color: string; width: number }
  alpha?: number
}

/** A filled circle (cloud puffs and horizon hills), the soft organic counterpoint to the rects. */
export interface CircleShape {
  kind: 'circle'
  x: number
  y: number
  radius: number
  fill: string
  alpha?: number
}

/** The bird, drawn as a rotated body centered at (x, y) with a wing whose lift tracks `wing`. */
export interface BirdShape {
  kind: 'bird'
  x: number
  y: number
  radius: number
  /** Rotation in degrees, straight from the overlay's `rot`. */
  rot: number
  /** Wing lift in [-1, 1]: +1 on the upstroke (just flapped), -1 on the downstroke (falling). */
  wing: number
  fill: string
  edge: string
}

export type Shape = RectShape | CircleShape | BirdShape

/** One piece of HUD text drawn into the canvas (the in-game UI, per the chrome split). */
export interface HudText {
  text: string
  x: number
  y: number
  size: number
  align: 'left' | 'center' | 'right'
  fill: string
  /** An outline drawn under the fill so the big score stays crisp over any background. */
  stroke?: { color: string; width: number }
}

/** Everything needed to paint one frame: the surface size, the shapes, and the in-game HUD. */
export interface Scene {
  width: number
  height: number
  shapes: Shape[]
  hud: HudText[]
}

/** Mount-time constants the scene needs beyond the state (kept out so `computeScene` stays pure). */
export interface SceneConfig {
  /** The environment's pace interval, used to turn the tick into an elapsed-time HUD readout. */
  paceIntervalMs?: number | null
}

interface Overlay {
  width: number
  height: number
  player: { x: number; y: number; velY: number; rot: number }
  pipes: Array<{ x: number; gapTop: number; gapBottom: number }>
  pipesPassed: number
}

// --- Shared gradient definitions (one object per look, reused across shapes and frames). ---

/** Pale top fading to the signature teal — the whole-surface backdrop. */
const SKY_GRADIENT: GradientFill = {
  dir: 'vertical',
  stops: [
    { offset: 0, color: COLORS.skyTop },
    { offset: 1, color: COLORS.sky },
  ],
}

/** A glossy-cylinder shading across the pipe width: dark rim, bright highlight, body, deep shadow. */
const PIPE_GRADIENT: GradientFill = {
  dir: 'horizontal',
  stops: [
    { offset: 0, color: COLORS.pipeDark },
    { offset: 0.14, color: COLORS.pipeLight },
    { offset: 0.46, color: COLORS.pipe },
    { offset: 0.78, color: COLORS.pipeDark },
    { offset: 1, color: COLORS.pipeShadow },
  ],
}

/** Grass cap: bright at the top edge, settling into a darker green. */
const GRASS_GRADIENT: GradientFill = {
  dir: 'vertical',
  stops: [
    { offset: 0, color: COLORS.grass },
    { offset: 1, color: COLORS.grassDark },
  ],
}

/** Dirt body: the sandy ground color fading slightly darker toward the bottom. */
const DIRT_GRADIENT: GradientFill = {
  dir: 'vertical',
  stops: [
    { offset: 0, color: COLORS.ground },
    { offset: 1, color: COLORS.groundDark },
  ],
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** Normalize the open-typed overlay into a safe, fully-defaulted shape. */
function readOverlay(state: StepState): Overlay {
  const overlay = (state.overlay ?? {}) as Record<string, unknown>
  const player = (overlay.player ?? {}) as Record<string, unknown>
  const rawPipes = Array.isArray(overlay.pipes) ? overlay.pipes : []
  return {
    width: num(overlay.width, DEFAULT_WIDTH),
    height: num(overlay.height, DEFAULT_HEIGHT),
    player: {
      x: num(player.x, 0),
      y: num(player.y, 0),
      velY: num(player.vel_y, 0),
      rot: num(player.rot, 0),
    },
    pipes: rawPipes.map((raw) => {
      const pipe = (raw ?? {}) as Record<string, unknown>
      return {
        x: num(pipe.x, 0),
        gapTop: num(pipe.gap_top, 0),
        gapBottom: num(pipe.gap_bottom, 0),
      }
    }),
    pipesPassed: num(overlay.pipes_passed, 0),
  }
}

/** The cumulative score for the human slot, the one number that matters in the HUD. */
function readScore(state: StepState): number {
  return num(state.agents?.player_0?.score, 0)
}

/** Format the score: an integer when whole, else one decimal, so the big number stays readable. */
export function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1)
}

/**
 * A value that drifts left and wraps over `span`, from a base offset, paced by the tick. Deterministic
 * in the tick alone, so the parallax backdrop never breaks the scrubber's same-state-same-scene rule.
 */
function drift(base: number, tick: number, speed: number, span: number): number {
  return (((base - tick * speed) % span) + span) % span
}

/** Push a soft three-puff cloud centered at (cx, cy), scaled by `r`. */
function pushCloud(shapes: Shape[], cx: number, cy: number, r: number): void {
  const puffs: Array<[number, number]> = [
    [-r, 0],
    [0, -r * 0.5],
    [r, 0],
  ]
  for (const [dx, dy] of puffs) {
    shapes.push({
      kind: 'circle',
      x: cx + dx,
      y: cy + dy,
      radius: r * (dx === 0 ? 1.15 : 0.9),
      fill: COLORS.cloud,
      alpha: 0.9,
    })
  }
}

/**
 * The parallax backdrop behind the pipes: a few clouds drifting slowly across the sky and a row of
 * rounded hills sitting on the horizon. Both scroll with the tick (clouds faster than hills) so the
 * world reads as moving, and both are clipped by the ground, which paints over their lower halves.
 */
function pushBackdrop(
  shapes: Shape[],
  width: number,
  height: number,
  groundY: number,
  tick: number,
): void {
  // Hills first (farthest back): two staggered bands of humps along the horizon.
  const horizon = groundY
  const farR = width * 0.42
  const nearR = width * 0.34
  const farSpan = width + farR
  const nearSpan = width + nearR
  for (let i = -1; i <= 2; i++) {
    shapes.push({
      kind: 'circle',
      x: drift(i * farSpan * 0.5, tick, 0.08, farSpan) - farR * 0.5,
      y: horizon + farR * 0.35,
      radius: farR,
      fill: COLORS.hillFar,
    })
  }
  for (let i = -1; i <= 2; i++) {
    shapes.push({
      kind: 'circle',
      x: drift(i * nearSpan * 0.6 + nearR, tick, 0.16, nearSpan) - nearR * 0.5,
      y: horizon + nearR * 0.55,
      radius: nearR,
      fill: COLORS.hill,
    })
  }

  // Clouds (in front of the hills, still behind the pipes): three puffs at fixed heights, drifting left.
  const span = width + 100
  const clouds: Array<[number, number, number]> = [
    [50, height * 0.16, 18],
    [170, height * 0.27, 14],
    [255, height * 0.11, 11],
  ]
  for (const [base, cy, r] of clouds) {
    pushCloud(shapes, drift(base + 50, tick, 0.3, span) - 50, cy, r)
  }
}

/** Push one pipe: a shaded top and bottom column, each finished with a rounded, outlined cap. */
function pushPipe(
  shapes: Shape[],
  pipe: { x: number; gapTop: number; gapBottom: number },
  groundY: number,
): void {
  const cap = (y: number): RectShape => ({
    kind: 'rect',
    x: pipe.x - PIPE_CAP_OVERHANG,
    y,
    w: PIPE_WIDTH + PIPE_CAP_OVERHANG * 2,
    h: PIPE_CAP_HEIGHT,
    fill: COLORS.pipe,
    gradient: PIPE_GRADIENT,
    radius: 4,
    stroke: { color: COLORS.pipeShadow, width: 1.5 },
  })

  // Top column: surface top down to the gap, then a cap sitting at the gap edge.
  shapes.push({
    kind: 'rect',
    x: pipe.x,
    y: 0,
    w: PIPE_WIDTH,
    h: pipe.gapTop,
    fill: COLORS.pipe,
    gradient: PIPE_GRADIENT,
  })
  shapes.push(cap(pipe.gapTop - PIPE_CAP_HEIGHT))
  // Bottom column: the gap edge down to the ground, with its cap at the top.
  shapes.push({
    kind: 'rect',
    x: pipe.x,
    y: pipe.gapBottom,
    w: PIPE_WIDTH,
    h: groundY - pipe.gapBottom,
    fill: COLORS.pipe,
    gradient: PIPE_GRADIENT,
  })
  shapes.push(cap(pipe.gapBottom))
}

/** Push the layered ground: a green grass cap, a dirt body, and a drifting dash texture in the dirt. */
function pushGround(
  shapes: Shape[],
  width: number,
  height: number,
  groundY: number,
  tick: number,
): void {
  const grassH = 12
  // Grass cap with a thin bright lip along its very top edge for a touch of relief.
  shapes.push({
    kind: 'rect',
    x: 0,
    y: groundY,
    w: width,
    h: grassH,
    fill: COLORS.grass,
    gradient: GRASS_GRADIENT,
  })
  shapes.push({ kind: 'rect', x: 0, y: groundY, w: width, h: 2, fill: COLORS.grass })
  // Dirt body filling the rest of the surface.
  const dirtY = groundY + grassH
  shapes.push({
    kind: 'rect',
    x: 0,
    y: dirtY,
    w: width,
    h: height - dirtY,
    fill: COLORS.ground,
    gradient: DIRT_GRADIENT,
  })
  // A scrolling row of dashes just under the grass line, to sell the forward motion.
  const dashW = 16
  const gap = 12
  const stride = dashW + gap
  const offset = drift(0, tick, 1.4, stride)
  for (let x = -offset; x < width; x += stride) {
    shapes.push({ kind: 'rect', x, y: dirtY + 5, w: dashW, h: 5, fill: COLORS.groundDash })
  }
}

/**
 * Turn one state into a scene: the gradient sky and parallax backdrop, the pipes, the layered ground,
 * and the bird, plus the HUD (the big score, the pipe counter, and the tick/time readout). Depends only
 * on the state plus the mount-time config, so the same state always yields the same scene.
 */
export function computeScene(state: StepState, config: SceneConfig = {}): Scene {
  const o = readOverlay(state)
  // The ground top is the game's collision line (height * 0.79), not a fixed-height strip, so the bird
  // visibly meets the ground at the same y the env ends the game on.
  const groundY = o.height * GROUND_RATIO
  const shapes: Shape[] = []

  // Sky wash, then the drifting clouds and horizon hills behind everything.
  shapes.push({
    kind: 'rect',
    x: 0,
    y: 0,
    w: o.width,
    h: o.height,
    fill: COLORS.sky,
    gradient: SKY_GRADIENT,
  })
  pushBackdrop(shapes, o.width, o.height, groundY, state.tick)

  // Pipes, then the ground painted over their feet and the backdrop's lower halves.
  for (const pipe of o.pipes) {
    pushPipe(shapes, pipe, groundY)
  }
  pushGround(shapes, o.width, o.height, groundY, state.tick)

  // Bird, centered on the sprite box from its top-left overlay position. The wing lifts on the
  // upstroke: a flap drives `vel_y` negative (upward), so `-vel_y` maps cleanly to wing lift.
  shapes.push({
    kind: 'bird',
    x: o.player.x + PLAYER_WIDTH / 2,
    y: o.player.y + PLAYER_HEIGHT / 2,
    radius: PLAYER_HEIGHT / 2,
    rot: o.player.rot,
    wing: clamp(-o.player.velY / 9, -1, 1),
    fill: COLORS.bird,
    edge: COLORS.birdEdge,
  })

  const hud: HudText[] = [
    // The big score: the one number that matters, outlined so it holds up over pipes and sky alike.
    {
      text: formatScore(readScore(state)),
      x: o.width / 2,
      y: 46,
      size: 36,
      align: 'center',
      fill: COLORS.hud,
      stroke: { color: 'rgba(0,0,0,0.55)', width: 4 },
    },
    // The pipe counter and the tick/time readout, smaller, top corners.
    { text: `pipes ${o.pipesPassed}`, x: 8, y: 20, size: 14, align: 'left', fill: COLORS.hud },
    {
      text: tickReadout(state.tick, config.paceIntervalMs),
      x: o.width - 8,
      y: 20,
      size: 14,
      align: 'right',
      fill: COLORS.hud,
    },
  ]

  return { width: o.width, height: o.height, shapes, hud }
}

/** The tick readout, doubling as a time indicator when the environment is paced. */
function tickReadout(tick: number, paceIntervalMs?: number | null): string {
  if (paceIntervalMs && paceIntervalMs > 0) {
    const seconds = (tick * paceIntervalMs) / 1000
    return `${seconds.toFixed(1)}s`
  }
  return `tick ${tick}`
}
