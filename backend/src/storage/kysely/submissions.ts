/**
 * Submission queries: the supersede-then-insert create, the validation-check pipeline log, the
 * status transitions, and the reads behind the worker re-enqueue, agent profiles, and the
 * overlay-image eviction sweep. Also owns {@link deleteSubmissionsForSeason}, reused by the
 * forced `deps_version`-change path.
 */
import { randomUUID } from 'node:crypto'

import type { Kysely } from 'kysely'

import type {
  NewSubmissionInput,
  SubmissionCheckOutcome,
  SubmissionTerminalStatus,
} from '../index.js'
import { SubmissionConflictError } from '../index.js'
import type {
  Database,
  SessionSubmission,
  Submission,
  SubmissionCheck,
  SubmissionStage,
  SubmissionStatus,
} from '../schema.js'
import { isUniqueConstraintViolation } from './shared.js'

/** Pipeline-stage order for {@link listSubmissionChecks}; SQLite has no enum order. */
const STAGE_ORDER: Record<SubmissionStage, number> = {
  resolve: 0,
  static: 1,
  build: 2,
  load: 3,
}

/** Defensive ceiling for request-driven submission lookups; current environments use at most four. */
const SUBMISSION_BATCH_LIMIT = 100

/** Delete a season's submissions and their checks; same executor-passing rationale as runs. */
export async function deleteSubmissionsForSeason(
  db: Kysely<Database>,
  seasonId: string,
): Promise<void> {
  const submissions = await db
    .selectFrom('submissions')
    .select('id')
    .where('season_id', '=', seasonId)
    .execute()
  const submissionIds = submissions.map((row) => row.id)
  if (submissionIds.length > 0) {
    await db.deleteFrom('submission_checks').where('submission_id', 'in', submissionIds).execute()
  }
  await db.deleteFrom('submissions').where('season_id', '=', seasonId).execute()
}

export async function createSubmission(
  db: Kysely<Database>,
  input: NewSubmissionInput,
): Promise<Submission> {
  try {
    return await db.transaction().execute(async (trx) => {
      // Supersede the prior active submission first, then insert the new pending row; the partial
      // unique index is the backstop if a concurrent resubmit interleaves.
      await trx
        .updateTable('submissions')
        .set({ superseded_at: input.created_at })
        .where('season_id', '=', input.season_id)
        .where('user_id', '=', input.user_id)
        .where('superseded_at', 'is', null)
        .execute()
      return await trx
        .insertInto('submissions')
        .values({
          id: randomUUID(),
          season_id: input.season_id,
          env_id: input.env_id,
          user_id: input.user_id,
          source_kind: input.source_kind,
          repo_url: input.repo_url,
          commit_sha: input.commit_sha,
          local_path: input.local_path,
          ref: input.ref,
          status: 'pending',
          reason: null,
          created_at: input.created_at,
          superseded_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
    })
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new SubmissionConflictError()
    }
    throw error
  }
}

export async function updateSubmissionPin(
  db: Kysely<Database>,
  id: string,
  commitSha: string,
): Promise<void> {
  await db
    .updateTable('submissions')
    .set({ commit_sha: commitSha })
    .where('id', '=', id)
    .where('source_kind', '=', 'git')
    .execute()
}

export async function updateSubmissionStatus(
  db: Kysely<Database>,
  id: string,
  status: SubmissionTerminalStatus,
  reason?: string,
): Promise<void> {
  if (status !== 'ready' && reason === undefined) {
    throw new Error('failed submissions require an owner-visible reason')
  }
  const nextReason = status === 'ready' ? null : reason
  // A success status clears any prior reason; a failure records the owner-visible message.
  await db
    .updateTable('submissions')
    .set({ status, reason: nextReason })
    .where('id', '=', id)
    .execute()
}

export async function startSubmissionCheck(
  db: Kysely<Database>,
  submissionId: string,
  stage: SubmissionStage,
): Promise<void> {
  const now = new Date().toISOString()
  await db
    .insertInto('submission_checks')
    .values({
      id: randomUUID(),
      submission_id: submissionId,
      stage,
      status: 'running',
      detail: null,
      started_at: now,
      ended_at: null,
    })
    .onConflict((oc) =>
      // A re-enqueued submission overwrites its earlier check for this stage rather than appending.
      oc.columns(['submission_id', 'stage']).doUpdateSet({
        status: 'running',
        detail: null,
        started_at: now,
        ended_at: null,
      }),
    )
    .execute()
}

export async function finishSubmissionCheck(
  db: Kysely<Database>,
  submissionId: string,
  stage: SubmissionStage,
  status: SubmissionCheckOutcome,
  detail?: string,
): Promise<void> {
  await db
    .updateTable('submission_checks')
    .set({ status, detail: detail ?? null, ended_at: new Date().toISOString() })
    .where('submission_id', '=', submissionId)
    .where('stage', '=', stage)
    .execute()
}

export async function recordSessionSubmission(
  db: Kysely<Database>,
  sessionId: string,
  submissionId: string,
  seatId: string,
): Promise<void> {
  await db
    .insertInto('session_submissions')
    .values({
      session_id: sessionId,
      submission_id: submissionId,
      seat_id: seatId,
      created_at: new Date().toISOString(),
    })
    .onConflict((oc) => oc.columns(['session_id', 'seat_id']).doNothing())
    .execute()
}

export async function getSubmission(
  db: Kysely<Database>,
  id: string,
): Promise<Submission | undefined> {
  return await db.selectFrom('submissions').selectAll().where('id', '=', id).executeTakeFirst()
}

export async function getSubmissionsByIds(
  db: Kysely<Database>,
  ids: readonly string[],
): Promise<Submission[]> {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) {
    return []
  }
  if (uniqueIds.length > SUBMISSION_BATCH_LIMIT) {
    throw new RangeError(`submission lookup exceeds the ${SUBMISSION_BATCH_LIMIT}-id limit`)
  }
  return await db.selectFrom('submissions').selectAll().where('id', 'in', uniqueIds).execute()
}

