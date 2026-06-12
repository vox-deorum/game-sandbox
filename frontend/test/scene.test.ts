import type { StepState } from '@game-sandbox/schema'
import { describe, expect, it } from 'vitest'
import {
  type BirdShape,
  computeScene,
  formatScore,
  PIPE_WIDTH,
  type RectShape,
  type Scene,
} from '../src/renderers/flappy-bird/scene.js'
// A checked-in slice of a real Flappy Bird recording (header + per-step states): the determinism
// fixture doubles as the renderer fixture, so any visual regression has a byte-identical input. The
// `?raw` import (Vite) gives the file as a string, which works under jsdom where import.meta.url is
// not a file:// URL.
import fixture from './fixtures/flappy-recording.jsonl?raw'

const states: StepState[] = fixture
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .slice(1) // drop the header line
  .map((line) => JSON.parse(line) as StepState)

function birdOf(scene: Scene): BirdShape {
  const bird = scene.shapes.find((s): s is BirdShape => s.kind === 'bird')
  if (bird === undefined) {
    throw new Error('scene has no bird')
  }
  return bird
}

function pipeColumns(scene: Scene): RectShape[] {
  // Pipe columns are the full-width green rects (not the 12px-high edge lips).
  return scene.shapes.filter(
    (s): s is RectShape => s.kind === 'rect' && s.w === PIPE_WIDTH && s.h !== 12,
  )
}

describe('computeScene', () => {
  it('places the bird, every pipe, and the HUD from the overlay', () => {
    const first = states[0]
    if (first === undefined) {
      throw new Error('fixture has no states')
    }
    const scene = computeScene(first, { paceIntervalMs: 50 })

    // Surface from the overlay.
    expect(scene.width).toBe(288)
    expect(scene.height).toBe(512)

    // The bird is centered on its sprite box (overlay x/y is the top-left) and carries the rotation.
    const bird = birdOf(scene)
    expect(bird.x).toBeCloseTo(57 + 34 / 2)
    expect(bird.y).toBeCloseTo(236 + 24 / 2)
    expect(bird.rot).toBe(42)

    // Three pipes in the overlay → three top columns and three bottom columns.
    expect(pipeColumns(scene)).toHaveLength(6)
    // The first pipe's columns sit at its left-edge x.
    expect(pipeColumns(scene).some((r) => r.x === 284)).toBe(true)

    // The HUD shows the big score, the pipe counter, and a paced time readout.
    expect(scene.hud.map((h) => h.text)).toContain('pipes 0')
    expect(scene.hud.find((h) => h.align === 'center')?.text).toBe('0.1')
    expect(scene.hud.some((h) => h.text.endsWith('s'))).toBe(true)
  })

  it('is pure: shuffled states yield the same scenes as in order (the scrubber property)', () => {
    const inOrder = states.map((s) => computeScene(s, { paceIntervalMs: 50 }))
    const shuffled = [...states.keys()]
      .sort((a, b) => ((a * 7 + 3) % states.length) - ((b * 7 + 3) % states.length))
      .map((i) => states[i] as StepState)
    for (const state of shuffled) {
      const idx = states.indexOf(state)
      expect(computeScene(state, { paceIntervalMs: 50 })).toEqual(inOrder[idx])
    }
  })

  it('tolerates a degenerate state with no overlay', () => {
    const bare: StepState = {
      schema_version: 1,
      tick: 0,
      agents: {},
      timing: { started_at: 0, duration_ms: 0 },
    }
    const scene = computeScene(bare)
    // Falls back to the pinned game's surface and still draws a bird and a HUD.
    expect(scene.width).toBe(288)
    expect(scene.height).toBe(512)
    expect(birdOf(scene)).toBeDefined()
    expect(scene.hud.find((h) => h.align === 'center')?.text).toBe('0')
  })

  it('formats the score as an integer when whole, else one decimal', () => {
    expect(formatScore(3)).toBe('3')
    expect(formatScore(0.7999999999999999)).toBe('0.8')
  })

  it('shows the raw tick when the environment is unpaced', () => {
    const first = states[0] as StepState
    const scene = computeScene(first, { paceIntervalMs: null })
    expect(scene.hud.some((h) => h.text.startsWith('tick '))).toBe(true)
  })
})
