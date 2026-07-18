import type { EnvironmentMeta } from '@game-sandbox/schema'
import { z } from 'zod'

import type { LlmOptions } from '../config.js'
import type { SeasonConfig } from '../storage/season-config.js'
import {
  type LlmLimits,
  type LlmModelConfig,
  MAX_LLM_COST_WEIGHT,
  MODEL_ALIASES,
  type ModelAlias,
} from './types.js'

const ModelSnapshotSchema = z.preprocess(
  (value) => (typeof value === 'string' ? { model: value, cost_weight: 1 } : value),
  z.strictObject({
    model: z.string().min(1),
    cost_weight: z.number().positive().finite().max(MAX_LLM_COST_WEIGHT),
  }),
)
const ModelMapSchema = z.partialRecord(z.enum(MODEL_ALIASES), ModelSnapshotSchema)
const ResolvedLimitsSchema = z.strictObject({
  token_budget: z.int().positive(),
  call_budget: z.int().positive(),
  rate_limit_rpm: z.int().positive(),
})

export const ResolvedOfficialLlmPolicySchema = z
  .strictObject({
    enabled: z.boolean(),
    models: ModelMapSchema,
    session: ResolvedLimitsSchema,
  })
  .superRefine((policy, context) => {
    const modelCount = Object.keys(policy.models).length
    // The snapshot is self-contained: enabled runs must name a usable model, while disabled runs
    // carry no stale mapping that could accidentally be consulted later.
    if (policy.enabled && modelCount === 0) {
      context.addIssue({
        code: 'custom',
        path: ['models'],
        message: 'enabled policy needs a model',
      })
    }
    if (!policy.enabled && modelCount !== 0) {
      context.addIssue({ code: 'custom', path: ['models'], message: 'disabled policy has models' })
    }
  })
export type ResolvedOfficialLlmPolicy = z.infer<typeof ResolvedOfficialLlmPolicySchema>

export interface ResolvedLlm {
  enabled: boolean
  models: Partial<Record<ModelAlias, LlmModelConfig>>
  official: LlmLimits
  development: LlmLimits
}

/** Resolve current deployment, environment, and season settings without consulting any gate status. */
export function resolveLlm(
  deployment: Pick<LlmOptions, 'upstreamUrl' | 'models' | 'sessionLimits' | 'developmentLimits'>,
  environment: Pick<EnvironmentMeta, 'llm'>,
  season: SeasonConfig,
): ResolvedLlm {
  const override = season.overrides?.llm
  const aliases = override?.models ?? MODEL_ALIASES.filter((alias) => deployment.models[alias])
  const models = Object.fromEntries(
    aliases.flatMap((alias) => {
      const model = deployment.models[alias]
      return model === undefined
        ? []
        : [
            [
              alias,
              {
                upstream: model.upstream,
                costWeight: override?.cost_weights?.[alias] ?? model.costWeight,
              },
            ],
          ]
    }),
  ) as Partial<Record<ModelAlias, LlmModelConfig>>
  const configured =
    deployment.upstreamUrl !== undefined && Object.keys(deployment.models).length > 0
  const requestedModelsAvailable = aliases.every((alias) => deployment.models[alias] !== undefined)
  return {
    enabled:
      configured && environment.llm && override?.enabled === true && requestedModelsAvailable,
    models,
    official: resolveLimits(deployment.sessionLimits, override?.official),
    development: resolveLimits(deployment.developmentLimits, override?.development),
  }
}

/** Reject an admin edit that names aliases this deployment cannot serve. */
export function unavailableLlmAliases(
  season: SeasonConfig,
  configured: Partial<Record<ModelAlias, LlmModelConfig>>,
): ModelAlias[] {
  return (season.overrides?.llm?.models ?? []).filter((alias) => configured[alias] === undefined)
}

export function officialPolicy(resolved: ResolvedLlm): ResolvedOfficialLlmPolicy {
  return {
    enabled: resolved.enabled,
    models: resolved.enabled
      ? Object.fromEntries(
          Object.entries(resolved.models).map(([alias, model]) => [
            alias,
            { model: model.upstream, cost_weight: model.costWeight },
          ]),
        )
      : {},
    session: encodeLimits(resolved.official),
  }
}

export function parseResolvedOfficialLlmPolicy(value: unknown): ResolvedOfficialLlmPolicy {
  return ResolvedOfficialLlmPolicySchema.parse(value)
}

export function encodeResolvedOfficialLlmPolicy(policy: ResolvedOfficialLlmPolicy): string {
  return JSON.stringify(parseResolvedOfficialLlmPolicy(policy))
}

export function decodeResolvedOfficialLlmPolicy(text: string): ResolvedOfficialLlmPolicy {
  return parseResolvedOfficialLlmPolicy(JSON.parse(text) as unknown)
}

function resolveLimits(
  defaults: LlmLimits,
  override: { token_budget?: number; call_budget?: number; rate_limit_rpm?: number } | undefined,
): LlmLimits {
  return {
    tokenBudget: override?.token_budget ?? defaults.tokenBudget,
    callBudget: override?.call_budget ?? defaults.callBudget,
    requestsPerMinute: override?.rate_limit_rpm ?? defaults.requestsPerMinute,
  }
}

function encodeLimits(limits: LlmLimits): ResolvedOfficialLlmPolicy['session'] {
  return {
    token_budget: limits.tokenBudget,
    call_budget: limits.callBudget,
    rate_limit_rpm: limits.requestsPerMinute,
  }
}
