import { describe, expect, it } from 'vitest'

import { decodeLlmUsageByModel, encodeLlmUsageByModel } from '../../src/storage/kysely/shared.js'
import type { LlmUsageByModel } from '../../src/storage/schema.js'

const VALID_USAGE: LlmUsageByModel = {
  medium: {
    calls: 2,
    estimated_calls: 1,
    input_tokens: 17,
    reasoning_tokens: 3,
    output_tokens: 9,
    latency_ms: 42,
  },
  small: {
    calls: 1,
    estimated_calls: 0,
    input_tokens: 5,
    reasoning_tokens: 0,
    output_tokens: 2,
    latency_ms: 11,
  },
}

describe('LLM usage storage codec', () => {
  it('round-trips the complete usage shape and normalizes empty usage to null', () => {
    const encoded = encodeLlmUsageByModel(VALID_USAGE)
    expect(encoded).not.toBeNull()
    expect(decodeLlmUsageByModel(encoded)).toEqual(VALID_USAGE)
    expect(encodeLlmUsageByModel({})).toBeNull()
    expect(decodeLlmUsageByModel(null)).toBeNull()
  })

  it('rejects unsupported model aliases', () => {
    expect(() =>
      decodeLlmUsageByModel(
        JSON.stringify({
          provider_model: {
            calls: 1,
            estimated_calls: 0,
            input_tokens: 1,
            reasoning_tokens: 0,
            output_tokens: 1,
            latency_ms: 2,
          },
        }),
      ),
    ).toThrow('unsupported model alias provider_model')
  })

  it.each([
    ['missing metric', { ...VALID_USAGE.small, latency_ms: undefined }],
    ['extra metric', { ...VALID_USAGE.small, cached_tokens: 1 }],
    ['negative metric', { ...VALID_USAGE.small, input_tokens: -1 }],
    ['fractional metric', { ...VALID_USAGE.small, latency_ms: 1.5 }],
    ['nonnumeric metric', { ...VALID_USAGE.small, calls: '1' }],
  ])('rejects a malformed usage entry with a %s', (_case, usage) => {
    expect(() => decodeLlmUsageByModel(JSON.stringify({ small: usage }))).toThrow(
      /supported metrics|invalid/,
    )
  })
})
