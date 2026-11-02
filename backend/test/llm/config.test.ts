import { describe, expect, it } from 'vitest'

import {
  decodeResolvedOfficialLlmPolicy,
  encodeResolvedOfficialLlmPolicy,
  officialPolicy,
  type ResolvedLlm,
  type ResolvedOfficialLlmPolicy,
  resolveLlm,
} from '../../src/llm/config.js'
import type { SeasonConfig } from '../../src/storage/season-config.js'

const DEPLOYMENT = {
  upstreamUrl: 'https://llm.example.test/v1',
  models: {
    small: { upstream: 'small-v1', costWeight: 1 },
    medium: { upstream: 'medium-v2', costWeight: 2 },
  },
  sessionLimits: { tokenBudget: 10_000, requestsPerMinute: 12 },
  developmentLimits: { tokenBudget: 20_000, requestsPerMinute: 30 },
} as const

type LlmOverride = NonNullable<NonNullable<SeasonConfig['overrides']>['llm']>

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
    ['season flag omitted', DEPLOYMENT, true, season({}), false],
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
    [
      'requested tier unavailable',
      { ...DEPLOYMENT, models: { small: DEPLOYMENT.models.small } },
      true,
      season({ enabled: true, models: ['medium'] }),
      false,
    ],
  ] as const)('%s', (_name, deployment, environmentLlm, config, enabled) => {
    expect(resolveLlm(deployment, { llm: environmentLlm }, config).enabled).toBe(enabled)
  })

  interface PolicyRow {
    readonly name: string
    readonly override: LlmOverride
    readonly resolved: ResolvedLlm
    readonly frozen: ResolvedOfficialLlmPolicy
  }

  const policyRows: PolicyRow[] = [
    {
      name: 'inherits deployment aliases and each limit override independently',
      override: {
        enabled: true,
        cost_weights: { medium: 2.5 },
        official: { rate_limit_rpm: 9 },
        development: { token_budget: 1234, rate_limit_rpm: 4 },
      },
      resolved: {
        enabled: true,
        models: {
          small: { upstream: 'small-v1', costWeight: 1 },
          medium: { upstream: 'medium-v2', costWeight: 2.5 },
        },
        official: { tokenBudget: 10_000, requestsPerMinute: 9 },
        development: { tokenBudget: 1234, requestsPerMinute: 4 },
      },
      frozen: {
        enabled: true,
        models: {
          small: { model: 'small-v1', cost_weight: 1 },
          medium: { model: 'medium-v2', cost_weight: 2.5 },
        },
        session: { token_budget: 10_000, rate_limit_rpm: 9 },
      },
    },
    {
      name: 'narrows to the selected tier and inherits limits it does not override',
      override: {
        enabled: true,
        models: ['medium'],
        cost_weights: { medium: 0.25 },
        official: { token_budget: 8_000 },
      },
      resolved: {
        enabled: true,
        models: { medium: { upstream: 'medium-v2', costWeight: 0.25 } },
        official: { tokenBudget: 8_000, requestsPerMinute: 12 },
        development: { tokenBudget: 20_000, requestsPerMinute: 30 },
      },
      frozen: {
        enabled: true,
        models: { medium: { model: 'medium-v2', cost_weight: 0.25 } },
        session: { token_budget: 8_000, rate_limit_rpm: 12 },
      },
    },
  ]

  it.each(policyRows)('$name', ({ override, resolved, frozen }) => {
    const actual = resolveLlm(DEPLOYMENT, { llm: true }, season(override))
    expect(actual).toEqual(resolved)
    expect(officialPolicy(actual)).toEqual(frozen)
  })

  interface FrozenRow {
    readonly name: string
    readonly wire: string
    readonly policy: ResolvedOfficialLlmPolicy
    readonly encoded: string
  }

  const frozenRows: FrozenRow[] = [
    {
      name: 'decodes a modern policy literally and encodes it unchanged',
      wire: '{"enabled":true,"models":{"small":{"model":"provider-small","cost_weight":1.5},"large":{"model":"provider-large","cost_weight":2}},"session":{"token_budget":4321,"rate_limit_rpm":6}}',
      policy: {
        enabled: true,
        models: {
          small: { model: 'provider-small', cost_weight: 1.5 },
          large: { model: 'provider-large', cost_weight: 2 },
        },
        session: { token_budget: 4321, rate_limit_rpm: 6 },
      },
      encoded:
        '{"enabled":true,"models":{"small":{"model":"provider-small","cost_weight":1.5},"large":{"model":"provider-large","cost_weight":2}},"session":{"token_budget":4321,"rate_limit_rpm":6}}',
    },
    {
      name: 'decodes a legacy string model at weight one and encodes the modern form',
      wire: '{"enabled":true,"models":{"medium":"provider-medium"},"session":{"token_budget":9000,"rate_limit_rpm":5}}',
      policy: {
        enabled: true,
        models: { medium: { model: 'provider-medium', cost_weight: 1 } },
        session: { token_budget: 9000, rate_limit_rpm: 5 },
      },
      encoded:
        '{"enabled":true,"models":{"medium":{"model":"provider-medium","cost_weight":1}},"session":{"token_budget":9000,"rate_limit_rpm":5}}',
    },
    {
      name: 'decodes and encodes a disabled policy without model mappings',
      wire: '{"enabled":false,"models":{},"session":{"token_budget":1000,"rate_limit_rpm":2}}',
      policy: {
        enabled: false,
        models: {},
        session: { token_budget: 1000, rate_limit_rpm: 2 },
      },
      encoded: '{"enabled":false,"models":{},"session":{"token_budget":1000,"rate_limit_rpm":2}}',
    },
  ]

  it.each(frozenRows)('$name', ({ wire, policy, encoded }) => {
    expect(decodeResolvedOfficialLlmPolicy(wire)).toEqual(policy)
    expect(encodeResolvedOfficialLlmPolicy(policy)).toBe(encoded)
  })

  it('rejects incomplete, inconsistent and unexpected frozen policy fields', () => {
    const valid = {
      enabled: true,
      models: { small: { model: 'provider-small', cost_weight: 1.5 } },
      session: { token_budget: 100, rate_limit_rpm: 2 },
    }
    expect(
      decodeResolvedOfficialLlmPolicy(
        '{"enabled":true,"models":{"small":{"model":"provider-small","cost_weight":1.5}},"session":{"token_budget":100,"rate_limit_rpm":2}}',
      ),
    ).toEqual(valid)
    for (const [name, mutation] of [
      ['missing enabled', { enabled: undefined }],
      ['missing models', { models: undefined }],
      ['missing session', { session: undefined }],
      ['unexpected credential', { credential: 'synthetic-secret' }],
      ['enabled without models', { models: {} }],
      ['disabled with models', { enabled: false }],
      [
        'price above ceiling',
        { models: { small: { model: 'provider-small', cost_weight: 1_000_001 } } },
      ],
      [
        'unexpected call budget',
        { session: { token_budget: 100, rate_limit_rpm: 2, call_budget: 1 } },
      ],
    ] as const) {
      expect(
        () => decodeResolvedOfficialLlmPolicy(JSON.stringify({ ...valid, ...mutation })),
        name,
      ).toThrow()
    }
  })
})
