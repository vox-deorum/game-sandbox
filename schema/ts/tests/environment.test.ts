import { describe, expect, it } from 'vitest'

import { type EnvironmentMeta, isEnvironmentMeta } from '../src/index.js'

const VALID: EnvironmentMeta = {
  env_id: 'flappy_bird',
  display_name: 'Flappy Bird',
  description: 'A paced single-human clone.',
  min_slots: 1,
  max_slots: 1,
  human_slots: ['player_0'],
  human_timeout_ms: null,
  recommended_episode_ticks: 1000,
  pace_interval_ms: 50,
  step_limit_ms: 1000,
  episode_limit_ms: 120_000,
  messaging: false,
  message_cap: null,
  llm: false,
  renderer: 'flappy-bird',
}

describe('isEnvironmentMeta', () => {
  it('accepts a field-complete entry', () => {
    expect(isEnvironmentMeta(VALID)).toBe(true)
  })

  it('accepts the int-or-null fields as either', () => {
    expect(isEnvironmentMeta({ ...VALID, pace_interval_ms: null, human_timeout_ms: 5000 })).toBe(
      true,
    )
  })

  it('rejects a non-object', () => {
    expect(isEnvironmentMeta(null)).toBe(false)
    expect(isEnvironmentMeta('flappy_bird')).toBe(false)
  })

  it('rejects an entry missing a field', () => {
    const { renderer: _omitted, ...withoutRenderer } = VALID
    expect(isEnvironmentMeta(withoutRenderer)).toBe(false)
  })

  it('rejects an entry whose human_slots is not a string array', () => {
    expect(isEnvironmentMeta({ ...VALID, human_slots: [0, 1] })).toBe(false)
  })
})
