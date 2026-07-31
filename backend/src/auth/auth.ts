/**
 * The single Better Auth instance the process uses, built over the shared better-sqlite3 connection
 * so the auth tables (`user`, `session`, `account`, `verification`) live on the same database as the
 * app's storage. Constructed in `main.ts` and in the test harness, never at module load, matching the
 * config-injection rule that no service reaches for global state.
 *
 * Role handling is Better Auth's own: `role` is a string the admin plugin comma-splits for its
 * permission and admin-membership checks (`adminRoles` defaults to `['admin']`). We layer no extra
 * single-role invariant on top; the permission surface is shaped entirely by the access-control
 * config in `./permissions.ts`.
 */

import { betterAuth } from 'better-auth'
import { admin } from 'better-auth/plugins'
import { type GithubProfile, github } from 'better-auth/social-providers'
import type BetterSqlite3 from 'better-sqlite3'

import type { AuthGithubOptions, AuthOptions } from '../config/config.js'
import { ac, roles } from './permissions.js'

/** The provider profile data that has to survive from OAuth callback parsing to a database hook. */
interface CapturedGithubProfile {
  username: string
  email: string
  expiresAt: number
}

/**
 * A short-lived, per-account hand-off from Better Auth's GitHub profile fetch to its account hooks.
 * Account ids are GitHub's stable numeric ids, so parallel callbacks for different people never share
 * state. Repeated callbacks for the same person carry the same username, and the later callback wins.
 */
export class GithubProfileCapture {
  private readonly profiles = new Map<string, CapturedGithubProfile>()

  capture(profile: GithubProfile, email: string): void {
    this.removeExpired()
    this.profiles.set(String(profile.id), {
      username: profile.login,
      email: email.toLowerCase(),
      expiresAt: Date.now() + 60_000,
    })
  }

  peek(accountId: string): CapturedGithubProfile | undefined {
    this.removeExpired()
    return this.profiles.get(accountId)
  }

  take(accountId: string): CapturedGithubProfile | undefined {
    const profile = this.peek(accountId)
    this.profiles.delete(accountId)
    return profile
  }

  private removeExpired(): void {
    const now = Date.now()
    for (const [accountId, profile] of this.profiles) {
      if (profile.expiresAt <= now) {
        this.profiles.delete(accountId)
      }
    }
  }
}

export function githubProvider(
  options: AuthGithubOptions,
  profiles: GithubProfileCapture,
  provider = github(options),
) {
  return {
    ...options,
    getUserInfo: async (tokens: Parameters<ReturnType<typeof github>['getUserInfo']>[0]) => {
      // Delegate the two GitHub calls and all email-selection rules to Better Auth's provider, then
      // retain only its already-fetched profile login for the account database hook.
      const result = await provider.getUserInfo(tokens)
      if (
        result === null ||
        result.user.email === null ||
        result.user.email === undefined ||
        result.user.emailVerified !== true
      ) {
        return null
      }
      profiles.capture(result.data, result.user.email)
      return result
    },
  }
}

/**
 * Create Better Auth's database hooks for the GitHub identity. The provider's built-in fetch is
 * wrapped below, so these hooks receive its exact profile without a second GitHub API request.
 */
