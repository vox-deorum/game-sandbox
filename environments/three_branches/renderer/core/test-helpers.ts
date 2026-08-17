import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import type { RendererTextFactory } from '@renderers/base/PixiRenderer.js'
import { Text } from 'pixi.js'

let cached: { header: RecordingHeader; states: StepState[] } | null = null

/** Reproduce the shared renderer text contract without mounting WebGL in layer unit tests. */
export const testText: RendererTextFactory = (
  value,
  size,
  fill,
  align,
  fontFamily = 'system-ui, sans-serif',
  stroke,
) => {
  const node = new Text({
    text: value,
    style: { fontFamily, fontWeight: 'bold', fontSize: size, fill, stroke },
  })
  node.resolution = 1
  node.anchor.set(align === 'left' ? 0 : align === 'right' ? 1 : 0.5, align === 'center' ? 0.5 : 0)
  return node
}

/** Read the committed recording once for renderer tests that need production-shaped data. */
export function fixtureRecording(): { header: RecordingHeader; states: StepState[] } {
  if (cached !== null) return cached
  const path = resolve(process.cwd(), 'test/fixtures/three-branches-recording.jsonl')
  const [headerLine, ...stateLines] = readFileSync(path, 'utf8').trim().split('\n')
  if (headerLine === undefined) throw new Error('Three Branches fixture is empty.')
  cached = {
    header: JSON.parse(headerLine) as RecordingHeader,
    states: stateLines.map((line) => JSON.parse(line) as StepState),
  }
  return cached
}

/** Clone a fixture header so rejection tests cannot mutate the shared cached value. */
export function clonedHeader(): RecordingHeader {
  return structuredClone(fixtureRecording().header)
}

/** Build the ordinary opening state that can precede a simultaneous live transition. */
export function openingState(): StepState {
  return {
    schema_version: 1,
    tick: 0,
    agents: {},
    timing: { started_at: 0, duration_ms: 0 },
  }
}
