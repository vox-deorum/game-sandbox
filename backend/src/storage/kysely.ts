/**
 * The one implementation of {@link Storage}, written against Kysely's dialect-agnostic query
 * API. Because the domain types are the row types, there is no row-mapping layer: queries
 * return {@link Session} directly.
 */
import { randomUUID } from 'node:crypto'

import type { Kysely } from 'kysely'

import type {
  NewRecordingInput,
  NewSessionInput,
  NewSubmissionInput,
  Storage,
  SubmissionCheckOutcome,
  SubmissionFailureStatus,
  SubmissionTerminalStatus,
} from './index.js'
import { SubmissionConflictError } from './index.js'
import type {
  Database,
  Iteration,
  Recording,
  Session,
  Submission,
  SubmissionCheck,
  SubmissionStage,
  SubmissionStatus,
  TerminationReason,
} from './schema.js'

const ACTIVE_STATUSES = ['starting', 'running'] as const

/** Pipeline-stage order for {@link KyselyStorage.listSubmissionChecks}; SQLite has no enum order. */
const STAGE_ORDER: Record<SubmissionStage, number> = {
  resolve: 0,
  static: 1,
  build: 2,
  load: 3,
}

/** Whether a thrown database error is a unique-constraint violation. */
function isUniqueConstraintViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('UNIQUE constraint failed') || message.includes('submissions_active_unique')
  )
}

export class KyselyStorage implements Storage {
  constructor(private readonly db: Kysely<Database>) {}

