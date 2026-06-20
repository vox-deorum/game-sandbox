/**
 * Season queries: the seed/declare creates, the gated whole-config edit (with its forced
 * cascade), the submission/play/release window setters and their one-open invariants, and the
 * reads behind public/admin listings. Owns {@link requireSeason} (shared with ratings) and the
 * {@link countRows} conflict pre-check.
 */
import { randomUUID } from 'node:crypto'

import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import type {
  CreateSeasonInput,
  SetPlayStatusResult,
  SetSubmissionStatusResult,
  UpdateSeasonConfigResult,
} from '../index.js'
import type { Database, ReleaseStatus, Season, WindowStatus } from '../schema.js'
import {
  decodeSeasonConfig,
  emptySeasonConfig,
  encodeSeasonConfig,
  type SeasonConfig,
} from '../season-config.js'
import { deleteRunsForSeason } from './runs.js'
import { isUniqueConstraintViolation } from './shared.js'
import { deleteSubmissionsForSeason } from './submissions.js'

/** Count rows in `table` whose `column` equals `value`; the config-edit conflict pre-checks use it. */
async function countRows(
  db: Kysely<Database>,
  table: 'season_runs' | 'submissions',
  column: 'season_id',
  value: string,
): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where(column, '=', value)
    .executeTakeFirst()
  return Number(row?.count ?? 0)
}

/** One season by id or a clear error; the gate setters need its `env_id`/`config`/`released_at`. */
export async function requireSeason(db: Kysely<Database>, id: string): Promise<Season> {
  const season = await getSeason(db, id)
  if (season === undefined) {
    throw new Error(`no such season: ${id}`)
  }
  return season
}

export async function getOpenSubmissionSeason(
  db: Kysely<Database>,
  envId: string,
): Promise<Season | undefined> {
  return await db
    .selectFrom('seasons')
    .selectAll()
    .where('env_id', '=', envId)
    .where('submission_status', '=', 'open')
    .executeTakeFirst()
}

export async function getSeason(db: Kysely<Database>, id: string): Promise<Season | undefined> {
  return await db.selectFrom('seasons').selectAll().where('id', '=', id).executeTakeFirst()
}

