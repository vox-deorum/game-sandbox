/**
 * The storage seam.
 *
 * A narrow, domain-shaped interface over the relational data: callers see the derived domain
 * types from `schema.ts`, never SQL or query building. This interface is what the orchestrator
 * and the HTTP tests are written against; `kysely.ts` is its one implementation and `sqlite.ts`
 * its one wiring today. Swapping engines is a new wiring file against the same schema, queries,
 * and interface.
 */
import type {
  CheckStatus,
  Iteration,
  Recording,
  Session,
  SessionMode,
  Submission,
  SubmissionCheck,
  SubmissionSourceKind,
  SubmissionStage,
  SubmissionStatus,
  TerminationReason,
} from './schema.js'

export type {
  CheckStatus,
  Iteration,
  IterationStatus,
  Recording,
  Session,
  SessionMode,
  SessionStatus,
  SessionSubmission,
  Submission,
  SubmissionCheck,
  SubmissionSourceKind,
  SubmissionStage,
  SubmissionStatus,
  TerminationReason,
} from './schema.js'

/** The fields the orchestrator provides when starting a session. */
export interface NewSessionInput {
  id: string
  user_id: string
  env_id: string
  mode: SessionMode
  recording_id: string | null
  created_at: string
}

/** The fields the finalize routine provides when registering a produced recording. */
export interface NewRecordingInput {
  id: string
  user_id: string
  env_id: string
  created_at: string
}

/**
 * The domain-shaped fields the submission route provides when creating a pending submission. The
 * row is always inserted as `pending`; `commit_sha` may still be null (it is filled by source
 * resolution for git, and stays null for local). The `created_at` doubles as the supersede stamp
 * written onto any prior active submission by the same user in the same iteration.
 */
export interface NewSubmissionInput {
  iteration_id: string
  env_id: string
  user_id: string
  source_kind: SubmissionSourceKind
  repo_url: string | null
  commit_sha: string | null
  local_path: string | null
  ref: string | null
  created_at: string
}

/**
 * Raised by {@link Storage.createSubmission} when two submits for the same participant and
 * iteration race and the partial unique index rejects the second transaction. The route turns
 * this into a retryable 409 rather than a 500.
 */
export class SubmissionConflictError extends Error {
  constructor(message = 'a concurrent submission won the active-submission slot') {
    super(message)
    this.name = 'SubmissionConflictError'
  }
}

/** A completed validation-check outcome; `running` is only written by `startSubmissionCheck`. */
export type SubmissionCheckOutcome = Exclude<CheckStatus, 'running'>

/** A failed terminal submission status, which always carries an owner-visible reason. */
export type SubmissionFailureStatus = Exclude<SubmissionStatus, 'pending' | 'ready'>

/** Any terminal submission status the validation/build worker can write. */
export type SubmissionTerminalStatus = Exclude<SubmissionStatus, 'pending'>

export interface Storage {
  /** Insert a new session as `starting` and return the stored row. */
  createSession(input: NewSessionInput): Promise<Session>
  /** Move a session to `running` (the container's header line has arrived). */
  markRunning(id: string): Promise<void>
  /** Finalize a session: `ended`, with its reason and end timestamp. Idempotent at the SQL
   * level (it simply writes the columns), so the orchestrator's finalize can call it freely. */
  markEnded(id: string, reason: TerminationReason, endedAt: string): Promise<void>
  /** The user's active (`starting` or `running`) session, if any; backs the one-per-user rule. */
  findActiveSessionByUser(userId: string): Promise<Session | undefined>
  /** One session by id. */
  getSession(id: string): Promise<Session | undefined>
  /** All sessions, most recent first. */
  listSessions(): Promise<Session[]>

