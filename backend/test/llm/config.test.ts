import { describe, expect, it } from 'vitest'

import {
  decodeResolvedOfficialLlmPolicy,
  encodeResolvedOfficialLlmPolicy,
  officialPolicy,
  resolveLlm,
} from '../../src/llm/config.js'
import type { SeasonConfig } from '../../src/storage/season-config.js'

const DEPLOYMENT = {
  upstreamUrl: 'https://llm.example.test/v1',
  models: { small: 'small-v1', medium: 'medium-v2' },
  sessionLimits: { tokenBudget: 10_000, callBudget: 50, requestsPerMinute: 12 },
  developmentLimits: { tokenBudget: 20_000, callBudget: 200, requestsPerMinute: 30 },
} as const

const season = (llm: NonNullable<SeasonConfig['overrides']>['llm']): SeasonConfig => ({
  deps_version: 1,
  matches: [],
  overrides: { llm },
})

describe('LLM configuration resolution', () => {
  it.each([
    ['configured environment and season', DEPLOYMENT, true, season({ enabled: true }), true],
    ['environment disabled', DEPLOYMENT, false, season({ enabled: true }), false],
    ['season disabled', DEPLOYMENT, true, season({ enabled: false }), false],
    [
      'upstream unavailable',
      { ...DEPLOYMENT, upstreamUrl: undefined },
      true,
      season({ enabled: true }),
      false,
    ],
    [
      'aliases unavailable',
      { ...DEPLOYMENT, models: {} },
      true,
      season({ enabled: true, models: ['small'] }),
      false,
    ],
  ] as const)('%s', (_name, deployment, environmentLlm, config, enabled) => {
    expect(resolveLlm(deployment, { llm: environmentLlm }, config).enabled).toBe(enabled)
  })

  it('inherits aliases and resolves official and development overrides independently', () => {
    const resolved = resolveLlm(
      DEPLOYMENT,
      { llm: true },
      season({
        enabled: true,
        official: { call_budget: 9 },
        development: { token_budget: 1234, rate_limit_rpm: 4 },
      }),
    )

    expect(resolved.models).toEqual({ small: 'small-v1', medium: 'medium-v2' })
    expect(resolved.official).toEqual({ tokenBudget: 10_000, callBudget: 9, requestsPerMinute: 12 })
    expect(resolved.development).toEqual({
      tokenBudget: 1234,
      callBudget: 200,
      requestsPerMinute: 4,
    })
  })

  it('round-trips the complete frozen official policy through the strict codec', () => {
    const frozen = officialPolicy(resolveLlm(DEPLOYMENT, { llm: true }, season({ enabled: true })))
    expect(decodeResolvedOfficialLlmPolicy(encodeResolvedOfficialLlmPolicy(frozen))).toEqual(frozen)
    expect(() => decodeResolvedOfficialLlmPolicy('{"enabled":false}')).toThrow()
    expect(() =>
      decodeResolvedOfficialLlmPolicy(
        '{"enabled":false,"models":{},"session":{"token_budget":1,"call_budget":1,"rate_limit_rpm":1},"credential":"secret"}',
      ),
    ).toThrow()
    expect(() =>
      decodeResolvedOfficialLlmPolicy(
        '{"enabled":true,"models":{},"session":{"token_budget":1,"call_budget":1,"rate_limit_rpm":1}}',
      ),
    ).toThrow()
    expect(() =>
      decodeResolvedOfficialLlmPolicy(
        '{"enabled":false,"models":{"small":"provider-small"},"session":{"token_budget":1,"call_budget":1,"rate_limit_rpm":1}}',
      ),
    ).toThrow()
  })
})
