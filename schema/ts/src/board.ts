/**
 * The submission agent reference as leaderboard, run, and game responses carry it: the stable
 * submission and owner ids plus the owner's display name when the directory resolved one. Shared so the
 * backend enrichment (`enrichAgentRef`) and the frontend board reader speak one type rather than two
 * hand-kept-in-sync copies. Dependency-free, imported directly by the browser through the subpath export.
 */
export type BoardAgentRef =
  | {
      kind: 'submission'
      submission_id: string
      user_id: string
      /** The owner's display name, when the directory has one; absent falls back to `user_id`. */
      user_name?: string
    }
  | { kind: 'builtin-naive' }
