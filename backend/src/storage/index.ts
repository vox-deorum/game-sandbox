/**
 * The storage seam.
 *
 * A narrow, domain-shaped interface over the relational data: callers see the derived domain
 * types from `schema.ts`, never SQL or query building. This interface is what the orchestrator
 * and the HTTP tests are written against; the `kysely/` module is its one implementation and
 * `sqlite.ts` its one wiring today. Swapping engines is a new wiring file against the same schema,
 * queries, and interface.
 */
import type {
  AgentRatingPrompt,
  AgentRef,
  AutomatedPlacement,
  CheckStatus,
  GameResult,
  GameStatus,
  Iteration,
  IterationRun,
  IterationRunGame,
  Rating,
  Recording,
  ReleaseStatus,
  RunStatus,
  Session,
  SessionMode,
  Submission,
  SubmissionCheck,
  SubmissionSourceKind,
  SubmissionStage,
  SubmissionStatus,
  TerminationReason,
  WindowStatus,
} from './schema.js'

export type {
  AgentKind,
  AgentRatingPrompt,
  AgentRef,
  AutomatedPlacement,
  CheckStatus,
  GameResult,
  GameStatus,
  Iteration,
  IterationRun,
  IterationRunGame,
  IterationStatus,
  Rating,
  Recording,
  ReleaseStatus,
  RunStatus,
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
  WindowStatus,
} from './schema.js'

import type { IterationConfig } from './iteration-config.js'

export type {
  IterationConfig,
  MatchConfig,
  Overrides,
  SlotSpec,
} from './iteration-config.js'

export {
  decodeIterationConfig,
  emptyIterationConfig,
  encodeIterationConfig,
  IterationConfigError,
  IterationConfigSchema,
  parseIterationConfig,
} from './iteration-config.js'

/** The fields the orchestrator provides when starting a session. */
export interface NewSessionInput {
  id: string
  user_id: string
  env_id: string
  mode: SessionMode
  recording_id: string | null
  /**
   * The iteration this session competes in, or null when it has no competition boundary (the key
   * ratings later attach to). Defaults to null when omitted, preserving the Stage 5 callers.
   */
  iteration_id?: string | null
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

/** The fields the admin "declare iteration" action provides. Config (incl. deps) defaults internally. */
export interface CreateIterationInput {
  env_id: string
  /** The pinned dependency-set version, defaulting to the current release at declaration. */
  deps_version: number
  /** An optional operator-facing label. */
  label?: string | null
}

/**
 * The outcome of {@link Storage.updateIterationConfig}. An unforced edit against existing runs is
 * refused with `iteration_has_runs`; an unforced `deps_version` change against existing submissions is
 * refused with `iteration_has_submissions`. A forced edit clears the blocking rows first (step 3
 * surfaces this as a UI confirmation).
 */
export type UpdateIterationConfigResult =
  | { ok: true; iteration: Iteration }
  | { ok: false; conflict: 'iteration_has_runs' | 'iteration_has_submissions' }

/** The outcome of opening the submission window: a typed conflict when the one-open invariant blocks it. */
export type SetSubmissionStatusResult =
  | { ok: true; iteration: Iteration }
  | { ok: false; conflict: 'open_iteration_exists' }

/** The outcome of opening the public-play window: a typed conflict when one is already play-open. */
export type SetPlayStatusResult =
  | { ok: true; iteration: Iteration }
  | { ok: false; conflict: 'open_play_iteration_exists' }

/** One concrete scheduled game the pure scheduler produced, persisted by `createRunWithSchedule`. */
export interface ScheduledGameInput {
  match_index: number
  game_index: number
  seed: number
  /** One resolved {@link AgentRef} per seat, in slot order. */
  slots: AgentRef[]
}

/** A per-seat game outcome the runner derives from the recording. */
export interface RecordGameResultInput {
  game_id: string
  slot_index: number
  agent: AgentRef
  episode_score: number
  agent_compute_ms_total: number
  acted_tick_count: number
  failed: boolean
  failure_reason?: string | null
}

/** One placement row for `replaceAutomatedPlacements`; the iteration/env/run are passed alongside. */
export interface PlacementInput {
  rank: number
  agent: AgentRef
  mean_score: number
  /** Null/blank when the contributing tick count was zero. */
  mean_agent_compute_ms: number | null
  failure_count: number
  recording_id: string | null
}

/** A rating to insert or overwrite. The own-agent rule is enforced before any write. */
export interface UpsertRatingInput {
  iteration_id: string
  env_id: string
  rater_user_id: string
  agent: AgentRef
  /** Integer 1-5; validated before the write. */
  score: number
}

/**
 * The outcome of {@link Storage.upsertRating}. A rating of the user's own submitted agent is rejected
 * (`own_agent`) and never inserted; an out-of-range score is rejected (`invalid_score`).
 */
export type UpsertRatingResult =
  | { ok: true; rating: Rating }
  | { ok: false; reason: 'own_agent' | 'invalid_score' }

/** One aggregated rating row for the human board: the agent and its mean score and count. */
export interface RatingAggregate {
  agent: AgentRef
  mean: number
  count: number
}

/**
 * One automated-board row: a per-agent aggregate over the latest completed run's results. The board
 * service (step 5) shapes the public response from these; mean per-decision time is null when no tick
 * contributed.
 */
export interface AutomatedBoardRow {
  agent: AgentRef
  mean_score: number
  mean_agent_compute_ms: number | null
  failure_count: number
  /** The number of games that produced a result for this agent in the run. */
  games: number
  /** A representative replay link (the recording of the agent's best game), or null. */
  recording_id: string | null
}

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

