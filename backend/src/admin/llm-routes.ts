import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { LlmOptions } from '../config/config.js'
import { asLlmError, describeError, invalidRequest, LlmError } from '../llm/errors.js'
import { normalizeMaximum } from '../llm/handler.js'
import { type LlmChatRequest, MODEL_ALIASES, type ModelAlias } from '../llm/types.js'
import { type UpstreamCaller, UpstreamError } from '../llm/upstream.js'
import { appLog } from '../logging/log-buffer.js'

export interface AdminLlmDeps {
  llm: LlmOptions
  /** The deployment's upstream caller, absent when no upstream URL or alias is configured. */
  upstream?: Pick<UpstreamCaller, 'call'>
}

const ChatBodySchema = z.strictObject({
  model: z.string(),
  messages: z
    .array(z.strictObject({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }))
    .min(1),
  max_tokens: z.number().optional(),
  max_completion_tokens: z.number().optional(),
})

/**
 * Operator checks of the deployment upstream: what is configured, and one direct call per request.
 * Test calls bypass metering and telemetry, so they never touch a participant's budget.
 */
export function registerAdminLlmRoutes(admin: FastifyInstance, deps: AdminLlmDeps): void {
  admin.get('/llm', () => ({
    configured: deps.upstream !== undefined,
    upstream_url: deps.llm.upstreamUrl ?? null,
    key_set: deps.llm.upstreamKey !== undefined,
    models: MODEL_ALIASES.flatMap((alias) => {
      const model = deps.llm.models[alias]
      return model === undefined
        ? []
        : [{ alias, upstream_model: model.upstream, cost_weight: model.costWeight }]
    }),
    default_max_output_tokens: deps.llm.defaultMaxOutputTokens,
    max_output_tokens: deps.llm.maxOutputTokens,
  }))

  admin.post('/llm/chat', async (request, reply) => {
    let alias: ModelAlias | undefined
    try {
      if (deps.upstream === undefined) {
        throw new LlmError(403, 'llm_not_enabled', 'No LLM upstream is configured.')
      }
      const parsed = ChatBodySchema.safeParse(request.body)
      if (!parsed.success) throw invalidRequest('invalid_request', 'Malformed test request.')
      const model = deps.llm.models[parsed.data.model as ModelAlias]
      if (model === undefined) {
        throw invalidRequest('model_not_allowed', 'This deployment has no such model alias.')
      }
      alias = parsed.data.model as ModelAlias
      const { upstream } = normalizeMaximum(
        parsed.data,
        deps.llm.defaultMaxOutputTokens,
        deps.llm.maxOutputTokens,
      )
      upstream.model = model.upstream
      const result = await deps.upstream.call(upstream as unknown as LlmChatRequest)
      appLog('llm', `operator test ${alias}: ok in ${result.latencyMs} ms`, 'info')
      return { completion: result.completion, latency_ms: result.latencyMs }
    } catch (error) {
      if (error instanceof UpstreamError) {
        appLog('llm', `operator test ${alias}: upstream ${error.status}`, 'warn')
        // Report the provider's status in the body. Relaying it as this route's status would make an
        // upstream 401 look like the operator's own expired sign-in.
        return reply.code(502).send({ ...error.body(), upstream_status: error.status })
      }
      if (!(error instanceof LlmError)) {
        appLog('llm', `operator test ${alias}: ${describeError(error)}`, 'error')
      }
      const normalized = asLlmError(error)
      return reply.code(normalized.status).send(normalized.body())
    }
  })
}
