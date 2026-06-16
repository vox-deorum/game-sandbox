/**
 * The one implementation of {@link Storage}, written against Kysely's dialect-agnostic query
 * API. Because the domain types are the row types, there is no row-mapping layer: queries
 * return {@link Session} and friends directly.
 *
 * The class is a thin facade: it holds the `Kysely<Database>` handle and delegates each
 * interface method to a free function in the matching per-domain module (`sessions.ts`,
 * `iterations.ts`, …). The query logic lives there; this file is the table of contents that
 * binds the flat {@link Storage} contract to it.
 */
import type { Kysely } from 'kysely'

import type {
  AgentRef,
  AutomatedBoardRow,
  CreateIterationInput,
  NewRecordingInput,
  NewSessionInput,
  NewSubmissionInput,
  PlacementInput,
  RatingAggregate,
  RecordGameResultInput,
  ScheduledGameInput,
  SetPlayStatusResult,
  SetSubmissionStatusResult,
  Storage,
  SubmissionCheckOutcome,
  SubmissionFailureStatus,
  UpdateIterationConfigResult,
  UpsertRatingInput,
  UpsertRatingResult,
} from '../index.js'
import type { IterationConfig } from '../iteration-config.js'
import type {
  AgentRatingPrompt,
  AutomatedPlacement,
  Database,
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
  Submission,
  SubmissionCheck,
  SubmissionStage,
  SubmissionStatus,
  TerminationReason,
  WindowStatus,
} from '../schema.js'
import * as boards from './boards.js'
import * as iterations from './iterations.js'
import * as ratings from './ratings.js'
import * as recordings from './recordings.js'
import * as retention from './retention.js'
import * as runs from './runs.js'
import * as sessions from './sessions.js'
import * as submissions from './submissions.js'

export class KyselyStorage implements Storage {
  constructor(private readonly db: Kysely<Database>) {}

  // --- Sessions ---

  createSession(input: NewSessionInput): Promise<Session> {
    return sessions.createSession(this.db, input)
  }
  markRunning(id: string): Promise<void> {
    return sessions.markRunning(this.db, id)
  }
  markEnded(id: string, reason: TerminationReason, endedAt: string): Promise<void> {
    return sessions.markEnded(this.db, id, reason, endedAt)
  }
  findActiveSessionByUser(userId: string): Promise<Session | undefined> {
    return sessions.findActiveSessionByUser(this.db, userId)
  }
  getSession(id: string): Promise<Session | undefined> {
    return sessions.getSession(this.db, id)
  }
  listSessions(): Promise<Session[]> {
    return sessions.listSessions(this.db)
  }

  // --- Recordings ---

  createRecording(input: NewRecordingInput): Promise<void> {
    return recordings.createRecording(this.db, input)
  }
  listRecordings(): Promise<Recording[]> {
    return recordings.listRecordings(this.db)
  }
  getRecording(id: string): Promise<Recording | undefined> {
    return recordings.getRecording(this.db, id)
  }
  setRecordingPinned(id: string, pinned: boolean): Promise<void> {
    return recordings.setRecordingPinned(this.db, id, pinned)
  }
  countPinnedByUser(userId: string): Promise<number> {
    return recordings.countPinnedByUser(this.db, userId)
  }
  deleteRecording(id: string): Promise<void> {
    return recordings.deleteRecording(this.db, id)
  }

  // --- Iterations ---