  async createSession(input: NewSessionInput): Promise<Session> {
    return await this.db
      .insertInto('sessions')
      .values({
        ...input,
        status: 'starting',
        termination_reason: null,
        ended_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async markRunning(id: string): Promise<void> {
    await this.db.updateTable('sessions').set({ status: 'running' }).where('id', '=', id).execute()
  }

  async markEnded(id: string, reason: TerminationReason, endedAt: string): Promise<void> {
    await this.db
      .updateTable('sessions')
      .set({ status: 'ended', termination_reason: reason, ended_at: endedAt })
      .where('id', '=', id)
      .execute()
  }

  async findActiveSessionByUser(userId: string): Promise<Session | undefined> {
    return await this.db
      .selectFrom('sessions')
      .selectAll()
      .where('user_id', '=', userId)
      .where('status', 'in', ACTIVE_STATUSES)
      .executeTakeFirst()
  }

  async getSession(id: string): Promise<Session | undefined> {
    return await this.db.selectFrom('sessions').selectAll().where('id', '=', id).executeTakeFirst()
  }

  async listSessions(): Promise<Session[]> {
    return await this.db.selectFrom('sessions').selectAll().orderBy('created_at', 'desc').execute()
  }

  async createRecording(input: NewRecordingInput): Promise<void> {
    // Idempotent: a re-finalize (or a backfilled id) leaves the existing row untouched.
    await this.db
      .insertInto('recordings')
      .values({ ...input, pinned: 0 })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
  }

  async listRecordings(): Promise<Recording[]> {
    return await this.db
      .selectFrom('recordings')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute()
  }

  async getRecording(id: string): Promise<Recording | undefined> {
    return await this.db
      .selectFrom('recordings')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
  }

  async setRecordingPinned(id: string, pinned: boolean): Promise<void> {
    await this.db
      .updateTable('recordings')
      .set({ pinned: pinned ? 1 : 0 })
      .where('id', '=', id)
      .execute()
  }

  async countPinnedByUser(userId: string): Promise<number> {
    const row = await this.db
      .selectFrom('recordings')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('user_id', '=', userId)
      .where('pinned', '=', 1)
      .executeTakeFirst()
    return Number(row?.count ?? 0)
  }

  async deleteRecording(id: string): Promise<void> {
    await this.db.deleteFrom('recordings').where('id', '=', id).execute()
  }

  async getOpenIteration(envId: string): Promise<Iteration | undefined> {
    return await this.db
      .selectFrom('iterations')
      .selectAll()
      .where('env_id', '=', envId)
      .where('status', '=', 'open')
      .executeTakeFirst()
  }

  async getIteration(id: string): Promise<Iteration | undefined> {
    return await this.db
      .selectFrom('iterations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
  }

  async ensureOpenIteration(envId: string, depsVersion: number): Promise<Iteration> {
    const existing = await this.getOpenIteration(envId)
    if (existing !== undefined) {
      return existing
    }
    try {
      return await this.db
        .insertInto('iterations')
        .values({
          id: randomUUID(),
          env_id: envId,
          deps_version: depsVersion,
          status: 'open',
          created_at: new Date().toISOString(),
        })
        .returningAll()
        .executeTakeFirstOrThrow()
    } catch (error) {
      const raced = isUniqueConstraintViolation(error)
        ? await this.getOpenIteration(envId)
        : undefined
      if (raced !== undefined) {
        return raced
      }
      throw error
    }
  }

  async createSubmission(input: NewSubmissionInput): Promise<Submission> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        // Supersede the prior active submission first, then insert the new pending row; the partial
        // unique index is the backstop if a concurrent resubmit interleaves.
        await trx
          .updateTable('submissions')
          .set({ superseded_at: input.created_at })
          .where('iteration_id', '=', input.iteration_id)
          .where('user_id', '=', input.user_id)
          .where('superseded_at', 'is', null)
          .execute()
        return await trx
          .insertInto('submissions')
          .values({
            id: randomUUID(),
            iteration_id: input.iteration_id,
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

  async updateSubmissionPin(id: string, commitSha: string): Promise<void> {
    await this.db
      .updateTable('submissions')
      .set({ commit_sha: commitSha })
      .where('id', '=', id)
      .where('source_kind', '=', 'git')
      .execute()
  }

  async updateSubmissionStatus(id: string, status: 'ready'): Promise<void>
  async updateSubmissionStatus(
    id: string,
    status: SubmissionFailureStatus,
    reason: string,
  ): Promise<void>
  async updateSubmissionStatus(
    id: string,
    status: SubmissionTerminalStatus,
    reason?: string,
  ): Promise<void> {
    if (status !== 'ready' && reason === undefined) {
      throw new Error('failed submissions require an owner-visible reason')
    }
    const nextReason = status === 'ready' ? null : reason
    // A success status clears any prior reason; a failure records the owner-visible message.
    await this.db
      .updateTable('submissions')
      .set({ status, reason: nextReason })
      .where('id', '=', id)
      .execute()
  }

  async startSubmissionCheck(submissionId: string, stage: SubmissionStage): Promise<void> {
    const now = new Date().toISOString()
    await this.db
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

  async finishSubmissionCheck(
    submissionId: string,
    stage: SubmissionStage,
    status: SubmissionCheckOutcome,
    detail?: string,
  ): Promise<void> {
    await this.db
      .updateTable('submission_checks')
      .set({ status, detail: detail ?? null, ended_at: new Date().toISOString() })
      .where('submission_id', '=', submissionId)
      .where('stage', '=', stage)
      .execute()
  }

  async recordSessionSubmission(
    sessionId: string,
    submissionId: string,
    slotId: string,
  ): Promise<void> {
    await this.db
      .insertInto('session_submissions')
      .values({
        session_id: sessionId,
        submission_id: submissionId,
        slot_id: slotId,
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) => oc.columns(['session_id', 'slot_id']).doNothing())
      .execute()
  }

  async getSubmission(id: string): Promise<Submission | undefined> {
    return await this.db
      .selectFrom('submissions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
  }

  async findActiveSubmission(iterationId: string, userId: string): Promise<Submission | undefined> {
    return await this.db
      .selectFrom('submissions')
      .selectAll()
      .where('iteration_id', '=', iterationId)
      .where('user_id', '=', userId)
      .where('superseded_at', 'is', null)
      .executeTakeFirst()
  }

  async listPendingSubmissions(): Promise<Submission[]> {
    return await this.db
      .selectFrom('submissions')
      .selectAll()
      .where('status', '=', 'pending')
      .where('superseded_at', 'is', null)
      .orderBy('created_at', 'desc')
      .execute()
  }

  async listSubmissionsByUser(userId: string, envId?: string): Promise<Submission[]> {
    let query = this.db.selectFrom('submissions').selectAll().where('user_id', '=', userId)
    if (envId !== undefined) {
      query = query.where('env_id', '=', envId)
    }
    return await query.orderBy('created_at', 'desc').execute()
  }

  async listActiveSubmissionsByIteration(
    iterationId: string,
    status?: SubmissionStatus,
  ): Promise<Submission[]> {
    let query = this.db
      .selectFrom('submissions')
      .selectAll()
      .where('iteration_id', '=', iterationId)
      .where('superseded_at', 'is', null)
    if (status !== undefined) {
      query = query.where('status', '=', status)
    }
    return await query.orderBy('created_at', 'desc').execute()
  }

  async listSubmissionChecks(submissionId: string): Promise<SubmissionCheck[]> {
    const rows = await this.db
      .selectFrom('submission_checks')
      .selectAll()
      .where('submission_id', '=', submissionId)
      .execute()
    return rows.sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage])
  }

  async listActiveReadySubmissionIds(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('submissions')
      .select('id')
      .where('status', '=', 'ready')
      .where('superseded_at', 'is', null)
      .execute()
    return rows.map((row) => row.id)
  }

  async listRecordingsBySubmission(submissionId: string, limit: number): Promise<string[]> {
    const rows = await this.db
      .selectFrom('session_submissions')
      .innerJoin('sessions', 'sessions.id', 'session_submissions.session_id')
      .select('sessions.recording_id as recording_id')
      .where('session_submissions.submission_id', '=', submissionId)
      .where('sessions.recording_id', 'is not', null)
      .orderBy('sessions.created_at', 'desc')
      .limit(limit)
      .execute()
    return rows.map((row) => row.recording_id).filter((id): id is string => id !== null)
  }

  async close(): Promise<void> {
    await this.db.destroy()
  }
}
