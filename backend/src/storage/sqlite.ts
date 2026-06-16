/**
 * The SQLite wiring for {@link Storage}: construct the better-sqlite3 dialect, open the
 * database in WAL mode, create the schema, and hand the resulting `Kysely<Database>` to the
 * implementation. Another engine later is a sibling wiring file constructing a different
 * dialect; the schema, the queries, and the interface do not change.
 *
 * This module is the one place outside tests that imports `better-sqlite3` and `kysely`'s
 * dialect; the `noRestrictedImports` boundary keeps both confined to `storage/`.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'

import { createSchema } from './create-schema.js'
import type { Storage } from './index.js'
import { KyselyStorage } from './kysely.js'
import type { Database } from './schema.js'

/**
 * Open (creating if needed) the SQLite database at `dbPath`, ensure the schema exists, and return
 * a ready {@link Storage}. Pass `:memory:` for an ephemeral database (the test default). The
 * schema setup is idempotent, so reopening an existing file is safe. The implementation is the
 * real one in every context, per the storage design.
 */
export async function openSqliteStorage(dbPath: string): Promise<Storage> {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
  }
  const sqlite = new BetterSqlite3(dbPath)
  // WAL keeps reads from blocking the single writer; foreign keys on for later tables.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })

  try {
    await createSchema(db)
  } catch (error) {
    await db.destroy()
    throw error instanceof Error ? error : new Error(`schema setup failed: ${String(error)}`)
  }

  return new KyselyStorage(db)
}
