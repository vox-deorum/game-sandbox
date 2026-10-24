/**
 * Recording-retention queries: register a produced recording (idempotently), list/read rows for
 * the merged listing and the eviction sweep, and the pin flag plus its per-user quota count.
 */
import type { Kysely } from 'kysely'

import type { NewRecordingInput, RecordingOrigin } from '../index.js'
import type { Database, Recording } from '../schema.js'
import { decodeSession } from './sessions.js'

export async function createRecording(
  db: Kysely<Database>,
  input: NewRecordingInput,
): Promise<void> {
  // Idempotent: a re-finalize (or a backfilled id) leaves the existing row untouched.
  await db
    .insertInto('recordings')
    .values({
      ...input,
      pinned: 0,
      termination_reason: input.termination_reason ?? null,
      failed_player: input.failed_player ?? null,
      termination_detail: input.termination_detail ?? null,
      llm_scope_id: input.llm_scope_id ?? null,
      llm_session_id: input.llm_session_id ?? null,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
}

export async function listRecordings(db: Kysely<Database>): Promise<Recording[]> {
  return await db.selectFrom('recordings').selectAll().orderBy('created_at', 'desc').execute()
}

export async function getRecording(
  db: Kysely<Database>,
  id: string,
): Promise<Recording | undefined> {
  return await db.selectFrom('recordings').selectAll().where('id', '=', id).executeTakeFirst()
}

export async function setRecordingPinned(
  db: Kysely<Database>,
  id: string,
  pinned: boolean,
): Promise<boolean> {
  const result = await db
    .updateTable('recordings')
    .set({ pinned: pinned ? 1 : 0 })
    .where('id', '=', id)
    .executeTakeFirst()
  return Number(result.numUpdatedRows) > 0
}

export async function countPinnedByUser(db: Kysely<Database>, userId: string): Promise<number> {
  const row = await db
    .selectFrom('recordings')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('user_id', '=', userId)
    .where('pinned', '=', 1)
    .executeTakeFirst()
  return Number(row?.count ?? 0)
}

/**
 * Where a recording came from: the session that produced it, else the scheduled tournament game that
 * recorded it. A session claim wins, so a recording always has one origin and one season.
 */
export async function findRecordingOrigin(
  db: Kysely<Database>,
  recordingId: string,
): Promise<RecordingOrigin | undefined> {
  const session = await db
    .selectFrom('sessions')
    .selectAll()
    .where('recording_id', '=', recordingId)
    .executeTakeFirst()
  if (session !== undefined) {
    const decoded = decodeSession(session)
    return { kind: 'session', season_id: decoded.season_id, session: decoded }
  }
  const game = await runGameRecordings(db)
    .where('season_run_games.recording_id', '=', recordingId)
    .executeTakeFirst()
  return game === undefined
    ? undefined
    : { kind: 'run_game', season_id: game.season_id, status: game.status }
}

/**
 * Recording id to season id for every recording a session or a tournament game claims, by the same
 * session-first rule as {@link findRecordingOrigin}, for the replay listing.
 */
export async function listRecordingSeasons(
  db: Kysely<Database>,
): Promise<Map<string, string | null>> {
  const [games, sessions] = await Promise.all([
    runGameRecordings(db).where('season_run_games.recording_id', 'is not', null).execute(),
    db
      .selectFrom('sessions')
      .select(['recording_id', 'season_id'])
      .where('recording_id', 'is not', null)
      .execute(),
  ])
  const seasons = new Map<string, string | null>()
  // Sessions are applied last so their claim wins.
  for (const row of [...games, ...sessions]) {
    if (row.recording_id !== null) {
      seasons.set(row.recording_id, row.season_id)
    }
  }
  return seasons
}

/** Scheduled games joined to their run, with the recording, season, and game status. */
function runGameRecordings(db: Kysely<Database>) {
  return db
    .selectFrom('season_run_games')
    .innerJoin('season_runs', 'season_runs.id', 'season_run_games.run_id')
    .select([
      'season_run_games.recording_id as recording_id',
      'season_runs.season_id as season_id',
      'season_run_games.status as status',
    ])
}
