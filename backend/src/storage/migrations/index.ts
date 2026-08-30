/**
 * The application schema migrations assembled for Kysely's migrator.
 *
 * `0001_initial_schema` builds the current shape for a fresh database. Deployed databases have
 * already recorded it, so every schema update must also append equivalent retry-safe forward steps
 * to the latest pending migration. Keep appending to that migration without changing the schema
 * version until the project owner directs a bump. At a bump, the previous migration becomes
 * immutable and a new latest migration owns subsequent updates.
 *
 * Each database carries its schema version in SQLite's `user_version`. Startup applies pending
 * migrations, then rejects a database whose version is unsupported. The versions are:
 *
 * - Version 1: the former rating shape with one hard-coded builtin identity and no written
 *   feedback. Databases from this era predate the marker and read `user_version` 0.
 * - Version 2: the current shape. `0001_initial_schema` builds it directly;
 *   `0002_legacy_ratings_schema` upgrades a version 1 database to it.
 */
import type { Kysely } from 'kysely'
import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration'

import type { Database } from '../schema.js'
import { initialSchema } from './0001_initial_schema.js'
import { legacyRatingsSchema } from './0002_legacy_ratings_schema.js'

export { CURRENT_SCHEMA_VERSION } from './0001_initial_schema.js'

/** The fresh schema followed by the pending deployed-database upgrade. */
export const migrations: Record<string, Migration> = {
  '0001_initial_schema': initialSchema,
  '0002_legacy_ratings_schema': legacyRatingsSchema,
}

/** Serves {@link migrations} from memory, so there is no migration folder to read at runtime. */
class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations
  }
}

/**
 * Bring the database to the latest schema version. Idempotent: a database that already recorded
 * every migration is left untouched, so reopening an existing file is safe. Throws on the first
 * failed migration with its underlying error.
 */
export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider() })
  const { error, results } = await migrator.migrateToLatest()

  const failed = results?.find((it) => it.status === 'Error')
  if (error || failed) {
    const cause = error ?? new Error(`migration "${failed?.migrationName}" failed`)
    throw cause instanceof Error ? cause : new Error(`schema migration failed: ${String(cause)}`)
  }
}
