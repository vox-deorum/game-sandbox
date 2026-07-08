/**
 * Better Auth's programmatic schema migration. It introspects the live database, computes the
 * migrations required for the configured options and enabled plugins, and applies only the ones the
 * database is missing, so it is idempotent and runs identically on the production file database and
 * the in-memory test databases (it runs on the same connection either way). `main.ts` calls it right
 * after the app's own schema bootstrap; the test harness calls it on each `:memory:` database.
 */
import { getMigrations } from 'better-auth/db/migration'

import type { Auth } from './auth.js'

export async function migrateAuthSchema(auth: Auth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
}
