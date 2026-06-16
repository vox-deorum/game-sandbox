/**
 * Unit coverage for the `IterationConfig` zod codec (Stage 6.1): the single validated gate over the
 * `iterations.config` JSON column. It proves the codec round-trips a valid document, rejects the
 * malformed shapes the admin API relies on it to catch (unknown keys, empty slots, zero games, empty
 * seeds, a malformed match design), and stores the inert `messaging`/`llm` override blocks untouched.
 */
import { describe, expect, it } from 'vitest'

import {
  decodeIterationConfig,
  emptyIterationConfig,
  encodeIterationConfig,
  type IterationConfig,
  IterationConfigError,
  parseIterationConfig,
} from '../src/storage/iteration-config.js'

function validConfig(overrides: Partial<IterationConfig> = {}): IterationConfig {
  return {
    deps_version: 1,
    matches: [{ slots: ['submission'], seeds: [1, 2, 3], games: 5 }],
    ...overrides,
  }
}

describe('IterationConfig codec', () => {
  it('round-trips a valid document through encode/decode', () => {
    const config = validConfig({
      matches: [{ slots: ['builtin-naive', 'builtin-naive', 'submission'], seeds: [7], games: 2 }],
      overrides: { step_timeout_ms: 50, episode_timeout_ms: 30_000 },
    })
    expect(decodeIterationConfig(encodeIterationConfig(config))).toEqual(config)
  })

  it('accepts an empty match design (an unconfigured iteration)', () => {
    const config = emptyIterationConfig(1)
    expect(config).toEqual({ deps_version: 1, matches: [] })
    expect(parseIterationConfig(config)).toEqual(config)
  })

  it('rejects an unknown top-level key', () => {
    expect(() => parseIterationConfig({ ...validConfig(), bonus: true })).toThrow(
      IterationConfigError,
    )
  })

  it('rejects an unknown key inside a match', () => {
    expect(() =>
      parseIterationConfig(
        validConfig({ matches: [{ slots: ['submission'], seeds: [1], games: 1, x: 0 } as never] }),
      ),
    ).toThrow(IterationConfigError)
  })

  it('rejects empty match slots', () => {
    expect(() =>
      parseIterationConfig(validConfig({ matches: [{ slots: [], seeds: [1], games: 1 }] })),
    ).toThrow(IterationConfigError)
  })

  it('rejects a non-positive game count', () => {
    expect(() =>
      parseIterationConfig(
        validConfig({ matches: [{ slots: ['submission'], seeds: [1], games: 0 }] }),
      ),
    ).toThrow(IterationConfigError)
  })

  it('rejects an empty seed list', () => {
    expect(() =>
      parseIterationConfig(
        validConfig({ matches: [{ slots: ['submission'], seeds: [], games: 1 }] }),
      ),
    ).toThrow(IterationConfigError)
  })

  it('rejects an unknown slot spec', () => {
    expect(() =>
      parseIterationConfig(
        validConfig({ matches: [{ slots: ['robot' as never], seeds: [1], games: 1 }] }),
      ),
    ).toThrow(IterationConfigError)
  })

  it('rejects a non-integer deps_version', () => {
    expect(() => parseIterationConfig(validConfig({ deps_version: 1.5 }))).toThrow(
      IterationConfigError,
    )
  })

  it('rejects malformed stored JSON', () => {
    expect(() => decodeIterationConfig('{not json')).toThrow(IterationConfigError)
  })

  it('stores the inert messaging/llm override blocks untouched', () => {
    const config = validConfig({
      overrides: {
        messaging: { disabled: true, max_length: 280, future: { nested: 1 } },
        llm: { model_allowlist: ['claude-opus-4-8'], token_budget: 10_000 },
      },
    })
    const decoded = decodeIterationConfig(encodeIterationConfig(config))
    expect(decoded.overrides?.messaging).toEqual(config.overrides?.messaging)
    expect(decoded.overrides?.llm).toEqual(config.overrides?.llm)
  })

  it('rejects an overrides block that is not an object', () => {
    expect(() => parseIterationConfig(validConfig({ overrides: 5 as never }))).toThrow(
      IterationConfigError,
    )
  })
})