function githubIdentityHooks(
  sqlite: BetterSqlite3.Database,
  profiles: GithubProfileCapture,
  log: (message: string) => void,
) {
  let statements:
    | {
        updateGithubUsername: BetterSqlite3.Statement
      }
    | undefined
  const getStatements = () =>
    (statements ??= {
      updateGithubUsername: sqlite.prepare('UPDATE "user" SET githubUsername = ? WHERE id = ?'),
    })

  return {
    user: {
      create: {
        // An administrator entering an email is the deployment's verification attestation. Keeping
        // this server-side also covers callers of the Better Auth API that bypass the browser dialog.
        async before(user: { emailVerified?: boolean }, context: { path?: string } | null) {
          if (context?.path === '/admin/create-user') {
            return { data: { ...user, emailVerified: true } }
          }
        },
      },
    },
    account: {
      create: {
        async before(account: { providerId: string; accountId: string; userId: string }) {
          if (account.providerId !== 'github') {
            return
          }
          const profile = profiles.peek(account.accountId)
          if (profile === undefined) {
            return false
          }
          return { data: { githubVerifiedEmail: profile.email } }
        },
        async after(
          account: { providerId: string; accountId: string; userId: string } | null | undefined,
        ) {
          if (account?.providerId !== 'github') {
            return
          }
          await synchronizeGithubUsername(account)
        },
      },
      update: {
        async after(account: { providerId: string; accountId: string; userId: string }) {
          if (account.providerId !== 'github') {
            return
          }
          await synchronizeGithubUsername(account)
        },
      },
    },
  }

  async function synchronizeGithubUsername(account: {
    accountId: string
    userId: string
  }): Promise<void> {
    const profile = profiles.take(account.accountId)
    if (profile === undefined) {
      return
    }
    try {
      getStatements().updateGithubUsername.run(profile.username, account.userId)
    } catch (error) {
      // A handle is a convenience field. Do not turn a successful OAuth login or link into a lockout
      // when its profile sync fails. A later GitHub authentication captures and retries it.
      log(`could not synchronize GitHub profile for user ${account.userId}: ${String(error)}`)
    }
  }
}

export function createAuth(
  sqlite: BetterSqlite3.Database,
  options: AuthOptions,
  log: (message: string) => void = console.warn,
  githubProfiles = new GithubProfileCapture(),
) {
  const socialProviders =
    options.github === undefined ? {} : { github: githubProvider(options.github, githubProfiles) }
  return betterAuth({
    // A raw better-sqlite3 handle selects Better Auth's built-in Kysely adapter, which is what the
    // programmatic migration in `./migrate.ts` requires.
    database: sqlite,
    secret: options.secret,
    baseURL: options.publicOrigin,
    basePath: '/api/auth',
    trustedOrigins: options.trustedOrigins,
    // No public email/password registration: accounts exist only via the seed, admin creation, and
    // GitHub sign-in.
    emailAndPassword: { enabled: true, disableSignUp: true },
    socialProviders,
    account: {
      additionalFields: {
        // The create hook supplies this private provider fact after GitHub has verified the email.
        // SQL triggers consume it during the same account insert to reject collisions and adopt the
        // address atomically. Persisting it keeps those triggers connection-independent.
        githubVerifiedEmail: {
          type: 'string',
          required: false,
          input: false,
          returned: false,
        },
      },
      accountLinking: {
        enabled: true,
        trustedProviders: ['github'],
        allowDifferentEmails: true,
        allowUnlinkingAll: false,
        updateUserInfoOnLink: false,
      },
    },
    user: {
      additionalFields: {
        // This field is only written through the callback-to-hook hand-off above. Leaving it out of
        // client input prevents anyone from claiming another person's GitHub handle.
        githubUsername: { type: 'string', required: false, input: false },
      },
    },
    // No session.cookieCache: every request does a real session lookup, so a ban takes effect on the
    // very next request rather than after a cache window. SQLite lookups are cheap at class scale.
    plugins: [
      admin({ ac, roles, defaultRole: 'pending' }),
      {
        id: 'game-sandbox-github-identity',
        version: '1.0.0',
        init: () => ({
          options: { databaseHooks: githubIdentityHooks(sqlite, githubProfiles, log) },
        }),
      },
    ],
  })
}

/**
 * The concrete auth instance type, inferred from {@link createAuth} so it carries the admin plugin's
 * server API (`api.createUser`, `api.banUser`, …) rather than the generic `Auth<BetterAuthOptions>`,
 * which would erase them.
 */
export type Auth = ReturnType<typeof createAuth>