  getOpenSubmissionIteration(envId: string): Promise<Iteration | undefined> {
    return iterations.getOpenSubmissionIteration(this.db, envId)
  }
  getIteration(id: string): Promise<Iteration | undefined> {
    return iterations.getIteration(this.db, id)
  }
  ensureOpenIteration(envId: string, depsVersion: number): Promise<Iteration> {
    return iterations.ensureOpenIteration(this.db, envId, depsVersion)
  }
  getPublicPlayIteration(envId: string): Promise<Iteration | undefined> {
    return iterations.getPublicPlayIteration(this.db, envId)
  }
  createIteration(input: CreateIterationInput): Promise<Iteration> {
    return iterations.createIteration(this.db, input)
  }
  updateIterationConfig(
    id: string,
    config: IterationConfig,
    options?: { force?: boolean },
  ): Promise<UpdateIterationConfigResult> {
    return iterations.updateIterationConfig(this.db, id, config, options)
  }
  setSubmissionStatus(id: string, status: WindowStatus): Promise<SetSubmissionStatusResult> {
    return iterations.setSubmissionStatus(this.db, id, status)
  }
  setPlayStatus(id: string, status: WindowStatus): Promise<SetPlayStatusResult> {
    return iterations.setPlayStatus(this.db, id, status)
  }
  setReleaseStatus(id: string, status: ReleaseStatus): Promise<Iteration> {
    return iterations.setReleaseStatus(this.db, id, status)
  }
  listIterations(envId: string, options?: { includeUnreleased?: boolean }): Promise<Iteration[]> {
    return iterations.listIterations(this.db, envId, options)
  }
  getReleasedIteration(envId: string): Promise<Iteration | undefined> {
    return iterations.getReleasedIteration(this.db, envId)
  }
  setSessionIteration(sessionId: string, iterationId: string): Promise<void> {
    return iterations.setSessionIteration(this.db, sessionId, iterationId)
  }
  setIterationRatingPrompt(iterationId: string, prompt: string | null): Promise<void> {
    return iterations.setIterationRatingPrompt(this.db, iterationId, prompt)
  }

  // --- Submissions ---

  createSubmission(input: NewSubmissionInput): Promise<Submission> {
    return submissions.createSubmission(this.db, input)
  }
  updateSubmissionPin(id: string, commitSha: string): Promise<void> {
    return submissions.updateSubmissionPin(this.db, id, commitSha)
  }
  updateSubmissionStatus(id: string, status: 'ready'): Promise<void>
  updateSubmissionStatus(id: string, status: SubmissionFailureStatus, reason: string): Promise<void>
  updateSubmissionStatus(
    id: string,
    status: SubmissionFailureStatus | 'ready',
    reason?: string,
  ): Promise<void> {
    return submissions.updateSubmissionStatus(this.db, id, status, reason)
  }
  startSubmissionCheck(submissionId: string, stage: SubmissionStage): Promise<void> {
    return submissions.startSubmissionCheck(this.db, submissionId, stage)
  }
  finishSubmissionCheck(
    submissionId: string,
    stage: SubmissionStage,
    status: SubmissionCheckOutcome,
    detail?: string,
  ): Promise<void> {
    return submissions.finishSubmissionCheck(this.db, submissionId, stage, status, detail)
  }
  recordSessionSubmission(sessionId: string, submissionId: string, slotId: string): Promise<void> {
    return submissions.recordSessionSubmission(this.db, sessionId, submissionId, slotId)
  }
  getSubmission(id: string): Promise<Submission | undefined> {
    return submissions.getSubmission(this.db, id)
  }
  findActiveSubmission(iterationId: string, userId: string): Promise<Submission | undefined> {
    return submissions.findActiveSubmission(this.db, iterationId, userId)
  }
  listPendingSubmissions(): Promise<Submission[]> {
    return submissions.listPendingSubmissions(this.db)
  }
  listSubmissionsByUser(userId: string, envId?: string): Promise<Submission[]> {
    return submissions.listSubmissionsByUser(this.db, userId, envId)
  }
  listActiveSubmissionsByIteration(
    iterationId: string,
    status?: SubmissionStatus,
  ): Promise<Submission[]> {
    return submissions.listActiveSubmissionsByIteration(this.db, iterationId, status)
  }
  listSubmissionChecks(submissionId: string): Promise<SubmissionCheck[]> {
    return submissions.listSubmissionChecks(this.db, submissionId)
  }
  listActiveReadySubmissionIds(): Promise<string[]> {
    return submissions.listActiveReadySubmissionIds(this.db)
  }
  listRecordingsBySubmission(submissionId: string, limit: number): Promise<string[]> {
    return submissions.listRecordingsBySubmission(this.db, submissionId, limit)
  }

  // --- Runs & games ---

