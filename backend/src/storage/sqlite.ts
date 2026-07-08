/**
 * The SQLite wiring for {@link Storage}: construct the better-sqlite3 dialect, open the
 * database in WAL mode, create the schema, and hand the resulting `Kysely<Database>` to the
 * implementation. Another engine later is a sibling wiring file constructing a different
 * dialect; the migration, the queries, and the interface do not change.
 *
 * This module is the one place outside tests that imports `better-sqlite3` and `kysely`'s
 * dialect; the `noRestrictedImports` boundary keeps both confined to `storage/` (and, for the
 * raw handle's type alone, `auth/`).
 *
 * {@link openSqlite} additionally returns the raw better-sqlite3 connection so Better Auth
 * (Stage 12) can embed its own tables on the exact same handle: two opens of `:memory:` are two
 * different databases, and even for a file two connections would not share write-ahead state
 * cleanly, so the auth tables and the app tables must live behind one connection. Closing the
 * {@link Storage} (`Storage.close()` -> `Kysely.destroy()`) closes that shared connection, so any
 * Better Auth query after `storage.close()` throws; `storage.close()` therefore stays the last
 * teardown action in `main.ts` and in every suite.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'

import type { Storage } from './index.js'
import { KyselyStorage } from './kysely/index.js'
import { migrateToLatest } from './migrations.js'
import type { Database } from './schema.js'

/** The app {@link Storage} paired with the raw better-sqlite3 connection it was built on. */
export interface SqliteHandle {
  storage: Storage
  sqlite: BetterSqlite3.Database
}

/**
 * Open (creating if needed) the SQLite database at `dbPath`, migrate it to the latest app schema,
 * and return both the ready {@link Storage} and the raw better-sqlite3 connection behind it (for
 * Better Auth's embedded tables). Pass `:memory:` for an ephemeral database (the test default). The
 * migration is idempotent, so reopening an existing file is safe. The raw connection is never used
 * for app queries outside `storage/` and `auth/`.
 */
export async function openSqlite(dbPath: string): Promise<SqliteHandle> {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
  }
  const sqlite = new BetterSqlite3(dbPath)
  // WAL keeps reads from blocking the single writer; foreign keys on for later tables.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })

  try {
    await migrateToLatest(db)
  } catch (error) {
    await db.destroy()
    throw error instanceof Error ? error : new Error(`schema migration failed: ${String(error)}`)
  }

  return { storage: new KyselyStorage(db), sqlite }
}

/**
 * Open (creating if needed) the SQLite database at `dbPath`, migrate it, and return a ready
 * {@link Storage}. A thin wrapper over {@link openSqlite} for the many call sites that never touch
 * Better Auth and only want the storage facade.
 */
export async function openSqliteStorage(dbPath: string): Promise<Storage> {
  const { storage } = await openSqlite(dbPath)
  return storage
}
