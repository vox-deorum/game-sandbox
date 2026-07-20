import type { FastifyInstance } from 'fastify'

import type { RequestIdentity } from '../identity.js'
import type { Storage } from '../storage/index.js'
import type { DevelopmentLedgerStore } from '../storage/llm/development-ledger/store.js'
import { type EncodedLlmLimits, encodeLimits } from './config.js'
import type { DevelopmentKeyService } from './development-keys.js'
import {
  type DevelopmentUsageSummary,
  developmentCallPageView,
  parseDevelopmentPagination,
  summarizeDevelopmentUsage,
} from './development-views.js'
import { asLlmError, invalidRequest, LlmError, readBearer } from './errors.js'
import type { LlmHandler } from './handler.js'
import { MODEL_ALIASES, type ModelAlias, modelCostWeights } from './types.js'

export interface DevelopmentLlmRouteDeps {
  identity: RequestIdentity
  keys: DevelopmentKeyService
  handler?: LlmHandler
  storage: Pick<Storage, 'listSeasons' | 'getDevelopmentKey'>
  ledger: DevelopmentLedgerStore
}

/** Mount key rotation and the public OpenAI-compatible development completion route. */
export function registerDevelopmentLlmRoutes(
  app: FastifyInstance,
  deps: DevelopmentLlmRouteDeps,
): void {
  app.get('/api/llm-development/seasons', async (request, reply) => {
    const user = await deps.identity.requireActive(request, reply)
    if (user === undefined) return
    const seasons = await deps.storage.listSeasons({ scope: 'all' })
    const eligible: DevelopmentDiscoveryResponse[] = []
    for (const season of seasons) {
      if (season.submission_status !== 'open') continue
      let policy: ReadPolicy
      try {
        policy = await deps.keys.resolveReadPolicy(season.id)
      } catch (error) {
        // Expected policy-level failures make a season ineligible. Storage and decoding faults
        // escape so discovery never disguises broken data as an ordinary empty result.
        if (error instanceof LlmError) continue
        throw error
      }
      if (!policy.resolved.enabled) continue
      eligible.push(await discoveryView(deps, season.id, user.id, policy))
    }
    return eligible
  })

  app.get<{ Params: { seasonId: string } }>(
    '/api/seasons/:seasonId/llm-development',
    async (request, reply) => {
      const user = await deps.identity.requireActive(request, reply)
      if (user === undefined) return
      try {
        const policy = await deps.keys.resolveReadPolicy(request.params.seasonId)
        return await summaryView(deps, request.params.seasonId, user.id, policy)
      } catch (error) {
        const normalized = asLlmError(error)
        return reply.code(normalized.status).send(normalized.body())
      }
    },
  )

  app.get<{
    Params: { seasonId: string }
    Querystring: { cursor?: string; limit?: string }
  }>('/api/seasons/:seasonId/llm-development/calls', async (request, reply) => {
    const user = await deps.identity.requireActive(request, reply)
    if (user === undefined) return
    const pagination = parseDevelopmentPagination(request.query)
    if (pagination === null) {
      return reply.code(400).send({ error: 'invalid pagination', code: 'invalid_pagination' })
    }
    try {
      const policy = await deps.keys.resolveReadPolicy(request.params.seasonId)
      const weights = modelCostWeights(policy.resolved.models)
      const page = deps.ledger.listUserCalls(request.params.seasonId, user.id, pagination)
      return developmentCallPageView(page, weights)
    } catch (error) {
      const normalized = asLlmError(error)
      return reply.code(normalized.status).send(normalized.body())
    }
  })

  app.post<{ Params: { seasonId: string } }>(
    '/api/seasons/:seasonId/llm-development-key',
    async (request, reply) => {
      const user = await deps.identity.requireActive(request, reply)
      if (user === undefined) return
      try {
        return await deps.keys.rotate(request.params.seasonId, user.id)
      } catch (error) {
        const normalized = asLlmError(error)
        return reply.code(normalized.status).send(normalized.body())
      }
    },
  )

  app.post(
    '/api/llm/v1/chat/completions',
    {
      // Fastify parses JSON before entering the handler. Keep this route OpenAI-compatible without
      // replacing the parent app's error contract for unrelated parser or application failures.
      errorHandler(error, _request, reply) {
        if (
          error.code !== 'FST_ERR_CTP_INVALID_JSON_BODY' &&
          error.code !== 'FST_ERR_CTP_EMPTY_JSON_BODY'
        ) {
          throw error
        }
        const normalized = invalidRequest('invalid_request', 'The request body is not valid JSON.')
        return reply.code(normalized.status).send(normalized.body())
      },
    },
    async (request, reply) => {
      try {
        const grant = await deps.keys.authenticate(readBearer(request.headers.authorization))
        if (deps.handler === undefined) {
          throw new LlmError(403, 'llm_not_enabled', 'LLM access is not enabled for this season.')
        }
        return await deps.handler.handle(grant, request.body)
      } catch (error) {
        const normalized = asLlmError(error)
        return reply.code(normalized.status).send(normalized.body())
      }
    },
  )
}

type ReadPolicy = Awaited<ReturnType<DevelopmentKeyService['resolveReadPolicy']>>

interface DevelopmentSummaryResponse {
  season_id: string
  models: ModelAlias[]
  cost_weights: Partial<Record<ModelAlias, number>>
  limits: EncodedLlmLimits
  usage_by_model: DevelopmentUsageSummary['usageByModel']
  successful_calls: number
  usage_estimated: boolean
  budget_cost_units_used: number
  budget_cost_units_remaining: number
  key_exists: boolean
}

interface DevelopmentDiscoveryResponse extends Omit<DevelopmentSummaryResponse, 'usage_by_model'> {
  label: string | null
  environment: string
}

async function discoveryView(
  deps: DevelopmentLlmRouteDeps,
  seasonId: string,
  userId: string,
  policy: ReadPolicy,
): Promise<DevelopmentDiscoveryResponse> {
  const summary = await summaryView(deps, seasonId, userId, policy)
  return {
    season_id: seasonId,
    label: policy.season.label,
    environment: policy.season.env_id,
    models: summary.models,
    cost_weights: summary.cost_weights,
    limits: summary.limits,
    successful_calls: summary.successful_calls,
    usage_estimated: summary.usage_estimated,
    budget_cost_units_used: summary.budget_cost_units_used,
    budget_cost_units_remaining: summary.budget_cost_units_remaining,
    key_exists: summary.key_exists,
  }
}

async function summaryView(
  deps: DevelopmentLlmRouteDeps,
  seasonId: string,
  userId: string,
  policy: ReadPolicy,
): Promise<DevelopmentSummaryResponse> {
  const weights = modelCostWeights(policy.resolved.models)
  const summary = summarizeDevelopmentUsage(
    deps.ledger.readUserUsageByModel(seasonId, userId),
    weights,
    deps.ledger.hasEstimatedUsage(seasonId, userId),
  )
  return {
    season_id: seasonId,
    models: MODEL_ALIASES.filter((alias) => policy.resolved.models[alias] !== undefined),
    cost_weights: weights,
    limits: encodeLimits(policy.resolved.development),
    usage_by_model: summary.usageByModel,
    successful_calls: summary.successfulCalls,
    usage_estimated: summary.usageEstimated,
    budget_cost_units_used: summary.budgetCostUnitsUsed,
    budget_cost_units_remaining: Math.max(
      0,
      policy.resolved.development.tokenBudget - summary.budgetCostUnitsUsed,
    ),
    key_exists: (await deps.storage.getDevelopmentKey(seasonId, userId)) !== undefined,
  }
}
