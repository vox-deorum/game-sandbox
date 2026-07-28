/**
 * The submission agent reference as leaderboard, run, and game responses carry it: the stable
 * submission and owner ids plus the owner's display name when the directory resolved one, or, for a
 * built-in, its declared label when the backend resolved one from the environment's `builtin_agents`.
 * Shared so the backend enrichment (`enrichAgentRef`) and the frontend board reader speak one type
 * rather than two hand-kept-in-sync copies. Dependency-free, imported directly by the browser through
 * the subpath export.
 */
export type BoardAgentRef =
  | {
      kind: 'submission'
      submission_id: string
      user_id: string
      /** The owner's display name, when the directory has one; absent falls back to `user_id`. */
      user_name?: string
    }
  | {
      kind: 'builtin'
      name: string
      /** The environment's declared display label for this built-in; absent falls back to `name`. */
      label?: string
    }

/** The minimal shape {@link agentRefKey} needs: either agent variant's kind plus its identifying field. */
export type AgentKeyable =
  | { kind: 'submission'; submission_id: string }
  | { kind: 'builtin'; name: string }

/**
 * The stable `kind:id` key for an agent reference: `submission:<id>` or `builtin:<name>`. The one place
 * this format is spelled, used wherever the same agent must be matched across differently shaped
 * payloads carrying the same identity (a stored {@link BoardAgentRef}, a rating's wire form, a v-for
 * key, a lookup map key, a de-duplication set) so the backend and every frontend component agree on one
 * key rather than several hand-kept-in-sync copies. Pure and dependency-free, like the rest of this module.
 */
export function agentRefKey(agent: AgentKeyable): string {
  return agent.kind === 'submission' ? `submission:${agent.submission_id}` : `builtin:${agent.name}`
}
