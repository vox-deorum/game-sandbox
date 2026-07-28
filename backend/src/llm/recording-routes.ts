import type { RecordingHeader } from '@game-sandbox/schema'
import type { FastifyInstance } from 'fastify'

import type { RequestIdentity } from '../identity.js'
import type { RecordingsStore } from '../recordings.js'
import type { Storage } from '../storage/index.js'
import {
  type ExecutionTelemetryCall,
  type ExecutionTelemetryStore,
  TelemetryUnavailableError,
} from '../storage/llm/execution-telemetry.js'

export interface RecordingLlmRouteDeps {
  identity: RequestIdentity
  recordings: Pick<RecordingsStore, 'readHeader'>
  storage: Pick<Storage, 'getRecording' | 'getSubmissionsByIds'>
  telemetry?: Pick<ExecutionTelemetryStore, 'readAssociatedCalls'>
}

export interface RecordingPublicLlmCall {
  tick: number | null
  player: string
  model: string
  input_tokens: number
  reasoning_tokens: number
  output_tokens: number
  usage_estimated: boolean
  cost_weight: number
  budget_cost_units: number
  request?: unknown
  completion?: unknown
}

/** Mount the public metadata and authorized-body view over retained official telemetry. */
export function registerRecordingLlmRoutes(
  app: FastifyInstance,
  deps: RecordingLlmRouteDeps,
): void {
  app.get<{ Params: { id: string } }>('/api/recordings/:id/llm', async (request, reply) => {
    const recording = await deps.storage.getRecording(request.params.id)
    if (recording === undefined) {
      return reply.code(404).send({ error: 'no such recording' })
    }
    if (recording.llm_scope_id === null && recording.llm_session_id === null) {
      return { calls: [], total_budget_cost_units: 0 }
    }
    if (
      recording.llm_scope_id === null ||
      recording.llm_session_id === null ||
      deps.telemetry === undefined
    ) {
      return telemetryUnavailable(reply)
    }

    let calls: ExecutionTelemetryCall[]
    try {
      calls = deps.telemetry.readAssociatedCalls(recording.llm_scope_id, recording.llm_session_id)
    } catch (error) {
      if (error instanceof TelemetryUnavailableError) {
        return telemetryUnavailable(reply)
      }
      throw error
    }

    const caller = await deps.identity.resolveUser(request)
    const header = await deps.recordings.readHeader(request.params.id)
    const submissionOwners = await ownersForHeader(deps.storage, header)
    const operator = caller?.status === 'admin'
    return {
      calls: calls.map((call) => {
        const player = header?.players?.[call.player]
        const submissionId =
          player !== undefined && 'submission_id' in player ? player.submission_id : undefined
        const canReadBodies =
          operator ||
          (caller !== null &&
            submissionId !== undefined &&
            submissionOwners.get(submissionId) === caller.id)
        return publicCall(call, canReadBodies)
      }),
      total_budget_cost_units: calls.reduce((sum, call) => sum + call.budgetCostUnits, 0),
    }
  })
}

async function ownersForHeader(
  storage: Pick<Storage, 'getSubmissionsByIds'>,
  header: RecordingHeader | undefined,
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      Object.values(header?.players ?? {}).flatMap((player) =>
        'submission_id' in player ? [player.submission_id] : [],
      ),
    ),
  ]
  const submissions = await storage.getSubmissionsByIds(ids)
  return new Map(submissions.map((submission) => [submission.id, submission.user_id]))
}

function publicCall(call: ExecutionTelemetryCall, includeBodies: boolean): RecordingPublicLlmCall {
  return {
    tick: call.tick,
    player: call.player,
    model: call.model,
    input_tokens: call.inputTokens,
    reasoning_tokens: call.reasoningTokens,
    output_tokens: call.outputTokens,
    usage_estimated: call.usageEstimated,
    cost_weight: call.costWeight,
    budget_cost_units: call.budgetCostUnits,
    ...(includeBodies ? { request: call.request, completion: call.completion } : {}),
  }
}

function telemetryUnavailable(reply: import('fastify').FastifyReply): unknown {
  return reply.code(500).send({
    error: 'recording telemetry is unavailable',
    code: 'telemetry_unavailable',
  })
}
