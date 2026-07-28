/**
 * The storage seam.
 *
 * A narrow, domain-shaped interface over the relational data: callers see the derived domain
 * types from `schema.ts`, never SQL or query building. This interface is what the orchestrator
 * and the HTTP tests are written against; the `kysely/` module is its one implementation and
 * `sqlite.ts` its one wiring today. Swapping engines is a new wiring file against the same schema,
 * queries, and interface.
 */

import type { ParameterValue } from '@game-sandbox/schema/environment'
import type { ResolvedOfficialLlmPolicy } from '../llm/config.js'

export { isAgentRef } from './schema.js'

import type {
  AgentRatingPrompt,
  AgentRef,
  AutomatedPlacement,
  CheckStatus,
  GameResult,
  GameStatus,
  LlmDevelopmentKey,
  LlmUsageByModel,
  PublicSeason,
  Rating,
  Recording,
  RecordingCleanup,
  ReleaseStatus,
  RunStatus,
  Season,
  SeasonRun,
  SeasonRunGame,
  SeasonScope,
  Session,
  SessionMode,
  SessionSubmission,
  Submission,
  SubmissionCheck,
  SubmissionRef,
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
  LlmDevelopmentKey,
  LlmModelUsage,
  LlmUsageByModel,
  PublicSeason,
  Rating,
  Recording,
  RecordingCleanup,
  ReleaseStatus,
  RunStatus,
  Season,
  SeasonRun,
  SeasonRunGame,
  SeasonScope,
  SeasonStatus,
  Session,
  SessionMode,
  SessionStatus,
  SessionSubmission,
  Submission,
  SubmissionCheck,
  SubmissionRef,
  SubmissionSourceKind,
  SubmissionStage,
  SubmissionStatus,
  TerminationReason,
  WindowStatus,
} from './schema.js'

import type { SeasonConfig } from './season-config.js'

export type {
  MatchConfig,
  Overrides,
  SeasonConfig,
  SeatSpec,
} from './season-config.js'

export {
  decodeSeasonConfig,
  emptySeasonConfig,
  encodeSeasonConfig,
  parseSeasonConfig,
  SeasonConfigError,
  SeasonConfigSchema,
} from './season-config.js'

/** The fields the orchestrator provides when starting a session. */
export interface NewSessionInput {
  id: string
  user_id: string
  env_id: string
  mode: SessionMode
  recording_id: string | null
  /**
   * The season this session competes in, or null when it has no competition boundary (the key
   * ratings later attach to). Defaults to null when omitted, preserving the Stage 5 callers.
   */
  season_id?: string | null
  /**
   * The resolved per-move budget (ms) for the connected human seat, so the live page can show the move
   * clock using the session's value. Null (the default when omitted) for a session with no human seat
   * or an environment that declares no human timeout.
   */
  human_timeout_ms?: number | null
  /**
   * The session's resolved effective messaging rules (metadata AND the season override), written once
   * at start so the payload serves them live or ended. `messaging_enabled` is a SQLite 0/1; both
   * default to off/no-cap when omitted, preserving callers that never set them.
   */
  messaging_enabled?: number
  message_cap?: number | null
  llm_enabled?: number
  /** Fully resolved environment parameters, preserved verbatim in the public session projection. */
  parameters: Record<string, ParameterValue>
  created_at: string
}

/** The fields the finalize routine provides when registering a produced recording. */
export interface NewRecordingInput {
  id: string
  user_id: string
  env_id: string
  created_at: string
  /**
   * The producing run's termination reason, for a recording with no session to carry it (an automated
   * season run). Omit (or null) for a session-produced recording — the listing reads the session's
   * reason — and for a non-completed automated game.
   */
  termination_reason?: TerminationReason | null
  llm_scope_id?: string | null
  llm_session_id?: string | null
}

/** Why an atomic recording-cleanup claim did or did not remove the current row. */
export type RecordingCleanupClaimResult =
  | 'claimed'
  | 'missing'
  | 'pinned'
  | 'active_scope'
  | 'protected'

