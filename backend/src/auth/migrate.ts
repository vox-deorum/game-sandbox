/**
 * Better Auth's programmatic schema migration. It introspects the live database, computes the
 * migrations required for the configured options and enabled plugins, and applies only the ones the
 * database is missing, so it is idempotent and runs identically on the production file database and
 * the in-memory test databases (it runs on the same connection either way). `main.ts` calls it right
 * after the app's own schema bootstrap; the test harness calls it on each `:memory:` database.
 */
import { getMigrations } from 'better-auth/db/migration'
import type BetterSqlite3 from 'better-sqlite3'

import type { Auth } from './auth.js'

export async function migrateAuthSchema(auth: Auth, sqlite: BetterSqlite3.Database): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
  installGithubAccountInvariants(sqlite)
}

/** Install race-safe GitHub account invariants after Better Auth has created its tables. */
export function installGithubAccountInvariants(sqlite: BetterSqlite3.Database): void {
  sqlite.transaction(() => {
    sqlite.exec(`
      -- Recreate these two triggers on every startup so deployments that installed the former
      -- connection-local UDF definitions are upgraded to the connection-independent SQL versions.
      -- The surrounding transaction prevents another connection from writing between replacement
      -- statements.
      DROP TRIGGER IF EXISTS account_github_refuse_conflict;
      DROP TRIGGER IF EXISTS account_github_adopt_email;

      CREATE UNIQUE INDEX IF NOT EXISTS account_one_github_per_user
      ON account (userId)
      WHERE providerId = 'github';

      CREATE UNIQUE INDEX IF NOT EXISTS account_unique_github_identity
      ON account (accountId)
      WHERE providerId = 'github';

      CREATE TRIGGER account_github_refuse_conflict
      BEFORE INSERT ON account
      WHEN NEW.providerId = 'github'
        AND (
          NULLIF(TRIM(NEW.githubVerifiedEmail), '') IS NULL
          OR
          EXISTS (
            SELECT 1
            FROM account
            WHERE providerId = 'github'
              AND userId = NEW.userId
          )
          OR EXISTS (
            SELECT 1
            FROM account
            WHERE providerId = 'github'
              AND accountId = NEW.accountId
          )
          OR EXISTS (
            SELECT 1
            FROM "user"
            WHERE id <> NEW.userId
              AND LOWER(email) = LOWER(NEW.githubVerifiedEmail)
          )
        )
      BEGIN
        SELECT RAISE(IGNORE);
      END;

      CREATE TRIGGER account_github_adopt_email
      AFTER INSERT ON account
      WHEN NEW.providerId = 'github'
        AND NULLIF(TRIM(NEW.githubVerifiedEmail), '') IS NOT NULL
      BEGIN
        UPDATE "user"
        SET email = LOWER(NEW.githubVerifiedEmail)
        WHERE id = NEW.userId;
      END;

      CREATE TRIGGER IF NOT EXISTS account_github_clear_username
      AFTER DELETE ON account
      WHEN OLD.providerId = 'github'
      BEGIN
        UPDATE "user"
        SET githubUsername = NULL
        WHERE id = OLD.userId;
      END;
    `)
  })()
}

/**
 * Mark pre-existing credential accounts as verified. This is deliberately separate from Better
 * Auth's schema migration: it changes deployment policy data, not library-owned table structure.
 * New administrator-created users receive the same flag from the auth database hook.
 */
export function verifyCredentialUsers(sqlite: BetterSqlite3.Database): void {
  sqlite
    .prepare(
      `
        UPDATE "user"
        SET emailVerified = 1
        WHERE emailVerified = 0
          AND EXISTS (
            SELECT 1
            FROM account
            WHERE account.userId = "user".id
              AND account.providerId = 'credential'
          )
      `,
    )
    .run()
}
