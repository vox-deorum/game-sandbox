import type { StepState } from '@game-sandbox/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseRecording, UnsupportedVersionError } from '../src/replay/parse.js'
import { type ReplayState, ReplayTransport } from '../src/replay/transport.js'

function state(tick: number): StepState {
  return { schema_version: 1, tick, agents: {}, timing: { started_at: tick, duration_ms: 1 } }
}

const STATES = [state(0), state(1), state(2), state(3)]

function makeTransport(paceIntervalMs: number | null = 50) {
  const frames: number[] = []
  let last: ReplayState | null = null
  const transport = new ReplayTransport(STATES, {
    paceIntervalMs,
    onFrame: (_s, index) => frames.push(index),
    onChange: (s) => {
      last = s
    },
  })
  return { transport, frames, state: () => last }
}

describe('ReplayTransport', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('plays forward on the pace interval and stops at the end', () => {
    const { transport, frames } = makeTransport(50)
    transport.play()
    vi.advanceTimersByTime(50)
    vi.advanceTimersByTime(50)
    vi.advanceTimersByTime(50)
    // Advanced through indices 1, 2, 3 then stops (no further frames).
    expect(frames).toEqual([1, 2, 3])
    expect(transport.playing).toBe(false)
    vi.advanceTimersByTime(200)
    expect(frames).toEqual([1, 2, 3])
  })

  it('pause stops the timer', () => {
    const { transport, frames } = makeTransport(50)
    transport.play()
    vi.advanceTimersByTime(50)
    transport.pause()
    vi.advanceTimersByTime(500)
    expect(frames).toEqual([1])
    expect(transport.playing).toBe(false)
  })

  it('steps one state forward and back, clamped at the ends', () => {
    const { transport } = makeTransport()
    transport.stepBack()
    expect(transport.index).toBe(0)
    transport.stepForward()
    transport.stepForward()
    expect(transport.index).toBe(2)
    transport.stepBack()
    expect(transport.index).toBe(1)
  })

  it('scrubs by rendering the state under the index', () => {
    const { transport, frames } = makeTransport()
    transport.seek(3)
    expect(transport.index).toBe(3)
    expect(frames.at(-1)).toBe(3)
    transport.seek(99)
    expect(transport.index).toBe(3) // clamped to the last
  })

  it('seeks to a tick (the ?t= deep link), falling to the latest frame at or before it', () => {
    const { transport } = makeTransport()
    transport.seekToTick(2)
    expect(transport.index).toBe(2)
    transport.seekToTick(99)
    expect(transport.index).toBe(3)
  })
})

describe('parseRecording', () => {
  const header = JSON.stringify({ schema_version: 1, environment: 'flappy_bird', seed: 0 })

  it('parses the header and the readable prefix of states', () => {
    const text = `${header}\n${JSON.stringify(state(0))}\n${JSON.stringify(state(1))}\n`
    const parsed = parseRecording(text)
    expect(parsed.header.environment).toBe('flappy_bird')
    expect(parsed.states.map((s) => s.tick)).toEqual([0, 1])
  })

  it('stops at a truncated trailing line rather than failing', () => {
    const text = `${header}\n${JSON.stringify(state(0))}\n{"schema_version":1,"tick":1,`
    expect(parseRecording(text).states.map((s) => s.tick)).toEqual([0])
  })

  it('reports an unknown header version as needing a newer viewer', () => {
    const text = `${JSON.stringify({ schema_version: 2, environment: 'flappy_bird' })}\n`
    expect(() => parseRecording(text)).toThrow(UnsupportedVersionError)
  })
})
