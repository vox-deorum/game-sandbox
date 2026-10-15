import { describe, expect, it } from 'vitest'

import { resolveSessionMaxDurationMs } from '../../src/session/session-duration.js'

describe('resolveSessionMaxDurationMs', () => {
  const paced = {
    overrideMs: null,
    paceIntervalMs: 250,
    recommendedEpisodeTicks: 1200,
    agentPlayerCount: 3,
    episodeTimeoutMs: 120_000,
  }

  it('keeps a positive deployment override ahead of environment-derived limits', () => {
    expect(resolveSessionMaxDurationMs({ ...paced, overrideMs: 123_456 })).toBe(123_456)
  })

  it('derives a paced session limit from pacing, agent budgets, and platform overhead', () => {
    expect(resolveSessionMaxDurationMs(paced)).toBe(720_000)
  })

  it('derives a paced session limit with no agent budget for a fully human layout', () => {
    expect(resolveSessionMaxDurationMs({ ...paced, agentPlayerCount: 0 })).toBe(360_000)
  })

  it.each([
    null,
    0,
  ])('uses the fixed fallback when pacing is absent or nonpositive: %s', (paceIntervalMs) => {
    expect(resolveSessionMaxDurationMs({ ...paced, paceIntervalMs })).toBe(600_000)
  })
})
