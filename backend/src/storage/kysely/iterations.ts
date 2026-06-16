/**
 * Iteration queries: the seed/declare creates, the gated whole-config edit (with its forced
 * cascade), the submission/play/release window setters and their one-open invariants, and the
 * reads behind public/admin listings. Owns {@link requireIteration} (shared with ratings) and the
 * {@link countRows} conflict pre-check.
 */
import { randomUUID } from 'node:crypto'

import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import type {
  CreateIterationInput,
  SetPlayStatusResult,
  SetSubmissionStatusResult,
  UpdateIterationConfigResult,
} from '../index.js'
import {
  decodeIterationConfig,
  emptyIterationConfig,
  encodeIterationConfig,
  type IterationConfig,
} from '../iteration-config.js'
import type { Database, Iteration, ReleaseStatus, WindowStatus } from '../schema.js'
import { deleteRunsForIteration } from './runs.js'
import { isUniqueConstraintViolation } from './shared.js'
import { deleteSubmissionsForIteration } from './submissions.js'

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

/** One iteration by id or a clear error; the gate setters need its `env_id`/`config`/`released_at`. */
export async function requireIteration(db: Kysely<Database>, id: string): Promise<Iteration> {
  const iteration = await getIteration(db, id)
  if (iteration === undefined) {
    throw new Error(`no such iteration: ${id}`)
  }
  return iteration
}

export async function getOpenSubmissionIteration(
  db: Kysely<Database>,
  envId: string,
): Promise<Iteration | undefined> {
  return await db
    .selectFrom('iterations')
    .selectAll()
    .where('env_id', '=', envId)
    .where('submission_status', '=', 'open')
    .executeTakeFirst()
}

export async function getIteration(
  db: Kysely<Database>,
  id: string,
): Promise<Iteration | undefined> {
  return await db.selectFrom('iterations').selectAll().where('id', '=', id).executeTakeFirst()
}

export async function ensureOpenIteration(
  db: Kysely<Database>,
  envId: string,
  depsVersion: number,
): Promise<Iteration> {
  const existing = await getOpenSubmissionIteration(db, envId)
  if (existing !== undefined) {
    return existing
  }
  try {
    // The seed row: submission-`open` and play-`open` for local continuity, with a default config
    // carrying the pinned version and an empty match design.
    return await db
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
      ? await getOpenSubmissionIteration(db, envId)
      : undefined
    if (raced !== undefined) {
      return raced
    }
    throw error
  }
}

export async function getPublicPlayIteration(
  db: Kysely<Database>,
  envId: string,
): Promise<Iteration | undefined> {
  return await db
    .selectFrom('iterations')
    .selectAll()
    .where('env_id', '=', envId)
    .where('play_status', '=', 'open')
    .executeTakeFirst()
}

export async function createIteration(
  db: Kysely<Database>,
  input: CreateIterationInput,
): Promise<Iteration> {
  return await db
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

export async function updateIterationConfig(
  db: Kysely<Database>,
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
  return await db.transaction().execute(async (trx) => {
    const iteration = await trx
      .selectFrom('iterations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (iteration === undefined) {
      throw new Error(`no such iteration: ${id}`)
    }
    const depsChanged = decodeIterationConfig(iteration.config).deps_version !== config.deps_version

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

export async function setSubmissionStatus(
  db: Kysely<Database>,
  id: string,
  status: WindowStatus,
): Promise<SetSubmissionStatusResult> {
  const iteration = await requireIteration(db, id)
  if (status === 'open') {
    const other = await db
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
    const updated = await db
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

export async function setPlayStatus(
  db: Kysely<Database>,
  id: string,
  status: WindowStatus,
): Promise<SetPlayStatusResult> {
  const iteration = await requireIteration(db, id)
  if (status === 'open') {
    const other = await db
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
    const updated = await db
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

export async function setReleaseStatus(
  db: Kysely<Database>,
  id: string,
  status: ReleaseStatus,
): Promise<Iteration> {
  const iteration = await requireIteration(db, id)
  // Stamp `released_at` only on the first release; a re-release leaves it stable, and un-releasing
  // keeps the prior stamp as history.
  const releasedAt =
    status === 'released' && iteration.released_at === null
      ? new Date().toISOString()
      : iteration.released_at
  return await db
    .updateTable('iterations')
    .set({ release_status: status, released_at: releasedAt })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function listIterations(
  db: Kysely<Database>,
  envId: string,
  options?: { includeUnreleased?: boolean },
): Promise<Iteration[]> {
  let query = db.selectFrom('iterations').selectAll().where('env_id', '=', envId)
  if (!(options?.includeUnreleased ?? false)) {
    query = query.where('release_status', '=', 'released')
  }
  return await query.orderBy('created_at', 'desc').orderBy(sql`rowid`, 'desc').execute()
}

export async function getReleasedIteration(
  db: Kysely<Database>,
  envId: string,
): Promise<Iteration | undefined> {
  return await db
    .selectFrom('iterations')
    .selectAll()
    .where('env_id', '=', envId)
    .where('release_status', '=', 'released')
    .orderBy('released_at', 'desc')
    .orderBy(sql`rowid`, 'desc')
    .executeTakeFirst()
}

export async function setSessionIteration(
  db: Kysely<Database>,
  sessionId: string,
  iterationId: string,
): Promise<void> {
  await db
    .updateTable('sessions')
    .set({ iteration_id: iterationId })
    .where('id', '=', sessionId)
    .execute()
}

export async function setIterationRatingPrompt(
  db: Kysely<Database>,
  iterationId: string,
  prompt: string | null,
): Promise<void> {
  await db
    .updateTable('iterations')
    .set({ rating_prompt: prompt })
    .where('id', '=', iterationId)
    .execute()
}
