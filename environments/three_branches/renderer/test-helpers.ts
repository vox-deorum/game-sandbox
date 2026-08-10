import fixture from '../../../frontend/test/fixtures/three-branches-recording.jsonl?raw'
import { decodeDynamic, decodeStatic } from './overlay.js'

export const recording = fixture
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Record<string, unknown>)

export const header = recording[0] as { overlay_static: unknown }
export const states = recording.slice(1).map((frame) => frame.overlay)
export const staticOverlay = decodeStatic(header.overlay_static)
export const firstDynamic = decodeDynamic(states[0], staticOverlay)
