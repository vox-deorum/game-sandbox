import type { StepState } from '@game-sandbox/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RenderOptions } from '../src/renderers/types.js'
import { parseRecording, UnsupportedVersionError } from '../src/replay/parse.js'
import { type ReplayState, ReplayTransport } from '../src/replay/transport.js'

function state(tick: number): StepState {
  return { schema_version: 1, tick, agents: {}, timing: { started_at: tick, duration_ms: 1 } }
}

const STATES = [state(0), state(1), state(2), state(3)]

/**
 * A transport over a fake renderer. When `deferred` is set, `onFrame` hands back a promise the test
 * finishes by hand, which is how these tests tell the cadence floor apart from the renderer's actual
 * transition completion.
 */
function makeTransport(paceIntervalMs: number | null = 50, deferred = false) {
  const frames: number[] = []
  const optionsSeen: Array<RenderOptions | undefined> = []
  const finish: Array<() => void> = []
  let last: ReplayState | null = null
  const transport = new ReplayTransport(STATES, {
    paceIntervalMs,
    // The fixture's tick equals its index, so recording the rendered state's tick gives the frame
    // sequence the assertions below expect.
    onFrame: (s, options) => {
      frames.push(s.tick)
      optionsSeen.push(options)
      if (!deferred) return
      return new Promise<void>((resolve) => finish.push(resolve))
    },
    onChange: (s) => {
      last = s
    },
  })
  return {
    transport,
    frames,
    optionsSeen,
    state: () => last,
    /** Complete every transition handed out so far. */
    finishTransitions: () => {
      for (const resolve of finish.splice(0)) resolve()
    },
  }
}

describe('ReplayTransport', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('plays forward on the pace interval and stops at the end', async () => {
    const { transport, frames } = makeTransport(50)
    transport.play()
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(50)
    // Advanced through indices 1, 2, 3 then stops (no further frames).
    expect(frames).toEqual([1, 2, 3])
    expect(transport.playing).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(frames).toEqual([1, 2, 3])
  })

  it('passes the cadence as a scale relative to a one-second beat', async () => {
    const { transport, optionsSeen } = makeTransport(500)
    transport.play()
    await vi.advanceTimersByTimeAsync(500)
    expect(optionsSeen.at(-1)).toEqual({ transitionScale: 0.5 })
  })

  it('waits for the renderer as well as the cadence before advancing', async () => {
    const { transport, frames, finishTransitions } = makeTransport(50, true)
    transport.play()
    await vi.advanceTimersByTimeAsync(50)
    expect(frames).toEqual([1])

    // The cadence has passed several times over, but frame 1 is still animating, so nothing follows it.
    await vi.advanceTimersByTimeAsync(500)
    expect(frames).toEqual([1])

    // Completing it releases the pump, which then still owes the next frame a full cadence.
    finishTransitions()
    await vi.advanceTimersByTimeAsync(0)
    expect(frames).toEqual([1, 2])
  })

  it('pause stops the pump', async () => {
    const { transport, frames } = makeTransport(50)
    transport.play()
    await vi.advanceTimersByTimeAsync(50)
    transport.pause()
    await vi.advanceTimersByTimeAsync(500)
    expect(frames).toEqual([1])
    expect(transport.playing).toBe(false)
  })

  it('never leaves an obsolete pump advancing behind a resumed one', async () => {
    const { transport, frames } = makeTransport(50)
    transport.play()
    transport.pause()
    transport.play()
    await vi.advanceTimersByTimeAsync(50)
    // One pump, one frame: the retired generation does not also advance.
    expect(frames).toEqual([1])
  })

  it('gives a frame sought during playback a whole cadence of its own', async () => {
    const { transport, frames } = makeTransport(50)
    transport.play()
    await vi.advanceTimersByTimeAsync(30)
    transport.seek(0)
    expect(frames).toEqual([0])
    // The 20 ms left of the interrupted cadence must not carry the next advance.
    await vi.advanceTimersByTimeAsync(30)
    expect(frames).toEqual([0])
    await vi.advanceTimersByTimeAsync(20)
    expect(frames).toEqual([0, 1])
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
    const { transport, frames, optionsSeen } = makeTransport()
    transport.seek(3)
    expect(transport.index).toBe(3)
    expect(frames.at(-1)).toBe(3)
    transport.seek(99)
    expect(transport.index).toBe(3) // clamped to the last
    expect(optionsSeen.slice(-2)).toEqual([
      { snap: true, seek: true },
      { snap: true, seek: true },
    ])
  })

  it('marks a same-index render as a seek', () => {
    const { transport, optionsSeen } = makeTransport()
    transport.renderCurrent()
    transport.stepBack()
    expect(optionsSeen).toEqual([
      { snap: true, seek: true },
      { snap: true, seek: true },
    ])
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
