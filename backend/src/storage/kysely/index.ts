/**
 * The one implementation of {@link Storage}, written against Kysely's dialect-agnostic query
 * API. Because the domain types are the row types, there is no row-mapping layer: queries
 * return {@link Session} and friends directly.
 *
 * The class is a thin facade: it holds the `Kysely<Database>` handle and delegates each
 * interface method to a free function in the matching per-domain module (`sessions.ts`,
 * `seasons.ts`, …). The query logic lives there; this file is the table of contents that
 * binds the flat {@link Storage} contract to it.
 */
import type { Kysely } from 'kysely'

import type {
  AgentRef,
  AutomatedBoardRow,
  CreateSeasonInput,
  HumanBoardRow,
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
  UpdateSeasonConfigResult,
  UpsertRatingInput,
  UpsertRatingResult,
} from '../index.js'
import type {
  AgentRatingPrompt,
  AutomatedPlacement,
  Database,
  GameResult,
  GameStatus,
  PublicSeason,
  Rating,
  Recording,
  ReleaseStatus,
  RunStatus,
  Season,
  SeasonRun,
  SeasonRunGame,
  SeasonScope,
  Session,
  SessionSubmission,
  Submission,
  SubmissionCheck,
  SubmissionStage,
  SubmissionStatus,
  TerminationReason,
  WindowStatus,
} from '../schema.js'
import type { SeasonConfig } from '../season-config.js'
import * as boards from './boards.js'
import * as ratings from './ratings.js'
import * as recordings from './recordings.js'
import * as retention from './retention.js'
import * as runs from './runs.js'
import * as seasons from './seasons.js'
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

  // --- Seasons ---

  getOpenSubmissionSeason(envId: string): Promise<Season | undefined> {
    return seasons.getOpenSubmissionSeason(this.db, envId)
  }
  getSeason(id: string): Promise<Season | undefined> {
    return seasons.getSeason(this.db, id)
  }
  ensureOpenSeason(
    envId: string,
    depsVersion: number,
    defaults?: { label?: string | null; release?: ReleaseStatus },
  ): Promise<Season> {
    return seasons.ensureOpenSeason(this.db, envId, depsVersion, defaults)
  }
  getPublicPlaySeason(envId: string): Promise<Season | undefined> {
    return seasons.getPublicPlaySeason(this.db, envId)
  }
  createSeason(input: CreateSeasonInput): Promise<Season> {
    return seasons.createSeason(this.db, input)
  }
  updateSeasonConfig(
    id: string,
    config: SeasonConfig,
    options?: { force?: boolean },
  ): Promise<UpdateSeasonConfigResult> {
    return seasons.updateSeasonConfig(this.db, id, config, options)
  }
  setSubmissionStatus(id: string, status: WindowStatus): Promise<SetSubmissionStatusResult> {
    return seasons.setSubmissionStatus(this.db, id, status)
  }
  setPlayStatus(id: string, status: WindowStatus): Promise<SetPlayStatusResult> {
    return seasons.setPlayStatus(this.db, id, status)
  }
  setReleaseStatus(id: string, status: ReleaseStatus): Promise<Season> {
    return seasons.setReleaseStatus(this.db, id, status)
  }
  getReleasedSeason(envId: string): Promise<Season | undefined> {
    return seasons.getReleasedSeason(this.db, envId)
  }
  listSeasons(options?: { envId?: string; scope?: SeasonScope }): Promise<PublicSeason[]> {
    return seasons.listSeasons(this.db, options)
  }
  setSessionSeason(sessionId: string, seasonId: string): Promise<void> {
    return seasons.setSessionSeason(this.db, sessionId, seasonId)
  }
  setSeasonRatingPrompt(seasonId: string, prompt: string | null): Promise<void> {
    return seasons.setSeasonRatingPrompt(this.db, seasonId, prompt)
  }
  setSeasonLabel(seasonId: string, label: string | null): Promise<void> {
    return seasons.setSeasonLabel(this.db, seasonId, label)
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
  listSessionSubmissions(sessionId: string): Promise<SessionSubmission[]> {
    return submissions.listSessionSubmissions(this.db, sessionId)
  }
  getSubmission(id: string): Promise<Submission | undefined> {
    return submissions.getSubmission(this.db, id)
  }
  findActiveSubmission(seasonId: string, userId: string): Promise<Submission | undefined> {
    return submissions.findActiveSubmission(this.db, seasonId, userId)
  }
  listPendingSubmissions(): Promise<Submission[]> {
    return submissions.listPendingSubmissions(this.db)
  }
  listSubmissionsByUser(userId: string, envId?: string): Promise<Submission[]> {
    return submissions.listSubmissionsByUser(this.db, userId, envId)
  }
  listActiveSubmissionsBySeason(
    seasonId: string,
    status?: SubmissionStatus,
  ): Promise<Submission[]> {
    return submissions.listActiveSubmissionsBySeason(this.db, seasonId, status)
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
    seasonId: string,
    requestedBy: string,
    submissionSnapshot: AgentRef[],
    scheduledGames: ScheduledGameInput[],
  ): Promise<SeasonRun> {
    return runs.createRunWithSchedule(
      this.db,
      seasonId,
      requestedBy,
      submissionSnapshot,
      scheduledGames,
    )
  }
  async deleteRunsForSeason(seasonId: string): Promise<void> {
    await this.db.transaction().execute((trx) => runs.deleteRunsForSeason(trx, seasonId))
  }
  async deleteSubmissionsForSeason(seasonId: string): Promise<void> {
    await this.db
      .transaction()
      .execute((trx) => submissions.deleteSubmissionsForSeason(trx, seasonId))
  }
  setRunStatus(id: string, status: RunStatus, error?: string): Promise<void> {
    return runs.setRunStatus(this.db, id, status, error)
  }
  getRun(id: string): Promise<SeasonRun | undefined> {
    return runs.getRun(this.db, id)
  }
  listRunsByStatus(status: RunStatus): Promise<SeasonRun[]> {
    return runs.listRunsByStatus(this.db, status)
  }
  getLatestRun(seasonId: string): Promise<SeasonRun | undefined> {
    return runs.getLatestRun(this.db, seasonId)
  }
  listRunsBySeason(seasonId: string): Promise<SeasonRun[]> {
    return runs.listRunsBySeason(this.db, seasonId)
  }
  countRunGamesBySeason(seasonId: string): Promise<Map<string, number>> {
    return runs.countRunGamesBySeason(this.db, seasonId)
  }
  getLatestCompletedRun(seasonId: string): Promise<SeasonRun | undefined> {
    return runs.getLatestCompletedRun(this.db, seasonId)
  }
  listRunGames(runId: string): Promise<SeasonRunGame[]> {
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
    seasonId: string,
    envId: string,
    runId: string,
    rows: PlacementInput[],
  ): Promise<void> {
    return boards.replaceAutomatedPlacements(this.db, seasonId, envId, runId, rows)
  }
  listPlacementsByAgent(agent: AgentRef, envId?: string): Promise<AutomatedPlacement[]> {
    return boards.listPlacementsByAgent(this.db, agent, envId)
  }
  getAutomatedBoard(seasonId: string): Promise<AutomatedBoardRow[]> {
    return boards.getAutomatedBoard(this.db, seasonId)
  }

  // --- Ratings & rating prompts ---

  upsertRating(input: UpsertRatingInput): Promise<UpsertRatingResult> {
    return ratings.upsertRating(this.db, input)
  }
  getRating(seasonId: string, raterUserId: string, agent: AgentRef): Promise<Rating | undefined> {
    return ratings.getRating(this.db, seasonId, raterUserId, agent)
  }
  listRatingsBySeason(seasonId: string): Promise<Rating[]> {
    return ratings.listRatingsBySeason(this.db, seasonId)
  }
  aggregateRatingsByAgent(seasonId: string): Promise<RatingAggregate[]> {
    return ratings.aggregateRatingsByAgent(this.db, seasonId)
  }
  getHumanBoard(seasonId: string, automated: AutomatedBoardRow[]): Promise<HumanBoardRow[]> {
    return boards.getHumanBoard(this.db, seasonId, automated)
  }
  upsertAgentRatingPrompt(seasonId: string, userId: string, prompt: string): Promise<void> {
    return ratings.upsertAgentRatingPrompt(this.db, seasonId, userId, prompt)
  }
  getAgentRatingPrompt(seasonId: string, userId: string): Promise<AgentRatingPrompt | undefined> {
    return ratings.getAgentRatingPrompt(this.db, seasonId, userId)
  }
  listAgentRatingPromptsBySeason(seasonId: string): Promise<AgentRatingPrompt[]> {
    return ratings.listAgentRatingPromptsBySeason(this.db, seasonId)
  }

  // --- Retention ---

  listProtectedLeaderboardRecordingIds(): Promise<string[]> {
    return retention.listProtectedLeaderboardRecordingIds(this.db)
  }

  async close(): Promise<void> {
    await this.db.destroy()
  }
}
