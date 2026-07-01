import { describe, expect, it } from 'vitest'

import { liveIntervalMs, playbackIntervalMs } from '../src/lib/playback.js'
import { flappyMeta, heartsMeta } from './helpers/fixtures.js'

describe('playbackIntervalMs', () => {
  it('uses the step interval for a realtime environment, ignoring any view interval', () => {
    // Flappy Bird is paced (pace_interval_ms = 50); a view_interval_ms, were one set, must not win.
    expect(playbackIntervalMs(flappyMeta())).toBe(50)
    expect(playbackIntervalMs(flappyMeta({ view_interval_ms: 9000 }))).toBe(50)
  })

  it('uses the declared view interval for a turn-based environment', () => {
    // Hearts has no step interval but declares a 3000 ms viewing cadence.
    expect(playbackIntervalMs(heartsMeta())).toBe(3000)
  })

  it('is null when neither interval is set, so the caller applies its own default', () => {
    expect(playbackIntervalMs(heartsMeta({ view_interval_ms: null }))).toBeNull()
    expect(playbackIntervalMs(null)).toBeNull()
    expect(playbackIntervalMs(undefined)).toBeNull()
  })
})

describe('liveIntervalMs', () => {
  it('reads the live human throttle cadence when the env declares one', () => {
    // Hearts declares a 900 ms live cadence; it is independent of the 3000 ms spectator view interval.
    expect(liveIntervalMs(heartsMeta())).toBe(900)
  })

  it('is null when the env declares none, so the human session stays unbuffered', () => {
    expect(liveIntervalMs(flappyMeta())).toBeNull()
    expect(liveIntervalMs(heartsMeta({ live_interval_ms: null }))).toBeNull()
    expect(liveIntervalMs(null)).toBeNull()
    expect(liveIntervalMs(undefined)).toBeNull()
  })
})
