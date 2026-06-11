/**
 * The in-package migration provider. Migrations are embedded TypeScript modules keyed by an
 * ordered name; Kysely's `Migrator` runs them in lexicographic key order. Adding a migration
 * is adding a module and a line here, so the set is explicit and reviewable, with no filesystem
 * scan that would behave differently under `tsx` and a future compiled build.
 */
import type { Migration, MigrationProvider } from 'kysely/migration'

import { migration as createSessions } from './001_create_sessions.js'

const migrations: Record<string, Migration> = {
  '001_create_sessions': createSessions,
}

export const migrationProvider: MigrationProvider = {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(migrations)
  },
}
