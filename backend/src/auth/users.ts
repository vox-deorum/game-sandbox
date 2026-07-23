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

import { deriveStatus, type UserStatus } from '@game-sandbox/schema/accounts'
import type { BoardAgentRef } from '@game-sandbox/schema/board'
import type BetterSqlite3 from 'better-sqlite3'

import type { AgentRef } from '../storage/schema.js'

/** Ids per IN(...) statement, far below SQLite's default variable limit (999 at its historic lowest). */
const CHUNK_SIZE = 500

/** Resolves Better Auth user ids to display names; an id with no row (or a blank name) is absent. */
export interface UserDirectory {
  namesFor(ids: readonly string[]): Promise<Map<string, string>>
  profilesFor(ids: readonly string[]): Promise<Map<string, UserProfile>>
}

/** The safe public profile fields an agent page may resolve for a submission owner. */
export interface UserProfile {
  name?: string
  githubUsername?: string
}

/** The one row shape the directory reads from the library-owned `user` table. */
interface UserNameRow {
  id: string
  name: string | null
  githubUsername: string | null
}

/** The current authorization fields read directly from Better Auth's user row. */
interface UserStatusRow {
  role: string | null
  banned: number | boolean | null
}

/** Read a user's current account status without relying on an existing login session. */
export function createUserStatusReader(
  sqlite: BetterSqlite3.Database,
): (userId: string) => Promise<UserStatus | null> {
  const statement = sqlite.prepare('SELECT role, banned FROM "user" WHERE id = ?')
  return (userId: string): Promise<UserStatus | null> => {
    const row = statement.get(userId) as UserStatusRow | undefined
    if (row === undefined || row.banned === true || row.banned === 1) {
      return Promise.resolve(null)
    }
    return Promise.resolve(deriveStatus(row.role))
  }
}

/**
 * Build the directory over the shared raw connection. The interface is Promise-based so a later
 * engine (or a remote roster) can slot in, even though better-sqlite3 itself is synchronous.
 */
export function createUserDirectory(sqlite: BetterSqlite3.Database): UserDirectory {
  // Prepared statements keyed by placeholder count, so the read hot path (every public session,
  // recordings, and leaderboard response resolves at least one name) compiles each IN(...) shape once.
  // Callers overwhelmingly pass a single id, so this is usually one cached statement for the life of
  // the process.
  const statements = new Map<number, BetterSqlite3.Statement>()
  const statementFor = (count: number): BetterSqlite3.Statement => {
    const cached = statements.get(count)
    if (cached !== undefined) {
      return cached
    }
    const placeholders = Array.from({ length: count }, () => '?').join(', ')
    const statement = sqlite.prepare(
      `SELECT id, name, githubUsername FROM "user" WHERE id IN (${placeholders})`,
    )
    statements.set(count, statement)
    return statement
  }
  const profilesFor = (ids: readonly string[]): Promise<Map<string, UserProfile>> => {
    const profiles = new Map<string, UserProfile>()
    const unique = [...new Set(ids)]
    for (let offset = 0; offset < unique.length; offset += CHUNK_SIZE) {
      const chunk = unique.slice(offset, offset + CHUNK_SIZE)
      const rows = statementFor(chunk.length).all(...chunk) as UserNameRow[]
      for (const row of rows) {
        const profile: UserProfile = {}
        if (row.name !== null && row.name !== '') {
          profile.name = row.name
        }
        if (row.githubUsername !== null && row.githubUsername !== '') {
          profile.githubUsername = row.githubUsername
        }
        if (profile.name !== undefined || profile.githubUsername !== undefined) {
          profiles.set(row.id, profile)
        }
      }
    }
    return Promise.resolve(profiles)
  }
  return {
    async namesFor(ids: readonly string[]): Promise<Map<string, string>> {
      const names = new Map<string, string>()
      for (const [id, profile] of await profilesFor(ids)) {
        // A blank name is absent from the profile, so callers fall back to the stable id.
        if (profile.name !== undefined) {
          names.set(id, profile.name)
        }
      }
      return names
    },
    profilesFor,
  }
}

/** Attach the owner's display name to a submission ref when the directory resolved one. */
export function enrichAgentRef(ref: AgentRef, names: ReadonlyMap<string, string>): BoardAgentRef {
  if (ref.kind !== 'submission') {
    return ref
  }
  const name = names.get(ref.user_id)
  return name === undefined ? ref : { ...ref, user_name: name }
}
