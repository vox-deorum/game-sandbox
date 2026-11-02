import { describe, expect, it } from 'vitest'

import {
  decodeLlmUsageByModel,
  encodeLlmUsageByModel,
  encodeLlmWeightedCost,
} from '../../src/storage/kysely/shared.js'
import type { LlmUsageByModel } from '../../src/storage/schema.js'

const VALID_USAGE: LlmUsageByModel = {
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
  it.each([
    ['missing metric', { small: { ...VALID_USAGE.small, latency_ms: undefined } }],
    ['extra metric', { small: { ...VALID_USAGE.small, cached_tokens: 1 } }],
    ['negative metric', { small: { ...VALID_USAGE.small, input_tokens: -1 } }],
    ['fractional metric', { small: { ...VALID_USAGE.small, latency_ms: 1.5 } }],
    ['nonnumeric metric', { small: { ...VALID_USAGE.small, calls: '1' } }],
    ['unsupported alias', { provider_model: VALID_USAGE.small }],
  ])('rejects persisted usage with a %s', (_case, usage) => {
    expect(() => decodeLlmUsageByModel(JSON.stringify(usage))).toThrow()
  })

  it.each([
    -1,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ])('rejects invalid weighted cost %s', (cost) => {
    expect(() => encodeLlmWeightedCost(cost, VALID_USAGE)).toThrow()
  })

  it('keeps usage and weighted cost presence consistent at the boundaries', () => {
    expect(encodeLlmUsageByModel({})).toBeNull()
    expect(decodeLlmUsageByModel(null)).toBeNull()
    expect(encodeLlmWeightedCost(0, VALID_USAGE)).toBe(0)
    expect(encodeLlmWeightedCost(3.5, VALID_USAGE)).toBe(3.5)
    expect(encodeLlmWeightedCost(null, null)).toBeNull()
    expect(() => encodeLlmWeightedCost(null, VALID_USAGE)).toThrow()
    expect(() => encodeLlmWeightedCost(1, null)).toThrow()
  })
})
