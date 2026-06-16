/**
 * The one implementation of {@link Storage}, written against Kysely's dialect-agnostic query
 * API. Because the domain types are the row types, there is no row-mapping layer: queries
 * return {@link Session} directly.
 */
import { randomUUID } from 'node:crypto'

import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import type {
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
  SubmissionTerminalStatus,
  UpdateIterationConfigResult,
  UpsertRatingInput,
  UpsertRatingResult,
} from './index.js'
import { SubmissionConflictError } from './index.js'
import {
  decodeIterationConfig,
  emptyIterationConfig,
  encodeIterationConfig,
  type IterationConfig,
} from './iteration-config.js'
import type {
  AgentKind,
  AgentRatingPrompt,
  AgentRef,
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
} from './schema.js'

/** The concrete agent-identity columns derived from an {@link AgentRef}. */
interface AgentColumns {
  agent_kind: AgentKind
  agent_submission_id: string | null
  agent_user_id: string | null
}

/** Flatten an {@link AgentRef} to its three stored columns; null ids for the Naive baseline. */
function agentColumns(agent: AgentRef): AgentColumns {
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
function agentRefFromColumns(row: AgentColumns): AgentRef {
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
function agentKey(row: AgentColumns): string {
  return `${row.agent_kind}:${row.agent_submission_id ?? ''}`
}

/** The same stable key from an {@link AgentRef}, for deterministic ordering of board rows. */
function agentRefKey(agent: AgentRef): string {
  return agent.kind === 'submission' ? `submission:${agent.submission_id}` : 'builtin-naive:'
}

/** Run-status values that close a run (stamping `ended_at`). */
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled'])

/** Game-status values that close a game (stamping `ended_at`). */
const TERMINAL_GAME_STATUSES: ReadonlySet<GameStatus> = new Set([
  'completed',
  'failed',
  'timed_out',
  'cancelled',
])

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

/**
 * Delete an iteration's runs and everything that hangs off them (scheduled games, per-seat results,
 * placements). Takes an executor so it composes inside a larger transaction (the forced config edit)
 * as well as on its own; `Transaction<Database>` is assignable to `Kysely<Database>`.
 */
async function deleteRunsForIteration(db: Kysely<Database>, iterationId: string): Promise<void> {
  const runs = await db
    .selectFrom('iteration_runs')
    .select('id')
    .where('iteration_id', '=', iterationId)
    .execute()
  const runIds = runs.map((row) => row.id)
  if (runIds.length > 0) {
    const games = await db
      .selectFrom('iteration_run_games')
      .select('id')
      .where('run_id', 'in', runIds)
      .execute()
    const gameIds = games.map((row) => row.id)
    if (gameIds.length > 0) {
      await db.deleteFrom('game_results').where('game_id', 'in', gameIds).execute()
    }
    await db.deleteFrom('iteration_run_games').where('run_id', 'in', runIds).execute()
    await db.deleteFrom('iteration_runs').where('id', 'in', runIds).execute()
  }
  await db.deleteFrom('automated_placements').where('iteration_id', '=', iterationId).execute()
}

/** Count rows in `table` whose `column` equals `value`; the config-edit conflict pre-checks use it. */
async function countRows(
  db: Kysely<Database>,
  table: 'iteration_runs' | 'submissions',
  column: 'iteration_id',
  value: string,
): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where(column, '=', value)
    .executeTakeFirst()
  return Number(row?.count ?? 0)
}

/** Delete an iteration's submissions and their checks; same executor-passing rationale as above. */
async function deleteSubmissionsForIteration(
  db: Kysely<Database>,
  iterationId: string,
): Promise<void> {
  const submissions = await db
    .selectFrom('submissions')
    .select('id')
    .where('iteration_id', '=', iterationId)
    .execute()
  const submissionIds = submissions.map((row) => row.id)
  if (submissionIds.length > 0) {
    await db.deleteFrom('submission_checks').where('submission_id', 'in', submissionIds).execute()
  }
  await db.deleteFrom('submissions').where('iteration_id', '=', iterationId).execute()
}

export class KyselyStorage implements Storage {
  constructor(private readonly db: Kysely<Database>) {}

  async createSession(input: NewSessionInput): Promise<Session> {
    return await this.db
      .insertInto('sessions')
      .values({
        ...input,
        iteration_id: input.iteration_id ?? null,
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

  async getOpenSubmissionIteration(envId: string): Promise<Iteration | undefined> {
    return await this.db
      .selectFrom('iterations')
      .selectAll()
      .where('env_id', '=', envId)
      .where('submission_status', '=', 'open')
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
    const existing = await this.getOpenSubmissionIteration(envId)
    if (existing !== undefined) {
      return existing
    }
    try {
      // The seed row: submission-`open` and play-`open` for local continuity, with a default config
      // carrying the pinned version and an empty match design.
      return await this.db
        .insertInto('iterations')
        .values({
          id: randomUUID(),
          env_id: envId,
          submission_status: 'open',
          play_status: 'open',
          release_status: 'unreleased',
          label: null,
          config: encodeIterationConfig(emptyIterationConfig(depsVersion)),
          rating_prompt: null,
          created_at: new Date().toISOString(),
          released_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
    } catch (error) {
      const raced = isUniqueConstraintViolation(error)
        ? await this.getOpenSubmissionIteration(envId)
        : undefined
      if (raced !== undefined) {
        return raced
      }
      throw error
    }
  }

  async getPublicPlayIteration(envId: string): Promise<Iteration | undefined> {
    return await this.db
      .selectFrom('iterations')
      .selectAll()
      .where('env_id', '=', envId)
      .where('play_status', '=', 'open')
      .executeTakeFirst()
  }

  async createIteration(input: CreateIterationInput): Promise<Iteration> {
    return await this.db
      .insertInto('iterations')
      .values({
        id: randomUUID(),
        env_id: input.env_id,
        submission_status: 'closed',
        play_status: 'closed',
        release_status: 'unreleased',
        label: input.label ?? null,
        config: encodeIterationConfig(emptyIterationConfig(input.deps_version)),
        rating_prompt: null,
        created_at: new Date().toISOString(),
        released_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async updateIterationConfig(
    id: string,
    config: IterationConfig,
    options?: { force?: boolean },
  ): Promise<UpdateIterationConfigResult> {
    const force = options?.force ?? false
    // Validate (and serialize) the new config before touching anything, so a malformed edit never
    // reaches — let alone deletes — the iteration's runs or submissions.
    const encoded = encodeIterationConfig(config)

    // One transaction so the conflict pre-checks, the forced deletes, and the config write are all
    // atomic: a failure anywhere rolls back the deletes rather than leaving runs/submissions wiped but
    // the config unchanged.
    return await this.db.transaction().execute(async (trx) => {
      const iteration = await trx
        .selectFrom('iterations')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
      if (iteration === undefined) {
        throw new Error(`no such iteration: ${id}`)
      }
      const depsChanged =
        decodeIterationConfig(iteration.config).deps_version !== config.deps_version

      const runCount = await countRows(trx, 'iteration_runs', 'iteration_id', id)
      if (runCount > 0 && !force) {
        return { ok: false, conflict: 'iteration_has_runs' }
      }
      let submissionCount = 0
      if (depsChanged) {
        submissionCount = await countRows(trx, 'submissions', 'iteration_id', id)
        if (submissionCount > 0 && !force) {
          return { ok: false, conflict: 'iteration_has_submissions' }
        }
      }

      // Forced: clear the rows the edit would otherwise corrupt. Runs (and their games/results/
      // placements) go whenever any exist; submissions go only when the pinned version changed.
      if (force && runCount > 0) {
        await deleteRunsForIteration(trx, id)
      }
      if (force && depsChanged && submissionCount > 0) {
        await deleteSubmissionsForIteration(trx, id)
      }

      const updated = await trx
        .updateTable('iterations')
        .set({ config: encoded })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
      return { ok: true, iteration: updated }
    })
  }

  async setSubmissionStatus(id: string, status: WindowStatus): Promise<SetSubmissionStatusResult> {
    const iteration = await this.requireIteration(id)
    if (status === 'open') {
      const other = await this.db
        .selectFrom('iterations')
        .select('id')
        .where('env_id', '=', iteration.env_id)
        .where('submission_status', '=', 'open')
        .where('id', '!=', id)
        .executeTakeFirst()
      if (other !== undefined) {
        return { ok: false, conflict: 'open_iteration_exists' }
      }
    }
    try {
      const updated = await this.db
        .updateTable('iterations')
        .set({ submission_status: status })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
      return { ok: true, iteration: updated }
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        return { ok: false, conflict: 'open_iteration_exists' }
      }
      throw error
    }
  }

  async setPlayStatus(id: string, status: WindowStatus): Promise<SetPlayStatusResult> {
    const iteration = await this.requireIteration(id)
    if (status === 'open') {
      const other = await this.db
        .selectFrom('iterations')
        .select('id')
        .where('env_id', '=', iteration.env_id)
        .where('play_status', '=', 'open')
        .where('id', '!=', id)
        .executeTakeFirst()
      if (other !== undefined) {
        return { ok: false, conflict: 'open_play_iteration_exists' }
      }
    }
    try {
      const updated = await this.db
        .updateTable('iterations')
        .set({ play_status: status })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()
      return { ok: true, iteration: updated }
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        return { ok: false, conflict: 'open_play_iteration_exists' }
      }
      throw error
    }
  }

  async setReleaseStatus(id: string, status: ReleaseStatus): Promise<Iteration> {
    const iteration = await this.requireIteration(id)
    // Stamp `released_at` only on the first release; a re-release leaves it stable, and un-releasing
    // keeps the prior stamp as history.
    const releasedAt =
      status === 'released' && iteration.released_at === null
        ? new Date().toISOString()
        : iteration.released_at
    return await this.db
      .updateTable('iterations')
      .set({ release_status: status, released_at: releasedAt })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async listIterations(
    envId: string,
    options?: { includeUnreleased?: boolean },
  ): Promise<Iteration[]> {
    let query = this.db.selectFrom('iterations').selectAll().where('env_id', '=', envId)
    if (!(options?.includeUnreleased ?? false)) {
      query = query.where('release_status', '=', 'released')
    }
    return await query.orderBy('created_at', 'desc').orderBy(sql`rowid`, 'desc').execute()
  }

  async getReleasedIteration(envId: string): Promise<Iteration | undefined> {
    return await this.db
      .selectFrom('iterations')
      .selectAll()
      .where('env_id', '=', envId)
      .where('release_status', '=', 'released')
      .orderBy('released_at', 'desc')
      .orderBy(sql`rowid`, 'desc')
      .executeTakeFirst()
  }

  async setSessionIteration(sessionId: string, iterationId: string): Promise<void> {
    await this.db
      .updateTable('sessions')
      .set({ iteration_id: iterationId })
      .where('id', '=', sessionId)
      .execute()
  }

  async setIterationRatingPrompt(iterationId: string, prompt: string | null): Promise<void> {
    await this.db
      .updateTable('iterations')
      .set({ rating_prompt: prompt })
      .where('id', '=', iterationId)
      .execute()
  }

  /** One iteration by id or a clear error; the gate setters need its `env_id`/`config`/`released_at`. */
  private async requireIteration(id: string): Promise<Iteration> {
    const iteration = await this.getIteration(id)
    if (iteration === undefined) {
      throw new Error(`no such iteration: ${id}`)
    }
    return iteration
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
      .innerJoin('recordings', 'recordings.id', 'sessions.recording_id')
      .select('recordings.id as recording_id')
      .where('session_submissions.submission_id', '=', submissionId)
      .orderBy('recordings.created_at', 'desc')
      .limit(limit)
      .execute()
    return rows.map((row) => row.recording_id)
  }

  async createRunWithSchedule(
    iterationId: string,
    requestedBy: string,
    submissionSnapshot: AgentRef[],
    scheduledGames: ScheduledGameInput[],
  ): Promise<IterationRun> {
    return await this.db.transaction().execute(async (trx) => {
      // Freeze the iteration's already-validated config (incl. deps) and the eligible roster onto the
      // run, then persist the concrete games. The runner reads these, not the mutable source rows.
      const iteration = await trx
        .selectFrom('iterations')
        .select('config')
        .where('id', '=', iterationId)
        .executeTakeFirstOrThrow()
      const runId = randomUUID()
      const now = new Date().toISOString()
      const run = await trx
        .insertInto('iteration_runs')
        .values({
          id: runId,
          iteration_id: iterationId,
          requested_by: requestedBy,
          config_snapshot: iteration.config,
          submission_snapshot: JSON.stringify(submissionSnapshot),
          status: 'pending',
          started_at: now,
          ended_at: null,
          error: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      for (const game of scheduledGames) {
        await trx
          .insertInto('iteration_run_games')
          .values({
            id: randomUUID(),
            run_id: runId,
            match_index: game.match_index,
            game_index: game.game_index,
            seed: game.seed,
            slots: JSON.stringify(game.slots),
            status: 'pending',
            recording_id: null,
            started_at: null,
            ended_at: null,
            error: null,
          })
          .execute()
      }
      return run
    })
  }

  async deleteRunsForIteration(iterationId: string): Promise<void> {
    await this.db.transaction().execute((trx) => deleteRunsForIteration(trx, iterationId))
  }

  async deleteSubmissionsForIteration(iterationId: string): Promise<void> {
    await this.db.transaction().execute((trx) => deleteSubmissionsForIteration(trx, iterationId))
  }

  async setRunStatus(id: string, status: RunStatus, error?: string): Promise<void> {
    await this.db
      .updateTable('iteration_runs')
      .set({
        status,
        error: error ?? null,
        ended_at: TERMINAL_RUN_STATUSES.has(status) ? new Date().toISOString() : null,
      })
      .where('id', '=', id)
      .execute()
  }

  async getLatestRun(iterationId: string): Promise<IterationRun | undefined> {
    return await this.db
      .selectFrom('iteration_runs')
      .selectAll()
      .where('iteration_id', '=', iterationId)
      .orderBy('started_at', 'desc')
      .orderBy(sql`rowid`, 'desc')
      .executeTakeFirst()
  }

  async getLatestCompletedRun(iterationId: string): Promise<IterationRun | undefined> {
    // `rowid` (insertion order) breaks ties when two runs share a millisecond timestamp, so the
    // "latest completed" is deterministic and a failed re-run never blanks a good board.
    return await this.db
      .selectFrom('iteration_runs')
      .selectAll()
      .where('iteration_id', '=', iterationId)
      .where('status', '=', 'completed')
      .orderBy('started_at', 'desc')
      .orderBy(sql`rowid`, 'desc')
      .executeTakeFirst()
  }

  async listRunGames(runId: string): Promise<IterationRunGame[]> {
    return await this.db
      .selectFrom('iteration_run_games')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('game_index', 'asc')
      .execute()
  }

  async setRunGameStatus(id: string, status: GameStatus, error?: string): Promise<void> {
    const now = new Date().toISOString()
    await this.db
      .updateTable('iteration_run_games')
      .set({
        status,
        error: error ?? null,
        ...(status === 'running' ? { started_at: now } : {}),
        ...(TERMINAL_GAME_STATUSES.has(status) ? { ended_at: now } : {}),
      })
      .where('id', '=', id)
      .execute()
  }

  async attachRunGameRecording(gameId: string, recordingId: string): Promise<void> {
    await this.db
      .updateTable('iteration_run_games')
      .set({ recording_id: recordingId })
      .where('id', '=', gameId)
      .execute()
  }

  async recordGameResult(input: RecordGameResultInput): Promise<GameResult> {
    return await this.db
      .insertInto('game_results')
      .values({
        id: randomUUID(),
        game_id: input.game_id,
        slot_index: input.slot_index,
        ...agentColumns(input.agent),
        episode_score: input.episode_score,
        agent_compute_ms_total: input.agent_compute_ms_total,
        acted_tick_count: input.acted_tick_count,
        failed: input.failed ? 1 : 0,
        failure_reason: input.failure_reason ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async listGameResultsByRun(runId: string): Promise<GameResult[]> {
    return await this.db
      .selectFrom('game_results')
      .innerJoin('iteration_run_games', 'iteration_run_games.id', 'game_results.game_id')
      .where('iteration_run_games.run_id', '=', runId)
      .selectAll('game_results')
      .execute()
  }

  async replaceAutomatedPlacements(
    iterationId: string,
    envId: string,
    runId: string,
    rows: PlacementInput[],
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('automated_placements').where('iteration_id', '=', iterationId).execute()
      const now = new Date().toISOString()
      for (const row of rows) {
        await trx
          .insertInto('automated_placements')
          .values({
            id: randomUUID(),
            iteration_id: iterationId,
            env_id: envId,
            run_id: runId,
            rank: row.rank,
            ...agentColumns(row.agent),
            mean_score: row.mean_score,
            mean_agent_compute_ms: row.mean_agent_compute_ms,
            failure_count: row.failure_count,
            recording_id: row.recording_id,
            created_at: now,
          })
          .execute()
      }
    })
  }

  async listPlacementsByAgent(agent: AgentRef, envId?: string): Promise<AutomatedPlacement[]> {
    const cols = agentColumns(agent)
    let query = this.db
      .selectFrom('automated_placements')
      .selectAll()
      .where('agent_kind', '=', cols.agent_kind)
    query =
      cols.agent_submission_id === null
        ? query.where('agent_submission_id', 'is', null)
        : query.where('agent_submission_id', '=', cols.agent_submission_id)
    if (envId !== undefined) {
      query = query.where('env_id', '=', envId)
    }
    return await query.orderBy('created_at', 'desc').execute()
  }

  async getAutomatedBoard(iterationId: string): Promise<AutomatedBoardRow[]> {
    const run = await this.getLatestCompletedRun(iterationId)
    if (run === undefined) {
      return []
    }
    // Aggregate the run's per-seat results per agent. Joining the game gives the per-row replay link;
    // the representative recording is the agent's best game (ties broken by lower game_index).
    const rows = await this.db
      .selectFrom('game_results')
      .innerJoin('iteration_run_games', 'iteration_run_games.id', 'game_results.game_id')
      .where('iteration_run_games.run_id', '=', run.id)
      .select([
        'game_results.agent_kind as agent_kind',
        'game_results.agent_submission_id as agent_submission_id',
        'game_results.agent_user_id as agent_user_id',
        'game_results.episode_score as episode_score',
        'game_results.agent_compute_ms_total as agent_compute_ms_total',
        'game_results.acted_tick_count as acted_tick_count',
        'game_results.failed as failed',
        'iteration_run_games.recording_id as recording_id',
        'iteration_run_games.game_index as game_index',
      ])
      .execute()

    interface Acc {
      agent: AgentColumns
      scoreSum: number
      computeSum: number
      tickSum: number
      failureCount: number
      games: number
      bestScore: number
      bestGameIndex: number
      bestRecording: string | null
    }
    const groups = new Map<string, Acc>()
    for (const row of rows) {
      const key = agentKey(row)
      let acc = groups.get(key)
      if (acc === undefined) {
        acc = {
          agent: row,
          scoreSum: 0,
          computeSum: 0,
          tickSum: 0,
          failureCount: 0,
          games: 0,
          bestScore: Number.NEGATIVE_INFINITY,
          bestGameIndex: Number.POSITIVE_INFINITY,
          bestRecording: null,
        }
        groups.set(key, acc)
      }
      acc.scoreSum += row.episode_score
      acc.computeSum += row.agent_compute_ms_total
      acc.tickSum += row.acted_tick_count
      acc.failureCount += row.failed === 1 ? 1 : 0
      acc.games += 1
      const better =
        row.episode_score > acc.bestScore ||
        (row.episode_score === acc.bestScore && row.game_index < acc.bestGameIndex)
      if (better) {
        acc.bestScore = row.episode_score
        acc.bestGameIndex = row.game_index
        acc.bestRecording = row.recording_id
      }
    }

    return (
      [...groups.values()]
        .map((acc) => ({
          agent: agentRefFromColumns(acc.agent),
          mean_score: acc.games > 0 ? acc.scoreSum / acc.games : 0,
          mean_agent_compute_ms: acc.tickSum > 0 ? acc.computeSum / acc.tickSum : null,
          failure_count: acc.failureCount,
          games: acc.games,
          recording_id: acc.bestRecording,
        }))
        // Descending by mean score, with the stable agent key breaking ties so the board order is
        // deterministic rather than dependent on Map-insertion order.
        .sort(
          (a, b) =>
            b.mean_score - a.mean_score || agentRefKey(a.agent).localeCompare(agentRefKey(b.agent)),
        )
    )
  }

  async upsertRating(input: UpsertRatingInput): Promise<UpsertRatingResult> {
    if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
      return { ok: false, reason: 'invalid_score' }
    }
    // A participant cannot rate their own submitted agent; the ownerless Naive baseline is rateable.
    if (input.agent.kind === 'submission' && input.agent.user_id === input.rater_user_id) {
      return { ok: false, reason: 'own_agent' }
    }
    const existing = await this.getRating(input.iteration_id, input.rater_user_id, input.agent)
    const now = new Date().toISOString()
    if (existing !== undefined) {
      const updated = await this.db
        .updateTable('ratings')
        .set({ score: input.score, updated_at: now })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow()
      return { ok: true, rating: updated }
    }
    const inserted = await this.db
      .insertInto('ratings')
      .values({
        id: randomUUID(),
        iteration_id: input.iteration_id,
        env_id: input.env_id,
        rater_user_id: input.rater_user_id,
        ...agentColumns(input.agent),
        score: input.score,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return { ok: true, rating: inserted }
  }

  async getRating(
    iterationId: string,
    raterUserId: string,
    agent: AgentRef,
  ): Promise<Rating | undefined> {
    const cols = agentColumns(agent)
    let query = this.db
      .selectFrom('ratings')
      .selectAll()
      .where('iteration_id', '=', iterationId)
      .where('rater_user_id', '=', raterUserId)
      .where('agent_kind', '=', cols.agent_kind)
    query =
      cols.agent_submission_id === null
        ? query.where('agent_submission_id', 'is', null)
        : query.where('agent_submission_id', '=', cols.agent_submission_id)
    return await query.executeTakeFirst()
  }

  async listRatingsByIteration(iterationId: string): Promise<Rating[]> {
    return await this.db
      .selectFrom('ratings')
      .selectAll()
      .where('iteration_id', '=', iterationId)
      .execute()
  }

  async aggregateRatingsByAgent(iterationId: string): Promise<RatingAggregate[]> {
    const ratings = await this.listRatingsByIteration(iterationId)
    const groups = new Map<string, { agent: AgentColumns; sum: number; count: number }>()
    for (const rating of ratings) {
      const key = agentKey(rating)
      const acc = groups.get(key) ?? { agent: rating, sum: 0, count: 0 }
      acc.sum += rating.score
      acc.count += 1
      groups.set(key, acc)
    }
    return [...groups.values()].map((acc) => ({
      agent: agentRefFromColumns(acc.agent),
      mean: acc.count > 0 ? acc.sum / acc.count : 0,
      count: acc.count,
    }))
  }

  async upsertAgentRatingPrompt(
    iterationId: string,
    userId: string,
    prompt: string,
  ): Promise<void> {
    const iteration = await this.requireIteration(iterationId)
    const now = new Date().toISOString()
    await this.db
      .insertInto('agent_rating_prompts')
      .values({
        iteration_id: iterationId,
        env_id: iteration.env_id,
        user_id: userId,
        prompt,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['iteration_id', 'user_id']).doUpdateSet({ prompt, updated_at: now }),
      )
      .execute()
  }

  async getAgentRatingPrompt(
    iterationId: string,
    userId: string,
  ): Promise<AgentRatingPrompt | undefined> {
    return await this.db
      .selectFrom('agent_rating_prompts')
      .selectAll()
      .where('iteration_id', '=', iterationId)
      .where('user_id', '=', userId)
      .executeTakeFirst()
  }

  async listAgentRatingPromptsByIteration(iterationId: string): Promise<AgentRatingPrompt[]> {
    return await this.db
      .selectFrom('agent_rating_prompts')
      .selectAll()
      .where('iteration_id', '=', iterationId)
      .execute()
  }

  async listProtectedLeaderboardRecordingIds(): Promise<string[]> {
    // The exempt set is the recordings of each iteration's latest completed run. Superseded runs'
    // recordings fall outside it (the live retention sweep may reclaim them). Every iteration is
    // viewable (released, or unreleased-but-operator-worked), so none are excluded here by status.
    const iterations = await this.db.selectFrom('iterations').select('id').execute()
    const protectedIds = new Set<string>()
    for (const iteration of iterations) {
      const run = await this.getLatestCompletedRun(iteration.id)
      if (run === undefined) {
        continue
      }
      const games = await this.db
        .selectFrom('iteration_run_games')
        .select('recording_id')
        .where('run_id', '=', run.id)
        .where('recording_id', 'is not', null)
        .execute()
      for (const game of games) {
        if (game.recording_id !== null) {
          protectedIds.add(game.recording_id)
        }
      }
    }
    return [...protectedIds]
  }

  async close(): Promise<void> {
    await this.db.destroy()
  }
}
