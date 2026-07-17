import type { Kysely } from 'kysely'

import type { Database, LlmDevelopmentKey } from '../schema.js'

export interface RotateDevelopmentKeyInput {
  seasonId: string
  userId: string
  keyId: string
  secretHash: string
  now: string
}

/**
 * Replace one season/user credential. A single upsert: the insert branch stamps `created_at` and a
 * null `rotated_at`; the conflict branch omits `created_at` (preserving the original) and stamps
 * `rotated_at`, so "first issue" versus "rotation" is decided by the row's existence alone.
 */
export async function rotateDevelopmentKey(
  db: Kysely<Database>,
  input: RotateDevelopmentKeyInput,
): Promise<LlmDevelopmentKey> {
  return await db
    .insertInto('llm_development_keys')
    .values({
      season_id: input.seasonId,
      user_id: input.userId,
      key_id: input.keyId,
      secret_hash: input.secretHash,
      created_at: input.now,
      rotated_at: null,
    })
    .onConflict((conflict) =>
      conflict.columns(['season_id', 'user_id']).doUpdateSet({
        key_id: input.keyId,
        secret_hash: input.secretHash,
        rotated_at: input.now,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow()
}

/** Indexed public-id lookup used before constant-time secret verification. */
export async function getDevelopmentKeyByKeyId(
  db: Kysely<Database>,
  keyId: string,
): Promise<LlmDevelopmentKey | undefined> {
  return await db
    .selectFrom('llm_development_keys')
    .selectAll()
    .where('key_id', '=', keyId)
    .executeTakeFirst()
}

export async function getDevelopmentKey(
  db: Kysely<Database>,
  seasonId: string,
  userId: string,
): Promise<LlmDevelopmentKey | undefined> {
  return await db
    .selectFrom('llm_development_keys')
    .selectAll()
    .where('season_id', '=', seasonId)
    .where('user_id', '=', userId)
    .executeTakeFirst()
}
