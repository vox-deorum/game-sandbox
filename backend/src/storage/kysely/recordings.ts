/**
 * Recording-retention queries: register a produced recording (idempotently), list/read rows for
 * the merged listing and the eviction sweep, and the pin flag plus its per-user quota count.
 */
import type { Kysely } from 'kysely'

import type { NewRecordingInput } from '../index.js'
import type { Database, Recording } from '../schema.js'

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