/**
 * The domain-shaped fields the submission route provides when creating a pending submission. The
 * row is always inserted as `pending`; `commit_sha` may still be null (it is filled by source
 * resolution for git, and stays null for local). The `created_at` doubles as the supersede stamp
 * written onto any prior active submission by the same user in the same season.
 */
export interface NewSubmissionInput {
  season_id: string
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
 * season race and the partial unique index rejects the second transaction. The route turns
 * this into a retryable 409 rather than a 500.
 */
export class SubmissionConflictError extends Error {
  constructor(message = 'a concurrent submission became active first') {
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

/** The fields the admin "declare season" action provides. Config (incl. deps) defaults internally. */
export interface CreateSeasonInput {
  env_id: string
  /** The pinned dependency-set version, defaulting to the current release at declaration. */
  deps_version: number
  /** An optional operator-facing label. */
  label?: string | null
}

/**
 * The outcome of {@link Storage.updateSeasonConfig}. An unforced edit against existing runs is
 * refused with `season_has_runs`; an unforced `deps_version` change against existing submissions is
 * refused with `season_has_submissions`. A forced edit clears the blocking rows first (step 3
 * surfaces this as a UI confirmation).
 */
export type UpdateSeasonConfigResult =
  | { ok: true; season: Season }
  | { ok: false; conflict: 'season_has_runs' | 'season_has_submissions' }

/** The outcome of opening the submission window: a typed conflict when the one-open invariant blocks it. */
export type SetSubmissionStatusResult =
  | { ok: true; season: Season }
  | { ok: false; conflict: 'open_season_exists' }

/** The outcome of opening the public-play window: a typed conflict when one is already play-open. */
export type SetPlayStatusResult =
  | { ok: true; season: Season }
  | { ok: false; conflict: 'open_play_season_exists' }

/** The result of removing an unused, private season. */
export type DeleteSeasonResult =
  | { ok: true }
  | {
      ok: false
      reason: 'not_found' | 'season_not_deletable' | 'season_not_empty'
    }

/** One concrete scheduled game the pure scheduler produced, persisted by `createRunWithSchedule`. */
export interface ScheduledGameInput {
  match_index: number
  game_index: number
  seed: number
  /** One resolved {@link AgentRef} per seat, in seat order. */
  seats: AgentRef[]
  /** Canonical resolver plan key materialized when this game was scheduled. */
  seat_plan: string
}

export interface FrozenRunInput {
  config: SeasonConfig
  submissions: SubmissionRef[]
}

/** Why a season's frozen inputs produce no run. The trigger route sends these back as typed codes. */
export type RunRejectionCode = 'empty_schedule' | 'invalid_parameters'

export type FrozenRunPlan =
  | {
      ok: true
      parametersSnapshot: Record<string, ParameterValue>
      scheduledGames: ScheduledGameInput[]
      llmPolicy: ResolvedOfficialLlmPolicy
    }
  | { ok: false; code: RunRejectionCode; reason: string }

/**
 * Builds a run's frozen artifacts from the season config and roster the creating transaction read.
 * Returning a rejection rather than throwing keeps "this season cannot run right now" a typed answer
 * the route can classify, instead of an exception that would surface as an untyped 500.
 */
export type FrozenRunBuilder = (input: FrozenRunInput) => FrozenRunPlan

export type CreateRunOutcome =
  | { ok: true; run: SeasonRun }
  | { ok: false; code: RunRejectionCode; reason: string }

/** A per-seat game outcome the runner derives from the recording. */
export interface RecordGameResultInput {
  game_id: string
  seat_index: number
  agent: AgentRef
  episode_score: number
  agent_compute_ms_total: number
  acted_tick_count: number
  /** Successful official calls for this seat, or null when it made none. */
  llm_usage_by_model?: LlmUsageByModel | null
  /** Frozen-policy weighted token cost, or null exactly when LLM usage is absent. */
  llm_weighted_cost?: number | null
  failed: boolean
  failure_reason?: string | null
}

/** One placement row for `replaceAutomatedPlacements`; the season/env/run are passed alongside. */
export interface PlacementInput {
  rank: number
  agent: AgentRef
  mean_score: number
  /** Null/blank when the contributing tick count was zero. */
  mean_agent_compute_ms: number | null
  /** Successful official calls aggregated over the placement's games, or null when there were none. */
  llm_usage_by_model?: LlmUsageByModel | null
  /** Weighted token cost aggregated over the placement's games. */
  llm_weighted_cost?: number | null
  failure_count: number
  recording_id: string | null
}

/** A rating to insert or overwrite. The own-agent rule is enforced before any write. */
export interface UpsertRatingInput {
  season_id: string
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

/** One aggregated rating row for the human board: the agent and its mean score, spread, and count. */
export interface RatingAggregate {
  agent: AgentRef
  mean: number
  /** Population standard deviation of the agent's ratings, shown beside the mean (0 for a single rating). */
  std: number
  count: number
}

/**
 * One human-board row: a {@link RatingAggregate} with the ranking applied. `rank` is the 1-based
 * placement when the agent has at least {@link HUMAN_BOARD_MIN_RATINGS} ratings, or `null` when it is
 * still under the threshold and shown unranked below the ranked set.
 */
export interface HumanBoardRow {
  agent: AgentRef
  mean: number
  /** Population standard deviation of the agent's ratings, shown as the spread beside the mean. */
  std: number
  count: number
  rank: number | null
  /**
   * The agent's representative replay link, the same best-game recording the automated board shows for
   * it, so the human board can deep-link a replay too. Null when the agent has no recorded game.
   */
  recording_id: string | null
  /** The agent author's rating prompt for this season, when set (null for the ownerless Naive baseline). */
  author_prompt: string | null
}

/**
 * One automated-board row: a per-agent aggregate over the latest completed run's results. The board
 * service (step 5) shapes the public response from these; mean per-decision time is null when no tick
 * contributed.
 */
export interface AutomatedBoardRow {
  agent: AgentRef
  mean_score: number
  /** Population standard deviation of the per-game episode score: the spread shown beside the mean. */
  score_std: number
  mean_agent_compute_ms: number | null
  /**
   * Acted-tick-weighted population standard deviation of the agent's per-game per-decision compute
   * rate, shown beside the weighted mean. Null exactly when the mean is absent because no game
   * contributed a tick.
   */
  compute_std: number | null
  /** Successful official calls aggregated over the agent's games, or null when there were none. */
  llm_usage_by_model: LlmUsageByModel | null
  /** Frozen-policy weighted token cost aggregated over the agent's games. */
  llm_weighted_cost: number | null
  failure_count: number
  /** The number of games that produced a result for this agent in the run. */
  games: number
  /** A representative replay link (the recording of the agent's best game), or null. */
  recording_id: string | null
}

export interface Storage {
  rotateDevelopmentKey(input: {
    seasonId: string
    userId: string
    keyId: string
    secretHash: string
    now: string
  }): Promise<LlmDevelopmentKey>
  getDevelopmentKeyByKeyId(keyId: string): Promise<LlmDevelopmentKey | undefined>
  getDevelopmentKey(seasonId: string, userId: string): Promise<LlmDevelopmentKey | undefined>

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
  setRecordingPinned(id: string, pinned: boolean): Promise<boolean>
  /** How many recordings a user has pinned; backs the pin-quota guard. */
  countPinnedByUser(userId: string): Promise<number>
  /**
   * Atomically revalidate and claim one candidate for cleanup, removing its recording row and
   * inserting durable cleanup work only when it remains unpinned, inactive, and unprotected.
   */
  claimRecordingCleanup(id: string): Promise<RecordingCleanupClaimResult>
  /** Durable filesystem and final-scope telemetry cleanup work, in claim order. */
  listRecordingCleanupQueue(): Promise<RecordingCleanup[]>
  /** Acknowledge cleanup only after its directory and optional telemetry scope have been deleted. */
  completeRecordingCleanup(recordingId: string): Promise<void>

  /**
   * The environment's submission-`open` season, the identity boundary every submission needs (the
   * Stage 5 `getOpenSeason`, renamed now that "open" is ambiguous across the submission and play
   * windows).
   */
  getOpenSubmissionSeason(envId: string): Promise<Season | undefined>
  /**
   * One season by id, regardless of its gates. The validation worker reads the pinned
   * `deps_version` (now inside `config`) of the season a submission belongs to.
   */
  getSeason(id: string): Promise<Season | undefined>
  /**
   * The seed primitive: ensure a submission-`open` season exists for the environment at
   * `depsVersion` and return it, writing a default config that carries the version and an empty match
   * design. Idempotent; an environment already carrying a submission-open season is left untouched.
   * The seed row is play-`open` for local continuity. `defaults` apply only when a row is created:
   * the seed passes a `label` and `release` to stand up the default "Playground" season; without them
   * a fresh row is unlabeled and unreleased.
   */
  ensureOpenSeason(
    envId: string,
    depsVersion: number,
    defaults?: { label?: string | null; release?: ReleaseStatus },
  ): Promise<Season>
  /** The environment's play-`open` season: the default public watch/play target, if any. */
  getPublicPlaySeason(envId: string): Promise<Season | undefined>
  /**
   * Declare a new season: `unreleased`, submission-`closed`, play-`closed`, with a default config
   * (including the given `deps_version`) and an empty match design.
   */
  createSeason(input: CreateSeasonInput): Promise<Season>
  /**
   * Remove a season only while both public windows are closed, it is unreleased, and no activity
   * has ever been associated with it. The check and delete share one transaction.
   */
  deleteSeason(id: string): Promise<DeleteSeasonResult>
  /**
   * Replace the whole {@link SeasonConfig} (including `deps_version`). With no runs and no
   * `deps_version` change it just writes; otherwise it needs `force`, which first deletes the
   * season's runs, and — when `deps_version` changed and submissions exist — its submissions.
   * Returns a typed conflict when a write is refused for want of `force`.
   */
  updateSeasonConfig(
    id: string,
    config: SeasonConfig,
    options?: { force?: boolean },
  ): Promise<UpdateSeasonConfigResult>
  /**
   * Open or close the submission window. Opening returns `open_season_exists` when another season
   * for the same environment already accepts submissions (the one-open invariant).
   */
  setSubmissionStatus(id: string, status: WindowStatus): Promise<SetSubmissionStatusResult>
  /**
   * Open or close the public-play window. Opening returns `open_play_season_exists` when another
   * season for the same environment is already play-open, regardless of release status.
   */
  setPlayStatus(id: string, status: WindowStatus): Promise<SetPlayStatusResult>
  /** Set the release status, stamping `released_at` on the first release and leaving it stable after. */
  setReleaseStatus(id: string, status: ReleaseStatus): Promise<Season>
  /** The latest `released` season for an environment, ordered by `released_at`. */
  getReleasedSeason(envId: string): Promise<Season | undefined>
  /**
   * Seasons newest first, with public activity counts, optionally narrowed to one environment. The
   * `scope` sets visibility: `'released'` (public boards/history), `'public'` (any public-facing flag
   * — `released`, submission-`open`, or play-`open`), or `'all'` (every season, including
   * fully-private unreleased ones — gated to operators at the route boundary).
   */
  listSeasons(options?: { envId?: string; scope?: SeasonScope }): Promise<PublicSeason[]>
  /** Attribute an existing session to a season (the alternative to passing it at create time). */
  setSessionSeason(sessionId: string, seasonId: string): Promise<void>

  /** The operator's season-wide rating prompt; editable anytime, never gated by the config rules. */
  setSeasonRatingPrompt(seasonId: string, prompt: string | null): Promise<void>
  /** Set or clear the public Season description; editable anytime and outside run configuration. */
  setSeasonDescription(seasonId: string, markdown: string | null): Promise<Season | undefined>
  /** Rename a season (or clear its label with `null`); editable anytime, never gated by the config rules. */
  setSeasonLabel(seasonId: string, label: string | null): Promise<void>

  /**
   * Snapshot the season's config (incl. deps) and the eligible submitted-agent roster into a new
   * run row, and persist the concrete scheduled games, all in one transaction. The run starts
   * `pending`; the runner reads the persisted games, not the mutable season/submission rows.
   */
  createRunWithSchedule(
    seasonId: string,
    requestedBy: string,
    builder: FrozenRunBuilder,
  ): Promise<CreateRunOutcome>
  /** Delete a season's runs, their games, results, and placements (the forced config-edit path). */
  deleteRunsForSeason(seasonId: string): Promise<void>
  /** Delete a season's submissions (the forced `deps_version`-change path). */
  deleteSubmissionsForSeason(seasonId: string): Promise<void>
  /** Advance a run's status, stamping `ended_at` on a terminal status and recording an optional error. */
  setRunStatus(id: string, status: RunStatus, error?: string): Promise<void>
  /** One run by id, any status; the admin status and log-stream routes resolve a run by its id. */
  getRun(id: string): Promise<SeasonRun | undefined>
  /**
   * Every run in a given status, oldest first. The startup reconcile uses it to find runs a prior
   * process death left non-terminal (`running`/`pending`) and fail them, since a partial workflow run
   * is never silently resumed.
   */
  listRunsByStatus(status: RunStatus): Promise<SeasonRun[]>
  /** The most recent run for a season, any status. */
  getLatestRun(seasonId: string): Promise<SeasonRun | undefined>
  /** Every run for a season, newest first; the admin runs-list reads it. */
  listRunsBySeason(seasonId: string): Promise<SeasonRun[]>
  /** Game count per run for a season, keyed by run id; the runs-list summaries read it. */
  countRunGamesBySeason(seasonId: string): Promise<Map<string, number>>
  /**
   * The most recent `completed` run for a season; what the board reads, so a later running/failed
   * re-run does not blank a good board.
   */
  getLatestCompletedRun(seasonId: string): Promise<SeasonRun | undefined>
  /** A run's scheduled games, ordered by `game_index`. */
  listRunGames(runId: string): Promise<SeasonRunGame[]>
  /** Advance a scheduled game's status, stamping `started_at`/`ended_at` and recording an optional error. */
  setRunGameStatus(id: string, status: GameStatus, error?: string): Promise<void>
  /** Link a scheduled game to its Stage 4 recording so the board row can deep-link a replay. */
  attachRunGameRecording(gameId: string, recordingId: string): Promise<void>
  /** Record one per-seat game result with its concrete agent columns and timing aggregates. */
  recordGameResult(input: RecordGameResultInput): Promise<GameResult>
  /** Every game result for a run (joined through its games), for the board aggregation. */
  listGameResultsByRun(runId: string): Promise<GameResult[]>

  /** Rewrite a season's placement rows for a newly completed run (supersedes the prior set). */
  replaceAutomatedPlacements(
    seasonId: string,
    envId: string,
    runId: string,
    rows: PlacementInput[],
  ): Promise<void>
  /** An agent's placements across seasons, optionally narrowed to one environment (agent profile). */
  listPlacementsByAgent(agent: AgentRef, envId?: string): Promise<AutomatedPlacement[]>
  /**
   * Every submitted-agent placement attributed to a user, across all of their submission attempts.
   * This is the batched score source for the signed-in user's season summary.
   */
  listPlacementsByUser(userId: string): Promise<AutomatedPlacement[]>
  /**
   * The automated board: per-agent aggregates over the season's latest completed run. Pass that run
   * when the caller has already resolved it (to read its games beside the board or persist placements
   * against it) so both describe the identical run and it is looked up once; omit it for a standalone read.
   */
  getAutomatedBoard(seasonId: string, run?: SeasonRun): Promise<AutomatedBoardRow[]>

  /**
   * Insert or overwrite a 1-5 rating, keyed by `(season, rater, agent)`. Rejects a rating of the
   * user's own submitted agent (`own_agent`) and an out-of-range score (`invalid_score`) before any
   * write; the Naive baseline is rateable.
   */
  upsertRating(input: UpsertRatingInput): Promise<UpsertRatingResult>
  /** One user's effective rating of an agent in a season, if any. */
  getRating(seasonId: string, raterUserId: string, agent: AgentRef): Promise<Rating | undefined>
  /** Every rating in a season. */
  listRatingsBySeason(seasonId: string): Promise<Rating[]>
  /** One rater's ratings in a season, for bounded request assembly. */
  listRatingsByRater(seasonId: string, raterUserId: string): Promise<Rating[]>
  /** Mean score and count per agent for a season's human board. */
  aggregateRatingsByAgent(seasonId: string): Promise<RatingAggregate[]>
  /**
   * The human-feedback board: the per-agent aggregates with the ranking rule applied. Agents with at
   * least three ratings are ranked (1-based, by mean then count); agents with one or two ratings follow
   * unranked (`rank: null`), so accumulating feedback is visible without assigning a rank. The caller
   * passes the season's already-computed automated board, the source of each row's representative replay.
   */
  getHumanBoard(seasonId: string, automated: AutomatedBoardRow[]): Promise<HumanBoardRow[]>

  /** Insert or overwrite the agent author's per-season rating prompt, keyed by `(season, user)`. */
  upsertAgentRatingPrompt(seasonId: string, userId: string, prompt: string): Promise<void>
  /** The agent author's prompt for a season, if any. */
  getAgentRatingPrompt(seasonId: string, userId: string): Promise<AgentRatingPrompt | undefined>
  /** Every agent-author prompt in a season (one per author), for the rating read. */
  listAgentRatingPromptsBySeason(seasonId: string): Promise<AgentRatingPrompt[]>
  /** Agent-author prompts for a bounded set of users in one season. */
  listAgentRatingPromptsByUsers(
    seasonId: string,
    userIds: readonly string[],
  ): Promise<AgentRatingPrompt[]>

  /**
   * The recording ids referenced by the latest completed run of every viewable season (released,
   * or unreleased-but-operator-worked), so the Stage 4 retention sweep can exempt them from the
   * age/quota passes. Superseded-run recordings fall outside the set and can be reclaimed.
   */
  listProtectedLeaderboardRecordingIds(): Promise<string[]>

  /**
   * Create a submission as `pending`, superseding any active submission by the same user in the
   * same season first; the supersede-then-insert runs in one transaction so a concurrent
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
  /** Record which submitted agent ran in which session seat, for agent-profile replay history. */
  recordSessionSubmission(sessionId: string, submissionId: string, seatId: string): Promise<void>
  /**
   * The submitted-seat links for a session: the fallback the rating route uses to recover the involved
   * submitted agents when a recording header cannot be read. It cannot surface a pure-Naive session,
   * which has no link rows; the header is the authoritative source.
   */
  listSessionSubmissions(sessionId: string): Promise<SessionSubmission[]>

  /** One submission by id. */
  getSubmission(id: string): Promise<Submission | undefined>
  /**
   * Existing submissions from a bounded id set, for request assembly that would otherwise issue one
   * query per recorded seat. Duplicate ids are collapsed; callers assemble their own response order.
   */
  getSubmissionsByIds(ids: readonly string[]): Promise<Submission[]>
  /** The user's active (`superseded_at IS NULL`) submission in a season, regardless of status. */
  findActiveSubmission(seasonId: string, userId: string): Promise<Submission | undefined>
  /** Active pending submissions, newest first, for the validation worker's startup re-enqueue. */
  listPendingSubmissions(): Promise<Submission[]>
  /** A user's submissions (including superseded history), newest first, optionally one environment. */
  listSubmissionsByUser(userId: string, envId?: string): Promise<Submission[]>
  /** Active (`superseded_at IS NULL`) submissions in a season, optionally narrowed by status. */
  listActiveSubmissionsBySeason(seasonId: string, status?: SubmissionStatus): Promise<Submission[]>
  /** Count active submissions in a season without materializing their rows. */
  countActiveSubmissionsBySeason(seasonId: string, status?: SubmissionStatus): Promise<number>
  /** A submission's per-stage validation log, ordered by pipeline-stage sequence. */
  listSubmissionChecks(submissionId: string): Promise<SubmissionCheck[]>
  /**
   * Every active (`superseded_at IS NULL`) `ready` submission id across all seasons and
   * environments, the exempt set the overlay-image eviction sweep (step 4) keeps.
   */
  listActiveReadySubmissionIds(): Promise<string[]>
  /** A submission's recent recording ids, newest first, ignoring sessions that produced none. */
  listRecordingsBySubmission(submissionId: string, limit: number): Promise<string[]>

  /** Release the underlying database handle. */
  close(): Promise<void>
}