  createRunWithSchedule(
    iterationId: string,
    requestedBy: string,
    submissionSnapshot: AgentRef[],
    scheduledGames: ScheduledGameInput[],
  ): Promise<IterationRun> {
    return runs.createRunWithSchedule(
      this.db,
      iterationId,
      requestedBy,
      submissionSnapshot,
      scheduledGames,
    )
  }
  async deleteRunsForIteration(iterationId: string): Promise<void> {
    await this.db.transaction().execute((trx) => runs.deleteRunsForIteration(trx, iterationId))
  }
  async deleteSubmissionsForIteration(iterationId: string): Promise<void> {
    await this.db
      .transaction()
      .execute((trx) => submissions.deleteSubmissionsForIteration(trx, iterationId))
  }
  setRunStatus(id: string, status: RunStatus, error?: string): Promise<void> {
    return runs.setRunStatus(this.db, id, status, error)
  }
  getLatestRun(iterationId: string): Promise<IterationRun | undefined> {
    return runs.getLatestRun(this.db, iterationId)
  }
  getLatestCompletedRun(iterationId: string): Promise<IterationRun | undefined> {
    return runs.getLatestCompletedRun(this.db, iterationId)
  }
  listRunGames(runId: string): Promise<IterationRunGame[]> {
    return runs.listRunGames(this.db, runId)
  }
  setRunGameStatus(id: string, status: GameStatus, error?: string): Promise<void> {
    return runs.setRunGameStatus(this.db, id, status, error)
  }
  attachRunGameRecording(gameId: string, recordingId: string): Promise<void> {
    return runs.attachRunGameRecording(this.db, gameId, recordingId)
  }
  recordGameResult(input: RecordGameResultInput): Promise<GameResult> {
    return runs.recordGameResult(this.db, input)
  }
  listGameResultsByRun(runId: string): Promise<GameResult[]> {
    return runs.listGameResultsByRun(this.db, runId)
  }

  // --- Automated board & placements ---

  replaceAutomatedPlacements(
    iterationId: string,
    envId: string,
    runId: string,
    rows: PlacementInput[],
  ): Promise<void> {
    return boards.replaceAutomatedPlacements(this.db, iterationId, envId, runId, rows)
  }
  listPlacementsByAgent(agent: AgentRef, envId?: string): Promise<AutomatedPlacement[]> {
    return boards.listPlacementsByAgent(this.db, agent, envId)
  }
  getAutomatedBoard(iterationId: string): Promise<AutomatedBoardRow[]> {
    return boards.getAutomatedBoard(this.db, iterationId)
  }

  // --- Ratings & rating prompts ---

  upsertRating(input: UpsertRatingInput): Promise<UpsertRatingResult> {
    return ratings.upsertRating(this.db, input)
  }
  getRating(
    iterationId: string,
    raterUserId: string,
    agent: AgentRef,
  ): Promise<Rating | undefined> {
    return ratings.getRating(this.db, iterationId, raterUserId, agent)
  }
  listRatingsByIteration(iterationId: string): Promise<Rating[]> {
    return ratings.listRatingsByIteration(this.db, iterationId)
  }
  aggregateRatingsByAgent(iterationId: string): Promise<RatingAggregate[]> {
    return ratings.aggregateRatingsByAgent(this.db, iterationId)
  }
  upsertAgentRatingPrompt(iterationId: string, userId: string, prompt: string): Promise<void> {
    return ratings.upsertAgentRatingPrompt(this.db, iterationId, userId, prompt)
  }
  getAgentRatingPrompt(
    iterationId: string,
    userId: string,
  ): Promise<AgentRatingPrompt | undefined> {
    return ratings.getAgentRatingPrompt(this.db, iterationId, userId)
  }
  listAgentRatingPromptsByIteration(iterationId: string): Promise<AgentRatingPrompt[]> {
    return ratings.listAgentRatingPromptsByIteration(this.db, iterationId)
  }

  // --- Retention ---

  listProtectedLeaderboardRecordingIds(): Promise<string[]> {
    return retention.listProtectedLeaderboardRecordingIds(this.db)
  }

  async close(): Promise<void> {
    await this.db.destroy()
  }
}
