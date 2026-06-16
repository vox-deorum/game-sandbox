/**
 * Cross-cutting helpers shared by the per-domain Kysely modules: the agent-identity column
 * mapping (used wherever an {@link AgentRef} is stored or grouped — results, placements, ratings)
 * and the unique-constraint detector the idempotent/one-open invariants lean on.
 */
import type { AgentKind, AgentRef } from '../schema.js'

/** The concrete agent-identity columns derived from an {@link AgentRef}. */
export interface AgentColumns {
  agent_kind: AgentKind
  agent_submission_id: string | null
  agent_user_id: string | null
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

/** Whether a thrown database error is a unique-constraint violation. */
export function isUniqueConstraintViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('UNIQUE constraint failed') || message.includes('submissions_active_unique')
  )
}
