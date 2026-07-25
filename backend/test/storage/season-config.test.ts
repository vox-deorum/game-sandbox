/**
 * Unit coverage for the `SeasonConfig` zod codec (Stage 6.1): the single validated gate over the
 * `seasons.config` JSON column. It proves the codec round-trips a valid document, rejects the
 * malformed shapes the admin API relies on it to catch (unknown keys, empty seats, zero games, empty
 * seeds, a malformed match design), and stores the inert `messaging`/`llm` override blocks untouched.
 */
import { describe, expect, it } from 'vitest'

import {
  decodeSeasonConfig,
  emptySeasonConfig,
  encodeSeasonConfig,
  parseSeasonConfig,
  type SeasonConfig,
  SeasonConfigError,
} from '../../src/storage/season-config.js'

function validConfig(overrides: Partial<SeasonConfig> = {}): SeasonConfig {
  return {
    deps_version: 1,
    matches: [{ seats: ['submission'], seeds: [1, 2, 3], games: 5 }],
    ...overrides,
  }
}

describe('SeasonConfig codec', () => {
  it('round-trips a valid document through encode/decode', () => {
    const config = validConfig({
      matches: [{ seats: ['builtin-naive', 'builtin-naive', 'submission'], seeds: [7], games: 2 }],
      overrides: { step_timeout_ms: 50, episode_timeout_ms: 30_000 },
    })
    expect(decodeSeasonConfig(encodeSeasonConfig(config))).toEqual(config)
  })

  it('accepts an empty match design (an unconfigured season)', () => {
    const config = emptySeasonConfig(1)
    expect(config).toEqual({ deps_version: 1, matches: [] })
    expect(parseSeasonConfig(config)).toEqual(config)
  })

  it('rejects an unknown top-level key', () => {
    expect(() => parseSeasonConfig({ ...validConfig(), bonus: true })).toThrow(SeasonConfigError)
  })

  it('rejects an unknown key inside a match', () => {
    expect(() =>
      parseSeasonConfig(
        validConfig({ matches: [{ seats: ['submission'], seeds: [1], games: 1, x: 0 } as never] }),
      ),
    ).toThrow(SeasonConfigError)
  })

  it('rejects empty match seats', () => {
    expect(() =>
      parseSeasonConfig(validConfig({ matches: [{ seats: [], seeds: [1], games: 1 }] })),
    ).toThrow(SeasonConfigError)
  })

  it('rejects a non-positive game count', () => {
    expect(() =>
      parseSeasonConfig(
        validConfig({ matches: [{ seats: ['submission'], seeds: [1], games: 0 }] }),
      ),
    ).toThrow(SeasonConfigError)
  })

  it('rejects an empty seed list', () => {
    expect(() =>
      parseSeasonConfig(validConfig({ matches: [{ seats: ['submission'], seeds: [], games: 1 }] })),
    ).toThrow(SeasonConfigError)
  })

  it('rejects an unknown slot spec', () => {
    expect(() =>
      parseSeasonConfig(
        validConfig({ matches: [{ seats: ['robot' as never], seeds: [1], games: 1 }] }),
      ),
    ).toThrow(SeasonConfigError)
  })

  it('rejects a non-integer deps_version', () => {
    expect(() => parseSeasonConfig(validConfig({ deps_version: 1.5 }))).toThrow(SeasonConfigError)
  })

  it('rejects malformed stored JSON', () => {
    expect(() => decodeSeasonConfig('{not json')).toThrow(SeasonConfigError)
  })

  it('round-trips a positive submission_max_size_mb override', () => {
    const config = validConfig({ overrides: { submission_max_size_mb: 10 } })
    expect(decodeSeasonConfig(encodeSeasonConfig(config)).overrides?.submission_max_size_mb).toBe(
      10,
    )
  })

  it('rejects a zero, negative, or non-integer submission_max_size_mb', () => {
    expect(() =>
      parseSeasonConfig(validConfig({ overrides: { submission_max_size_mb: 0 } })),
    ).toThrow(SeasonConfigError)
    expect(() =>
      parseSeasonConfig(validConfig({ overrides: { submission_max_size_mb: -5 } })),
    ).toThrow(SeasonConfigError)
    expect(() =>
      parseSeasonConfig(validConfig({ overrides: { submission_max_size_mb: 2.5 } })),
    ).toThrow(SeasonConfigError)
  })

  it('round-trips the strict messaging and llm overrides', () => {
    const config = validConfig({
      overrides: {
        messaging: { enabled: false, message_cap: 80 },
        llm: {
          enabled: true,
          models: ['small', 'medium'],
          cost_weights: { small: 0.5, medium: 2.5 },
          official: { token_budget: 10_000 },
          development: { rate_limit_rpm: 20 },
        },
      },
    })
    const decoded = decodeSeasonConfig(encodeSeasonConfig(config))
    expect(decoded.overrides?.messaging).toEqual({ enabled: false, message_cap: 80 })
    expect(decoded.overrides?.llm).toEqual(config.overrides?.llm)
  })

  it('rejects empty, duplicate, unknown, and non-positive llm settings', () => {
    for (const llm of [
      { models: [] },
      { models: ['small', 'small'] },
      { models: ['unknown'] },
      { official: { token_budget: 0 } },
      { development: { rate_limit_rpm: -1 } },
      { development: { call_budget: 200 } },
      { cost_weights: { small: 0 } },
      { cost_weights: { large: 1_000_001 } },
      { cost_weights: { unknown: 1 } },
      { surprise: true },
    ]) {
      expect(() => parseSeasonConfig(validConfig({ overrides: { llm: llm as never } }))).toThrow(
        SeasonConfigError,
      )
    }
  })

  it('accepts either messaging field alone', () => {
    for (const messaging of [{ enabled: true }, { message_cap: 60 }, {}]) {
      expect(() => parseSeasonConfig(validConfig({ overrides: { messaging } }))).not.toThrow()
    }
  })

  it('rejects an unknown key or a bad type inside the messaging override', () => {
    expect(() =>
      parseSeasonConfig(validConfig({ overrides: { messaging: { disabled: true } as never } })),
    ).toThrow(SeasonConfigError)
    expect(() =>
      parseSeasonConfig(validConfig({ overrides: { messaging: { enabled: 'yes' } as never } })),
    ).toThrow(SeasonConfigError)
    expect(() =>
      parseSeasonConfig(validConfig({ overrides: { messaging: { message_cap: -1 } } })),
    ).toThrow(SeasonConfigError)
  })

  it('rejects an overrides block that is not an object', () => {
    expect(() => parseSeasonConfig(validConfig({ overrides: 5 as never }))).toThrow(
      SeasonConfigError,
    )
  })
})