  /**
   * The environment's submission-`open` iteration, the identity boundary every submission needs (the
   * Stage 5 `getOpenIteration`, renamed now that "open" is ambiguous across the submission and play
   * windows).
   */
  getOpenSubmissionIteration(envId: string): Promise<Iteration | undefined>
  /**
   * One iteration by id, regardless of its gates. The validation worker reads the pinned
   * `deps_version` (now inside `config`) of the iteration a submission belongs to.
   */
  getIteration(id: string): Promise<Iteration | undefined>
  /**
   * The seed primitive: ensure a submission-`open` iteration exists for the environment at
   * `depsVersion` and return it, writing a default config that carries the version and an empty match
   * design. Idempotent; an environment already carrying a submission-open iteration is left untouched.
   * The seed row is play-`open` for local continuity.
   */
  ensureOpenIteration(envId: string, depsVersion: number): Promise<Iteration>
  /** The environment's play-`open` iteration: the default public watch/play target, if any. */
  getPublicPlayIteration(envId: string): Promise<Iteration | undefined>
  /**
   * Declare a new iteration: `unreleased`, submission-`closed`, play-`closed`, with a default config
   * (including the given `deps_version`) and an empty match design.
   */
  createIteration(input: CreateIterationInput): Promise<Iteration>
  /**
   * Replace the whole {@link IterationConfig} (including `deps_version`). With no runs and no
   * `deps_version` change it just writes; otherwise it needs `force`, which first deletes the
   * iteration's runs, and — when `deps_version` changed and submissions exist — its submissions.
   * Returns a typed conflict when a write is refused for want of `force`.
   */
  updateIterationConfig(
    id: string,
    config: IterationConfig,
    options?: { force?: boolean },
  ): Promise<UpdateIterationConfigResult>
  /**
   * Open or close the submission window. Opening returns `open_iteration_exists` when another iteration
   * for the same environment already accepts submissions (the one-open invariant).
   */
  setSubmissionStatus(id: string, status: WindowStatus): Promise<SetSubmissionStatusResult>
  /**
   * Open or close the public-play window. Opening returns `open_play_iteration_exists` when another
   * iteration for the same environment is already play-open, regardless of release status.
   */
  setPlayStatus(id: string, status: WindowStatus): Promise<SetPlayStatusResult>
  /** Set the release status, stamping `released_at` on the first release and leaving it stable after. */
  setReleaseStatus(id: string, status: ReleaseStatus): Promise<Iteration>
  /**
   * An environment's iterations, newest first. Public reads pass `includeUnreleased: false` to hide
   * unreleased boards/history; admin reads pass `true`.
   */
  listIterations(envId: string, options?: { includeUnreleased?: boolean }): Promise<Iteration[]>
  /** The latest `released` iteration for an environment, ordered by `released_at`. */
  getReleasedIteration(envId: string): Promise<Iteration | undefined>
  /** Attribute an existing session to an iteration (the alternative to passing it at create time). */
  setSessionIteration(sessionId: string, iterationId: string): Promise<void>

  /** The operator's iteration-wide rating prompt; editable anytime, never gated by the config rules. */
  setIterationRatingPrompt(iterationId: string, prompt: string | null): Promise<void>

