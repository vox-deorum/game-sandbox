/**
 * Cross-cutting helpers shared by the per-domain Kysely modules: the agent-identity column
 * mapping (used wherever an {@link AgentRef} is stored or grouped — results, placements, ratings)
 * and the unique-constraint detector the idempotent/one-open invariants lean on.
 */
import { MODEL_ALIASES } from '../../llm/types.js'
import type { AgentColumns, AgentRef, LlmUsageByModel } from '../schema.js'

const LLM_USAGE_METRICS = [
  'calls',
  'estimated_calls',
  'input_tokens',
  'reasoning_tokens',
  'output_tokens',
  'latency_ms',
] as const
const MODEL_ALIAS_SET: ReadonlySet<string> = new Set(MODEL_ALIASES)
const LLM_USAGE_METRIC_SET: ReadonlySet<string> = new Set(LLM_USAGE_METRICS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function usageMetric(
  usage: Record<string, unknown>,
  model: string,
  metric: (typeof LLM_USAGE_METRICS)[number],
): number {
  const value = usage[metric]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`LLM usage for model ${model} has invalid ${metric}`)
  }
  return value
}

function validateLlmUsageByModel(value: unknown): LlmUsageByModel {
  if (!isRecord(value)) {
    throw new Error('LLM usage by model must be a JSON object')
  }
  for (const model of Object.keys(value)) {
    if (!MODEL_ALIAS_SET.has(model)) {
      throw new Error(`LLM usage contains unsupported model alias ${model}`)
    }
  }

  const result: LlmUsageByModel = {}
  for (const model of MODEL_ALIASES) {
    const usage = value[model]
    if (usage === undefined) continue
    if (!isRecord(usage)) {
      throw new Error(`LLM usage for model ${model} must be a JSON object`)
    }
    const metrics = Object.keys(usage)
    if (
      metrics.length !== LLM_USAGE_METRICS.length ||
      metrics.some((metric) => !LLM_USAGE_METRIC_SET.has(metric))
    ) {
      throw new Error(`LLM usage for model ${model} must contain exactly the supported metrics`)
    }
    result[model] = {
      calls: usageMetric(usage, model, 'calls'),
      estimated_calls: usageMetric(usage, model, 'estimated_calls'),
      input_tokens: usageMetric(usage, model, 'input_tokens'),
      reasoning_tokens: usageMetric(usage, model, 'reasoning_tokens'),
      output_tokens: usageMetric(usage, model, 'output_tokens'),
      latency_ms: usageMetric(usage, model, 'latency_ms'),
    }
  }
  return result
}

/** Encode the validated public per-model usage shape, storing empty usage as SQL null. */
export function encodeLlmUsageByModel(value: LlmUsageByModel | null | undefined): string | null {
  if (value === null || value === undefined || Object.keys(value).length === 0) return null
  return JSON.stringify(validateLlmUsageByModel(value))
}

/** Decode and validate persisted per-model usage before it crosses the storage boundary. */
export function decodeLlmUsageByModel(value: string | null): LlmUsageByModel | null {
  if (value === null) return null
  const parsed: unknown = JSON.parse(value)
  return validateLlmUsageByModel(parsed)
}

/** Flatten an {@link AgentRef} to its three stored columns; null ids for the Naive baseline. */
export function agentColumns(agent: AgentRef): AgentColumns {
  if (agent.kind === 'submission') {
    return {
      agent_kind: 'submission',
      agent_submission_id: agent.submission_id,
      agent_user_id: agent.user_id,
    }
  }
  return { agent_kind: 'builtin-naive', agent_submission_id: null, agent_user_id: null }
}

/** Reconstruct an {@link AgentRef} from a row's stored agent columns. */
export function agentRefFromColumns(row: AgentColumns): AgentRef {
  if (row.agent_kind === 'submission') {
    return {
      kind: 'submission',
      submission_id: row.agent_submission_id ?? '',
      user_id: row.agent_user_id ?? '',
    }
  }
  return { kind: 'builtin-naive' }
}

/** A stable grouping key for an agent across result/placement/rating rows. */
export function agentKey(row: AgentColumns): string {
  return `${row.agent_kind}:${row.agent_submission_id ?? ''}`
}

/** The same stable key from an {@link AgentRef}, for deterministic ordering of board rows. */
export function agentRefKey(agent: AgentRef): string {
  return agent.kind === 'submission' ? `submission:${agent.submission_id}` : 'builtin-naive:'
}

/**
 * Population standard deviation from running sums: √(E[x²] − E[x]²), clamped at 0. Returns 0 for an
 * empty set or a single value. The clamp absorbs the tiny negative a float round-off can leave when
 * every value is equal (variance should be exactly 0). Population (÷N), not sample (÷N−1): a board row
 * summarizes the whole set of games/ratings it has, not a sample drawn from a larger population.
 */
export function populationStdDev(sum: number, sumOfSquares: number, count: number): number {
  if (count <= 0) {
    return 0
  }
  const mean = sum / count
  return Math.sqrt(Math.max(0, sumOfSquares / count - mean * mean))
}

/** Whether a thrown database error is a unique-constraint violation. */
export function isUniqueConstraintViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('UNIQUE constraint failed') || message.includes('submissions_active_unique')
  )
}