export async function ensureOpenSeason(
  db: Kysely<Database>,
  envId: string,
  depsVersion: number,
  defaults?: { label?: string | null; release?: ReleaseStatus },
): Promise<Season> {
  const existing = await getOpenSubmissionSeason(db, envId)
  if (existing !== undefined) {
    return existing
  }
  const release = defaults?.release ?? 'unreleased'
  const now = new Date().toISOString()
  try {
    // The seed row: submission-`open` and play-`open` for local continuity, with a default config
    // carrying the pinned version and an empty match design. The default-season `defaults` let the
    // seed name and release it (the "Playground" default); a fresh row otherwise stays unlabeled and
    // unreleased.
    return await db
      .insertInto('seasons')
      .values({
        id: randomUUID(),
        env_id: envId,
        submission_status: 'open',
        play_status: 'open',
        release_status: release,
        label: defaults?.label ?? null,
        config: encodeSeasonConfig(emptySeasonConfig(depsVersion)),
        rating_prompt: null,
        created_at: now,
        released_at: release === 'released' ? now : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  } catch (error) {
    const raced = isUniqueConstraintViolation(error)
      ? await getOpenSubmissionSeason(db, envId)
      : undefined
    if (raced !== undefined) {
      return raced
    }
    throw error
  }
}

export async function getPublicPlaySeason(
  db: Kysely<Database>,
  envId: string,
): Promise<Season | undefined> {
  return await db
    .selectFrom('seasons')
    .selectAll()
    .where('env_id', '=', envId)
    .where('play_status', '=', 'open')
    .executeTakeFirst()
}

export async function createSeason(
  db: Kysely<Database>,
  input: CreateSeasonInput,
): Promise<Season> {
  return await db
    .insertInto('seasons')
    .values({
      id: randomUUID(),
      env_id: input.env_id,
      submission_status: 'closed',
      play_status: 'closed',
      release_status: 'unreleased',
      label: input.label ?? null,
      config: encodeSeasonConfig(emptySeasonConfig(input.deps_version)),
      rating_prompt: null,
      created_at: new Date().toISOString(),
      released_at: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function updateSeasonConfig(
  db: Kysely<Database>,
  id: string,
  config: SeasonConfig,
  options?: { force?: boolean },
): Promise<UpdateSeasonConfigResult> {
  const force = options?.force ?? false
  // Validate (and serialize) the new config before touching anything, so a malformed edit never
  // reaches — let alone deletes — the season's runs or submissions.
  const encoded = encodeSeasonConfig(config)

  // One transaction so the conflict pre-checks, the forced deletes, and the config write are all
  // atomic: a failure anywhere rolls back the deletes rather than leaving runs/submissions wiped but
  // the config unchanged.
  return await db.transaction().execute(async (trx) => {
    const season = await trx
      .selectFrom('seasons')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (season === undefined) {
      throw new Error(`no such season: ${id}`)
    }
    const depsChanged = decodeSeasonConfig(season.config).deps_version !== config.deps_version

    const runCount = await countRows(trx, 'season_runs', 'season_id', id)
    if (runCount > 0 && !force) {
      return { ok: false, conflict: 'season_has_runs' }
    }
    let submissionCount = 0
    if (depsChanged) {
      submissionCount = await countRows(trx, 'submissions', 'season_id', id)
      if (submissionCount > 0 && !force) {
        return { ok: false, conflict: 'season_has_submissions' }
      }
    }

    // Forced: clear the rows the edit would otherwise corrupt. Runs (and their games/results/
    // placements) go whenever any exist; submissions go only when the pinned version changed.
    if (force && runCount > 0) {
      await deleteRunsForSeason(trx, id)
    }
    if (force && depsChanged && submissionCount > 0) {
      await deleteSubmissionsForSeason(trx, id)
    }

    const updated = await trx
      .updateTable('seasons')
      .set({ config: encoded })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow()
    return { ok: true, season: updated }
  })
}

export async function setSubmissionStatus(
  db: Kysely<Database>,
  id: string,
  status: WindowStatus,
): Promise<SetSubmissionStatusResult> {
  const season = await requireSeason(db, id)
  if (status === 'open') {
    const other = await db
      .selectFrom('seasons')
      .select('id')
      .where('env_id', '=', season.env_id)
      .where('submission_status', '=', 'open')
      .where('id', '!=', id)
      .executeTakeFirst()
    if (other !== undefined) {
      return { ok: false, conflict: 'open_season_exists' }
    }
  }
  try {
    const updated = await db
      .updateTable('seasons')
      .set({ submission_status: status })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow()
    return { ok: true, season: updated }
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      return { ok: false, conflict: 'open_season_exists' }
    }
    throw error
  }
}

export async function setPlayStatus(
  db: Kysely<Database>,
  id: string,
  status: WindowStatus,
): Promise<SetPlayStatusResult> {
  const season = await requireSeason(db, id)
  if (status === 'open') {
    const other = await db
      .selectFrom('seasons')
      .select('id')
      .where('env_id', '=', season.env_id)
      .where('play_status', '=', 'open')
      .where('id', '!=', id)
      .executeTakeFirst()
    if (other !== undefined) {
      return { ok: false, conflict: 'open_play_season_exists' }
    }
  }
  try {
    const updated = await db
      .updateTable('seasons')
      .set({ play_status: status })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow()
    return { ok: true, season: updated }
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      return { ok: false, conflict: 'open_play_season_exists' }
    }
    throw error
  }
}

export async function setReleaseStatus(
  db: Kysely<Database>,
  id: string,
  status: ReleaseStatus,
): Promise<Season> {
  const season = await requireSeason(db, id)
  // Stamp `released_at` only on the first release; a re-release leaves it stable, and un-releasing
  // keeps the prior stamp as history.
  const releasedAt =
    status === 'released' && season.released_at === null
      ? new Date().toISOString()
      : season.released_at
  return await db
    .updateTable('seasons')
    .set({ release_status: status, released_at: releasedAt })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function listSeasons(
  db: Kysely<Database>,
  envId: string,
  options?: { includeUnreleased?: boolean },
): Promise<Season[]> {
  let query = db.selectFrom('seasons').selectAll().where('env_id', '=', envId)
  if (!(options?.includeUnreleased ?? false)) {
    query = query.where('release_status', '=', 'released')
  }
  return await query.orderBy('created_at', 'desc').orderBy(sql`rowid`, 'desc').execute()
}

export async function getReleasedSeason(
  db: Kysely<Database>,
  envId: string,
): Promise<Season | undefined> {
  return await db
    .selectFrom('seasons')
    .selectAll()
    .where('env_id', '=', envId)
    .where('release_status', '=', 'released')
    .orderBy('released_at', 'desc')
    .orderBy(sql`rowid`, 'desc')
    .executeTakeFirst()
}

export async function setSessionSeason(
  db: Kysely<Database>,
  sessionId: string,
  seasonId: string,
): Promise<void> {
  await db
    .updateTable('sessions')
    .set({ season_id: seasonId })
    .where('id', '=', sessionId)
    .execute()
}

export async function setSeasonRatingPrompt(
  db: Kysely<Database>,
  seasonId: string,
  prompt: string | null,
): Promise<void> {
  await db
    .updateTable('seasons')
    .set({ rating_prompt: prompt })
    .where('id', '=', seasonId)
    .execute()
}

export async function setSeasonLabel(
  db: Kysely<Database>,
  seasonId: string,
  label: string | null,
): Promise<void> {
  await db.updateTable('seasons').set({ label }).where('id', '=', seasonId).execute()
}