  /**
   * Snapshot the iteration's config (incl. deps) and the eligible submitted-agent roster into a new
   * run row, and persist the concrete scheduled games, all in one transaction. The run starts
   * `pending`; the runner reads the persisted games, not the mutable iteration/submission rows.
   */
  createRunWithSchedule(
    iterationId: string,
    requestedBy: string,
    submissionSnapshot: AgentRef[],
    scheduledGames: ScheduledGameInput[],
  ): Promise<IterationRun>
  /** Delete an iteration's runs, their games, results, and placements (the forced config-edit path). */
  deleteRunsForIteration(iterationId: string): Promise<void>
  /** Delete an iteration's submissions (the forced `deps_version`-change path). */
  deleteSubmissionsForIteration(iterationId: string): Promise<void>
  /** Advance a run's status, stamping `ended_at` on a terminal status and recording an optional error. */
  setRunStatus(id: string, status: RunStatus, error?: string): Promise<void>
  /** One run by id, any status; the admin status and log-stream routes resolve a run by its id. */
  getRun(id: string): Promise<IterationRun | undefined>
  /**
   * Every run in a given status, oldest first. The startup reconcile uses it to find runs a prior
   * process death left non-terminal (`running`/`pending`) and fail them, since a partial workflow run
   * is never silently resumed.
   */
  listRunsByStatus(status: RunStatus): Promise<IterationRun[]>
  /** The most recent run for an iteration, any status. */
  getLatestRun(iterationId: string): Promise<IterationRun | undefined>
  /**
   * The most recent `completed` run for an iteration; what the board reads, so a later running/failed
   * re-run does not blank a good board.
   */
  getLatestCompletedRun(iterationId: string): Promise<IterationRun | undefined>
  /** A run's scheduled games, ordered by `game_index`. */
  listRunGames(runId: string): Promise<IterationRunGame[]>
  /** Advance a scheduled game's status, stamping `started_at`/`ended_at` and recording an optional error. */
  setRunGameStatus(id: string, status: GameStatus, error?: string): Promise<void>
  /** Link a scheduled game to its Stage 4 recording so the board row can deep-link a replay. */
  attachRunGameRecording(gameId: string, recordingId: string): Promise<void>
  /** Record one per-seat game result with its concrete agent columns and timing aggregates. */
  recordGameResult(input: RecordGameResultInput): Promise<GameResult>
  /** Every game result for a run (joined through its games), for the board aggregation. */
  listGameResultsByRun(runId: string): Promise<GameResult[]>

  /** Rewrite an iteration's placement rows for a newly completed run (supersedes the prior set). */
  replaceAutomatedPlacements(
    iterationId: string,
    envId: string,
    runId: string,
    rows: PlacementInput[],
  ): Promise<void>
  /** An agent's placements across iterations, optionally narrowed to one environment (agent profile). */
  listPlacementsByAgent(agent: AgentRef, envId?: string): Promise<AutomatedPlacement[]>
  /** The automated board: per-agent aggregates over the iteration's latest completed run. */
  getAutomatedBoard(iterationId: string): Promise<AutomatedBoardRow[]>

  /**
   * Insert or overwrite a 1-5 rating, keyed by `(iteration, rater, agent)`. Rejects a rating of the
   * user's own submitted agent (`own_agent`) and an out-of-range score (`invalid_score`) before any
   * write; the Naive baseline is rateable.
   */
  upsertRating(input: UpsertRatingInput): Promise<UpsertRatingResult>
  /** One user's effective rating of an agent in an iteration, if any. */
  getRating(iterationId: string, raterUserId: string, agent: AgentRef): Promise<Rating | undefined>
  /** Every rating in an iteration. */
  listRatingsByIteration(iterationId: string): Promise<Rating[]>
  /** Mean score and count per agent for an iteration's human board. */
  aggregateRatingsByAgent(iterationId: string): Promise<RatingAggregate[]>

  /** Insert or overwrite the agent author's per-iteration rating prompt, keyed by `(iteration, user)`. */
  upsertAgentRatingPrompt(iterationId: string, userId: string, prompt: string): Promise<void>
  /** The agent author's prompt for an iteration, if any. */
  getAgentRatingPrompt(iterationId: string, userId: string): Promise<AgentRatingPrompt | undefined>
  /** Every agent-author prompt in an iteration (one per author), for the rating read. */
  listAgentRatingPromptsByIteration(iterationId: string): Promise<AgentRatingPrompt[]>

  /**
   * The recording ids referenced by the latest completed run of every viewable iteration (released,
   * or unreleased-but-operator-worked), so the Stage 4 retention sweep can exempt them from the
   * age/quota passes. Superseded-run recordings fall outside the set and can be reclaimed.
   */
  listProtectedLeaderboardRecordingIds(): Promise<string[]>

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
