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
/** Height of the ground strip drawn along the bottom, a visual constant matching the game's base. */
export const GROUND_HEIGHT = 56
/** Fallback logical surface when the overlay omits it (a degenerate state); the pinned game is 288×512. */
const DEFAULT_WIDTH = 288
const DEFAULT_HEIGHT = 512

/** Flat-color palette for the original vector art. */
export const COLORS = {
  sky: '#4ec0ca',
  pipe: '#5bb33a',
  pipeEdge: '#3f8c28',
  ground: '#ded895',
  groundEdge: '#5bb33a',
  bird: '#f4d03f',
  birdEdge: '#c79a1e',
  hud: '#ffffff',
  hudShadow: 'rgba(0,0,0,0.45)',
} as const

/** A filled rectangle (sky bands, pipes, ground). */
export interface RectShape {
  kind: 'rect'
  x: number
  y: number
  w: number
  h: number
  fill: string
}

/** The bird, drawn as a rotated body centered at (x, y). */
export interface BirdShape {
  kind: 'bird'
  x: number
  y: number
  radius: number
  /** Rotation in degrees, straight from the overlay's `rot`. */
  rot: number
  fill: string
  edge: string
}

export type Shape = RectShape | BirdShape

/** One piece of HUD text drawn into the canvas (the in-game UI, per the chrome split). */
export interface HudText {
  text: string
  x: number
  y: number
  size: number
  align: 'left' | 'center' | 'right'
  fill: string
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

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
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
 * Turn one state into a scene: the sky, the pipes, the ground, the bird, and the HUD (the big score,
 * the pipe counter, and the tick/time readout). Depends only on the state plus the mount-time config,
 * so the same state always yields the same scene.
 */
export function computeScene(state: StepState, config: SceneConfig = {}): Scene {
  const o = readOverlay(state)
  const groundY = o.height - GROUND_HEIGHT
  const shapes: Shape[] = []

  // Sky.
  shapes.push({ kind: 'rect', x: 0, y: 0, w: o.width, h: o.height, fill: COLORS.sky })

  // Pipes: a top column from the surface top down to the gap, and a bottom column from the gap down
  // to the ground. Each gets a darker lip at the gap edge so it reads as a pipe, not a bar.
  for (const pipe of o.pipes) {
    shapes.push({ kind: 'rect', x: pipe.x, y: 0, w: PIPE_WIDTH, h: pipe.gapTop, fill: COLORS.pipe })
    shapes.push({
      kind: 'rect',
      x: pipe.x - 2,
      y: pipe.gapTop - 12,
      w: PIPE_WIDTH + 4,
      h: 12,
      fill: COLORS.pipeEdge,
    })
    shapes.push({
      kind: 'rect',
      x: pipe.x,
      y: pipe.gapBottom,
      w: PIPE_WIDTH,
      h: groundY - pipe.gapBottom,
      fill: COLORS.pipe,
    })
    shapes.push({
      kind: 'rect',
      x: pipe.x - 2,
      y: pipe.gapBottom,
      w: PIPE_WIDTH + 4,
      h: 12,
      fill: COLORS.pipeEdge,
    })
  }

  // Ground.
  shapes.push({ kind: 'rect', x: 0, y: groundY, w: o.width, h: 4, fill: COLORS.groundEdge })
  shapes.push({
    kind: 'rect',
    x: 0,
    y: groundY + 4,
    w: o.width,
    h: GROUND_HEIGHT - 4,
    fill: COLORS.ground,
  })

  // Bird, centered on the sprite box from its top-left overlay position.
  shapes.push({
    kind: 'bird',
    x: o.player.x + PLAYER_WIDTH / 2,
    y: o.player.y + PLAYER_HEIGHT / 2,
    radius: PLAYER_HEIGHT / 2,
    rot: o.player.rot,
    fill: COLORS.bird,
    edge: COLORS.birdEdge,
  })

  const hud: HudText[] = [
    // The big score: the one number that matters.
    {
      text: formatScore(readScore(state)),
      x: o.width / 2,
      y: 44,
      size: 34,
      align: 'center',
      fill: COLORS.hud,
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
