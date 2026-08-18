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
  DeleteSeasonResult,
  SetPlayStatusResult,
  SetSubmissionStatusResult,
  UpdateSeasonConfigResult,
} from '../index.js'
import type {
  Database,
  PublicSeason,
  ReleaseStatus,
  Season,
  SeasonScope,
  WindowStatus,
} from '../schema.js'
import {
  decodeSeasonConfig,
  emptySeasonConfig,
  encodeSeasonConfig,
  type SeasonConfig,
} from '../season-config.js'
import { deleteRunsForSeason, orderByNewestRun } from './runs.js'
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
        description_markdown: null,
        template_repo_url: null,
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
      description_markdown: input.description_markdown ?? null,
      template_repo_url: null,
      config: encodeSeasonConfig({
        ...emptySeasonConfig(input.deps_version),
        ...(input.overrides !== undefined ? { overrides: input.overrides } : {}),
      }),
      rating_prompt: null,
      created_at: new Date().toISOString(),
      released_at: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

/**
 * Remove an unused private season. This deliberately never cascades or cancels work: a season with
 * any durable activity is historical data and must stay intact. The activity checks and final row
 * removal share a transaction so a partial delete cannot escape on an error.
 */
export async function deleteSeason(db: Kysely<Database>, id: string): Promise<DeleteSeasonResult> {
  return await db.transaction().execute(async (trx) => {
    const season = await trx
      .selectFrom('seasons')
      .select(['submission_status', 'play_status', 'release_status', 'rating_prompt'])
      .where('id', '=', id)
      .executeTakeFirst()
    if (season === undefined) {
      return { ok: false, reason: 'not_found' }
    }
    if (
      season.submission_status !== 'closed' ||
      season.play_status !== 'closed' ||
      season.release_status !== 'unreleased'
    ) {
      return { ok: false, reason: 'season_not_deletable' }
    }

    const activity = await Promise.all([
      trx.selectFrom('season_runs').select('id').where('season_id', '=', id).executeTakeFirst(),
      trx.selectFrom('submissions').select('id').where('season_id', '=', id).executeTakeFirst(),
      trx.selectFrom('sessions').select('id').where('season_id', '=', id).executeTakeFirst(),
      trx.selectFrom('ratings').select('id').where('season_id', '=', id).executeTakeFirst(),
      trx
        .selectFrom('agent_rating_prompts')
        .select('user_id')
        .where('season_id', '=', id)
        .executeTakeFirst(),
      trx
        .selectFrom('llm_development_keys')
        .select('key_id')
        .where('season_id', '=', id)
        .executeTakeFirst(),
    ])
    if (activity.some((row) => row !== undefined)) {
      return { ok: false, reason: 'season_not_empty' }
    }
    if (season.rating_prompt !== null) {
      return { ok: false, reason: 'season_not_empty' }
    }

    const deleted = await trx
      .deleteFrom('seasons')
      .where('id', '=', id)
      .where('submission_status', '=', 'closed')
      .where('play_status', '=', 'closed')
      .where('release_status', '=', 'unreleased')
      .returning('id')
      .executeTakeFirst()
    return deleted === undefined ? { ok: false, reason: 'season_not_deletable' } : { ok: true }
  })
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

export async function listSeasons(
  db: Kysely<Database>,
  options?: { envId?: string; scope?: SeasonScope },
): Promise<PublicSeason[]> {
  // Seasons newest first, optionally narrowed to a single environment, with the public activity
  // counts always computed in this one listing query: active submissions exclude superseded attempts,
  // and `game_count` is the season's latest completed run's games (see below). The `scope` controls
  // which seasons are visible — `'all'` reaches fully-private unreleased seasons and is gated to
  // operators at the route boundary.
  const scope = options?.scope ?? 'released'
  let query = db
    .selectFrom('seasons')
    .selectAll()
    .select((eb) => [
      eb
        .selectFrom('submissions')
        .select((submissions) => submissions.fn.countAll<number>().as('count'))
        .whereRef('submissions.season_id', '=', 'seasons.id')
        .where('submissions.superseded_at', 'is', null)
        .as('submission_count'),
      // The automated games behind the released Scoreboard: the count of `season_run_games` for the
      // season's latest completed run (the same run the board aggregates). Automated runs never create
      // `sessions`, so this is the activity the public "games run" badge reads — a session count would
      // be zero for an automated-only season despite a full board. The inner select reuses
      // `orderByNewestRun` so "latest completed run" is the one rule the board also reads through
      // `getLatestCompletedRun`. No completed run → no id → count matches nothing → 0.
      eb
        .selectFrom('season_run_games')
        .select((games) => games.fn.countAll<number>().as('count'))
        .where(
          'season_run_games.run_id',
          '=',
          orderByNewestRun(
            eb
              .selectFrom('season_runs')
              .select('season_runs.id')
              .whereRef('season_runs.season_id', '=', 'seasons.id')
              .where('season_runs.status', '=', 'completed'),
          ).limit(1),
        )
        .as('game_count'),
    ])
  if (scope === 'released') {
    query = query.where('release_status', '=', 'released')
  } else if (scope === 'public') {
    query = query.where((eb) =>
      eb.or([
        eb('release_status', '=', 'released'),
        eb('submission_status', '=', 'open'),
        eb('play_status', '=', 'open'),
      ]),
    )
  }
  if (options?.envId !== undefined) {
    query = query.where('env_id', '=', options.envId)
  }
  const rows = await query.orderBy('created_at', 'desc').orderBy(sql`rowid`, 'desc').execute()
  return rows.map((row) => ({
    ...row,
    submission_count: Number(row.submission_count),
    game_count: Number(row.game_count),
  }))
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

export async function setSeasonDescription(
  db: Kysely<Database>,
  seasonId: string,
  markdown: string | null,
): Promise<Season | undefined> {
  return await db
    .updateTable('seasons')
    .set({ description_markdown: markdown })
    .where('id', '=', seasonId)
    .returningAll()
    .executeTakeFirst()
}

/** Set or clear the season-specific template repository without changing run configuration. */
export async function setSeasonTemplateRepoUrl(
  db: Kysely<Database>,
  seasonId: string,
  templateRepoUrl: string | null,
): Promise<Season | undefined> {
  return await db
    .updateTable('seasons')
    .set({ template_repo_url: templateRepoUrl })
    .where('id', '=', seasonId)
    .returningAll()
    .executeTakeFirst()
}

export async function setSeasonLabel(
  db: Kysely<Database>,
  seasonId: string,
  label: string | null,
): Promise<void> {
  await db.updateTable('seasons').set({ label }).where('id', '=', seasonId).execute()
}
