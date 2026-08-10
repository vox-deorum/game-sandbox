import { describe, expect, it } from 'vitest'

import {
  resolveSessionMaxDurationMs,
  SESSION_OVERHEAD_ALLOWANCE_MS,
  UNPACED_SESSION_MAX_DURATION_MS,
} from '../../src/session/session-duration.js'

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
    expect(resolveSessionMaxDurationMs(paced)).toBe(
      1200 * 250 + 3 * 120_000 + SESSION_OVERHEAD_ALLOWANCE_MS,
    )
  })

  it('fits a paced Three Branches cast_5 watch day inside the derived limit', () => {
    expect(
      resolveSessionMaxDurationMs({
        overrideMs: null,
        paceIntervalMs: 250,
        recommendedEpisodeTicks: 1200,
        agentPlayerCount: 6,
        episodeTimeoutMs: 120_000,
      }),
    ).toBe(18 * 60 * 1_000)
  })

  it('derives a paced session limit with no agent budget for a fully human layout', () => {
    expect(resolveSessionMaxDurationMs({ ...paced, agentPlayerCount: 0 })).toBe(
      1200 * 250 + SESSION_OVERHEAD_ALLOWANCE_MS,
    )
  })

  it.each([
    null,
    0,
  ])('uses the fixed fallback when pacing is absent or nonpositive: %s', (paceIntervalMs) => {
    expect(resolveSessionMaxDurationMs({ ...paced, paceIntervalMs })).toBe(
      UNPACED_SESSION_MAX_DURATION_MS,
    )
  })
})
