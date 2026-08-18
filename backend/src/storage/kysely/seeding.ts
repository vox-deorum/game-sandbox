/**
 * The seed's per-environment bookkeeping: the "template arc planted" flag. `getTemplateArcPlanted`
 * returns false when no row exists, so a fresh database is unplanted, and `setTemplateArcPlanted`
 * upserts the flag (a deployment update clears it so the next release's arc is planted).
 */
import type { Kysely } from 'kysely'

import type { Database } from '../schema.js'

/** Whether the seed has planted this environment's template arc; false when no row exists. */
export async function getTemplateArcPlanted(db: Kysely<Database>, envId: string): Promise<boolean> {
  const row = await db
    .selectFrom('season_seed_flags')
    .select('templates_planted')
    .where('env_id', '=', envId)
    .executeTakeFirst()
  return (row?.templates_planted ?? 0) === 1
}

/** Record whether the seed planted (or cleared) this environment's template arc. */
export async function setTemplateArcPlanted(
  db: Kysely<Database>,
  envId: string,
  planted: boolean,
): Promise<void> {
  const templates_planted = planted ? 1 : 0
  await db
    .insertInto('season_seed_flags')
    .values({ env_id: envId, templates_planted })
    .onConflict((conflict) => conflict.column('env_id').doUpdateSet({ templates_planted }))
    .execute()
}
