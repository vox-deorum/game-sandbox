/**
 * Cross-cutting helpers shared by the per-domain Kysely modules: the agent-identity column
 * mapping (used wherever an {@link AgentRef} is stored or grouped — results, placements, ratings)
 * and the unique-constraint detector the idempotent/one-open invariants lean on.
 */
import { agentRefKey } from '@game-sandbox/schema/board'

import { MODEL_ALIASES } from '../../llm/types.js'
import { type AgentColumns, type AgentRef, isAgentRef, type LlmUsageByModel } from '../schema.js'

/** The stable `kind:id` key for an agent reference; the one definition, shared with the browser. */
export { agentRefKey }

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

/** Validate weighted token cost and keep its SQL null state paired with normalized LLM usage. */
export function encodeLlmWeightedCost(
  value: number | null | undefined,
  usage: LlmUsageByModel | null | undefined,
): number | null {
  const hasUsage = usage !== null && usage !== undefined && Object.keys(usage).length > 0
  if (value === null || value === undefined) {
    if (hasUsage) {
      throw new Error('LLM weighted cost must be present when LLM usage is present')
    }
    return null
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('LLM weighted cost must be a finite non-negative number')
  }
  if (!hasUsage) {
    throw new Error('LLM weighted cost must be null when LLM usage is null')
  }
  return value
}

/** Flatten an {@link AgentRef} to its stored columns. */
export function agentColumns(agent: AgentRef): AgentColumns {
  if (!isAgentRef(agent)) {
    throw new Error('agent reference has an invalid shape')
  }
  if (agent.kind === 'submission') {
    return {
      agent_kind: 'submission',
      agent_builtin_name: null,
      agent_submission_id: agent.submission_id,
      agent_user_id: agent.user_id,
    }
  }
  return {
    agent_kind: 'builtin',
    agent_builtin_name: agent.name,
    agent_submission_id: null,
    agent_user_id: null,
  }
}

/** Reconstruct an {@link AgentRef} from a row's stored agent columns. */
export function agentRefFromColumns(row: AgentColumns): AgentRef {
  if (row.agent_kind === 'submission') {
    const agent = {
      kind: 'submission',
      submission_id: row.agent_submission_id,
      user_id: row.agent_user_id,
    }
    if (row.agent_builtin_name !== null || !isAgentRef(agent)) {
      throw new Error('stored submission agent columns have an invalid identity')
    }
    return agent
  }
  if (row.agent_kind === 'builtin') {
    const agent = { kind: 'builtin', name: row.agent_builtin_name }
    if (row.agent_submission_id !== null || row.agent_user_id !== null || !isAgentRef(agent)) {
      throw new Error('stored builtin agent columns have an invalid identity')
    }
    return agent
  }
  throw new Error(`stored agent columns have unknown kind ${String(row.agent_kind)}`)
}

/** A stable grouping key for an agent across result/placement/rating rows. */
export function agentKey(row: AgentColumns): string {
  return agentRefKey(agentRefFromColumns(row))
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
