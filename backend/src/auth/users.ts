/**
 * The read-only user directory (Stage 12.4): resolve Better Auth user ids to display names for the
 * response boundary. Rows across the app store opaque Better Auth ids; routes batch those ids through
 * {@link UserDirectory.namesFor} at read time and attach a display name beside each stable id, so
 * names are never written into stored rows or persisted JSON.
 *
 * The `user` table is library-owned (created by Better Auth's migration, deliberately excluded from
 * the app's `Database` schema type), so the directory reads it with a locally-typed raw better-sqlite3
 * prepared statement rather than folding the table into the Kysely schema — `kysely` imports are
 * denied in `auth/` by the module boundary, while the raw handle's package is allowed here.
 */
import type BetterSqlite3 from 'better-sqlite3'

import type { AgentRef } from '../storage/schema.js'

/** Ids per IN(...) statement, far below SQLite's default variable limit (999 at its historic lowest). */
const CHUNK_SIZE = 500

/** Resolves Better Auth user ids to display names; an id with no row (or a blank name) is absent. */
export interface UserDirectory {
  namesFor(ids: readonly string[]): Promise<Map<string, string>>
}

/** The one row shape the directory reads from the library-owned `user` table. */
interface UserNameRow {
  id: string
  name: string | null
}

/**
 * Build the directory over the shared raw connection. The interface is Promise-based so a later
 * engine (or a remote roster) can slot in, even though better-sqlite3 itself is synchronous.
 */
export function createUserDirectory(sqlite: BetterSqlite3.Database): UserDirectory {
  return {
    namesFor(ids: readonly string[]): Promise<Map<string, string>> {
      const names = new Map<string, string>()
      const unique = [...new Set(ids)]
      for (let offset = 0; offset < unique.length; offset += CHUNK_SIZE) {
        const chunk = unique.slice(offset, offset + CHUNK_SIZE)
        const placeholders = chunk.map(() => '?').join(', ')
        const rows = sqlite
          .prepare(`SELECT id, name FROM "user" WHERE id IN (${placeholders})`)
          .all(...chunk) as UserNameRow[]
        for (const row of rows) {
          // A blank name is treated as missing, so callers fall back to the stable id.
          if (row.name !== null && row.name !== '') {
            names.set(row.id, row.name)
          }
        }
      }
      return Promise.resolve(names)
    },
  }
}

/**
 * An {@link AgentRef} as responses carry it: the submission variant optionally enriched with the
 * owner's display name beside the stable `user_id`. Response-side only — the stored type is untouched.
 */
export type EnrichedAgentRef =
  | { kind: 'submission'; submission_id: string; user_id: string; user_name?: string }
  | { kind: 'builtin-naive' }

/** Attach the owner's display name to a submission ref when the directory resolved one. */
export function enrichAgentRef(
  ref: AgentRef,
  names: ReadonlyMap<string, string>,
): EnrichedAgentRef {
  if (ref.kind !== 'submission') {
    return ref
  }
  const name = names.get(ref.user_id)
  return name === undefined ? ref : { ...ref, user_name: name }
}