export async function listSessionSubmissions(
  db: Kysely<Database>,
  sessionId: string,
): Promise<SessionSubmission[]> {
  return await db
    .selectFrom('session_submissions')
    .selectAll()
    .where('session_id', '=', sessionId)
    .execute()
}

export async function findActiveSubmission(
  db: Kysely<Database>,
  seasonId: string,
  userId: string,
): Promise<Submission | undefined> {
  return await db
    .selectFrom('submissions')
    .selectAll()
    .where('season_id', '=', seasonId)
    .where('user_id', '=', userId)
    .where('superseded_at', 'is', null)
    .executeTakeFirst()
}

export async function listPendingSubmissions(db: Kysely<Database>): Promise<Submission[]> {
  return await db
    .selectFrom('submissions')
    .selectAll()
    .where('status', '=', 'pending')
    .where('superseded_at', 'is', null)
    .orderBy('created_at', 'desc')
    .execute()
}

export async function listSubmissionsByUser(
  db: Kysely<Database>,
  userId: string,
  envId?: string,
): Promise<Submission[]> {
  let query = db.selectFrom('submissions').selectAll().where('user_id', '=', userId)
  if (envId !== undefined) {
    query = query.where('env_id', '=', envId)
  }
  return await query.orderBy('created_at', 'desc').execute()
}

function activeSubmissionsBySeason(
  db: Kysely<Database>,
  seasonId: string,
  status?: SubmissionStatus,
) {
  let query = db
    .selectFrom('submissions')
    .where('season_id', '=', seasonId)
    .where('superseded_at', 'is', null)
  if (status !== undefined) {
    query = query.where('status', '=', status)
  }
  return query
}

export async function listActiveSubmissionsBySeason(
  db: Kysely<Database>,
  seasonId: string,
  status?: SubmissionStatus,
): Promise<Submission[]> {
  return await activeSubmissionsBySeason(db, seasonId, status)
    .selectAll()
    .orderBy('created_at', 'desc')
    .execute()
}

export async function countActiveSubmissionsBySeason(
  db: Kysely<Database>,
  seasonId: string,
  status?: SubmissionStatus,
): Promise<number> {
  const row = await activeSubmissionsBySeason(db, seasonId, status)
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirst()
  return Number(row?.count ?? 0)
}

export async function listSubmissionChecks(
  db: Kysely<Database>,
  submissionId: string,
): Promise<SubmissionCheck[]> {
  const rows = await db
    .selectFrom('submission_checks')
    .selectAll()
    .where('submission_id', '=', submissionId)
    .execute()
  return rows.sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage])
}

export async function listActiveReadySubmissionIds(db: Kysely<Database>): Promise<string[]> {
  const rows = await db
    .selectFrom('submissions')
    .select('id')
    .where('status', '=', 'ready')
    .where('superseded_at', 'is', null)
    .execute()
  return rows.map((row) => row.id)
}

export async function listRecordingsBySubmission(
  db: Kysely<Database>,
  submissionId: string,
  limit: number,
): Promise<string[]> {
  // The agent's recordings come from two sources, unioned newest-first: the watch/play sessions the
  // submission seated, and the automated competition games it played. The latter persist through
  // `season_run_games` (no session), so a session-only join would miss every run game — the empty
  // "Recent replays" an automated-only season produces. UNION (not UNION ALL) de-dupes a recording
  // that somehow appears in both.
  const sessionRecordings = db
    .selectFrom('session_submissions')
    .innerJoin('sessions', 'sessions.id', 'session_submissions.session_id')
    .innerJoin('recordings', 'recordings.id', 'sessions.recording_id')
    .select(['recordings.id as recording_id', 'recordings.created_at as created_at'])
    .where('session_submissions.submission_id', '=', submissionId)
  const competitionRecordings = db
    .selectFrom('game_results')
    .innerJoin('season_run_games', 'season_run_games.id', 'game_results.game_id')
    .innerJoin('recordings', 'recordings.id', 'season_run_games.recording_id')
    .select(['recordings.id as recording_id', 'recordings.created_at as created_at'])
    .where('game_results.agent_submission_id', '=', submissionId)
  const rows = await sessionRecordings
    .union(competitionRecordings)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute()
  return rows.map((row) => row.recording_id)
}