  /**
   * Register a produced recording's retention row. Idempotent: a recording id already present is
   * left untouched, so the finalize routine can call it freely and a re-finalize never duplicates.
   */
  createRecording(input: NewRecordingInput): Promise<void>
  /** Every recording row, newest first; backs the merged listing and the eviction sweep. */
  listRecordings(): Promise<Recording[]>
  /** One recording row by id, or `undefined` (a directory with no row — foreign debris). */
  getRecording(id: string): Promise<Recording | undefined>
  /** Set or clear a recording's pinned flag. */
  setRecordingPinned(id: string, pinned: boolean): Promise<void>
  /** How many recordings a user has pinned; backs the pin-quota guard. */
  countPinnedByUser(userId: string): Promise<number>
  /** Delete a recording's row (the directory is removed separately by the retention sweep). */
  deleteRecording(id: string): Promise<void>

  /** The current open iteration for an environment, the identity boundary every submission needs. */
  getOpenIteration(envId: string): Promise<Iteration | undefined>
  /**
   * The seed primitive: ensure an open iteration exists for the environment at `depsVersion` and
   * return it. Idempotent, an environment already carrying an open iteration is left untouched.
   */
  ensureOpenIteration(envId: string, depsVersion: number): Promise<Iteration>

  /**
   * Create a submission as `pending`, superseding any active submission by the same user in the
   * same iteration first; the supersede-then-insert runs in one transaction so a concurrent
   * resubmit cannot leave two active rows or none. Throws {@link SubmissionConflictError} if the
   * partial unique index rejects a racing insert. Returns the stored row.
   */
  createSubmission(input: NewSubmissionInput): Promise<Submission>
  /** Record the resolved git commit after source resolution succeeds. */
  updateSubmissionPin(id: string, commitSha: string): Promise<void>
  /** Mark a submission ready and clear any prior reason. */
  updateSubmissionStatus(id: string, status: 'ready'): Promise<void>
  /** Mark a submission failed with the owner-visible terminal reason. */
  updateSubmissionStatus(id: string, status: SubmissionFailureStatus, reason: string): Promise<void>
  /**
   * Upsert a `running` check for a stage (keyed by the unique `(submission_id, stage)` index, so a
   * re-enqueue overwrites rather than duplicates).
   */
  startSubmissionCheck(submissionId: string, stage: SubmissionStage): Promise<void>
  /** Stamp a stage's outcome (`passed`/`failed`/`skipped`) and `ended_at`, with optional detail. */
  finishSubmissionCheck(
    submissionId: string,
    stage: SubmissionStage,
    status: SubmissionCheckOutcome,
    detail?: string,
  ): Promise<void>
  /** Record which submitted agent ran in which session slot, for agent-profile replay history. */
  recordSessionSubmission(sessionId: string, submissionId: string, slotId: string): Promise<void>

  /** One submission by id. */
  getSubmission(id: string): Promise<Submission | undefined>
  /** The user's active (`superseded_at IS NULL`) submission in an iteration, regardless of status. */
  findActiveSubmission(iterationId: string, userId: string): Promise<Submission | undefined>
  /** Active pending submissions, newest first, for the validation worker's startup re-enqueue. */
  listPendingSubmissions(): Promise<Submission[]>
  /** A user's submissions (including superseded history), newest first, optionally one environment. */
  listSubmissionsByUser(userId: string, envId?: string): Promise<Submission[]>
  /** Active (`superseded_at IS NULL`) submissions in an iteration, optionally narrowed by status. */
  listActiveSubmissionsByIteration(
    iterationId: string,
    status?: SubmissionStatus,
  ): Promise<Submission[]>
  /** A submission's per-stage validation log, ordered by pipeline-stage sequence. */
  listSubmissionChecks(submissionId: string): Promise<SubmissionCheck[]>
  /**
   * Every active (`superseded_at IS NULL`) `ready` submission id across all iterations and
   * environments, the exempt set the overlay-image eviction sweep (step 4) keeps.
   */
  listActiveReadySubmissionIds(): Promise<string[]>
  /** A submission's recent recording ids, newest first, ignoring sessions that produced none. */
  listRecordingsBySubmission(submissionId: string, limit: number): Promise<string[]>

  /** Release the underlying database handle. */
  close(): Promise<void>
}
