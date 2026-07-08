/**
 * The idempotent bootstrap-admin seed, run at startup after {@link migrateAuthSchema}. It owns one
 * reserved, stable Better Auth user id, so changing `ADMIN_EMAIL` updates the same account instead of
 * creating a second administrator, and it treats deployment configuration as the source of truth:
 * a demoted, banned, or password-changed bootstrap admin heals on the next boot.
 *
 * The credential is resynced only when `ADMIN_PASSWORD` actually changes: rotating it and restarting
 * rewrites the hash with no manual step and revokes every existing bootstrap-admin session, so an old
 * (possibly leaked) password can never keep a session alive. A restart with unchanged configuration
 * leaves the credential untouched: it neither rewrites the hash nor disturbs live admin sessions. The
 * user row itself is force-healed unconditionally (see below), so `updatedAt` is not a reliable
 * "something changed this boot" signal for this account.
 */
import type { Auth } from './auth.js'

/** The reserved, stable user id the bootstrap admin always occupies. */
export const BOOTSTRAP_ADMIN_ID = 'game-sandbox-bootstrap-admin'

export interface AdminSeed {
  /** Must already be lowercased; config's `loadAuthOptions` is the single normalization boundary. */
  email: string
  password: string
  name: string
}

export async function ensureAdminUser(
  auth: Auth,
  seed: AdminSeed,
  log: (message: string) => void,
): Promise<void> {
  const ctx = await auth.$context
  const email = seed.email

  const existing = await ctx.internalAdapter.findUserById(BOOTSTRAP_ADMIN_ID)
  const emailOwner = await ctx.internalAdapter.findUserByEmail(email)

  if (existing === null) {
    // First boot for this reserved id. Refuse to start if another user already owns the configured
    // email, so we never create a second account or silently collide.
    if (emailOwner !== null) {
      throw new Error(
        `ADMIN_EMAIL ${email} already belongs to user ${emailOwner.user.id}; refusing to start`,
      )
    }
    const user = await ctx.internalAdapter.createUser({
      id: BOOTSTRAP_ADMIN_ID,
      email,
      name: seed.name,
      emailVerified: true,
      role: 'admin',
      banned: false,
    })
    await linkCredential(ctx, user.id, await ctx.password.hash(seed.password))
    log(`seeded bootstrap admin ${email}`)
    return
  }

  // The reserved account exists. Refuse to start if the configured email now belongs to a different
  // user; otherwise force this same account back to a healthy admin and resync its credential.
  if (emailOwner !== null && emailOwner.user.id !== BOOTSTRAP_ADMIN_ID) {
    throw new Error(
      `ADMIN_EMAIL ${email} belongs to a different user ${emailOwner.user.id}; refusing to start`,
    )
  }
  await ctx.internalAdapter.updateUser(BOOTSTRAP_ADMIN_ID, {
    email,
    name: seed.name,
    role: 'admin',
    banned: false,
    banReason: null,
    banExpires: null,
  })
  const rotated = await resyncCredential(ctx, seed.password)
  log(
    rotated
      ? `rotated bootstrap admin ${email} password and revoked its sessions`
      : `re-synced bootstrap admin ${email}`,
  )
}

/**
 * Bring the bootstrap admin's credential in line with the configured password, returning whether a
 * rotation happened. The hash is rewritten and every existing session revoked only when the password
 * actually changed, so an ordinary restart with an unchanged password leaves live admin sessions
 * intact and a rotated (possibly leaked) password can never keep a session alive.
 */
async function resyncCredential(
  ctx: Awaited<Auth['$context']>,
  password: string,
): Promise<boolean> {
  const accounts = await ctx.internalAdapter.findAccounts(BOOTSTRAP_ADMIN_ID)
  const credential = accounts.find((account) => account.providerId === 'credential')
  // No credential row yet (e.g. a social-only reserved account): establish one. Nothing to rotate.
  if (credential === undefined) {
    await linkCredential(ctx, BOOTSTRAP_ADMIN_ID, await ctx.password.hash(password))
    return false
  }
  // A credential row with no stored hash should never occur — Better Auth only writes a credential
  // account together with a password — but guard it by updating the existing row in place rather than
  // linking a second one (`linkAccount` inserts unconditionally, which would leave two credential
  // rows for one user). Nothing to rotate.
  if (credential.password == null) {
    await ctx.internalAdapter.updatePassword(BOOTSTRAP_ADMIN_ID, await ctx.password.hash(password))
    return false
  }
  // Salted hashes never compare equal, so detect an unchanged password by verifying it against the
  // stored hash rather than re-hashing and comparing strings.
  if (await ctx.password.verify({ hash: credential.password, password })) {
    return false
  }
  await ctx.internalAdapter.updatePassword(BOOTSTRAP_ADMIN_ID, await ctx.password.hash(password))
  await ctx.internalAdapter.deleteUserSessions(BOOTSTRAP_ADMIN_ID)
  return true
}

/** Create the credential (email/password) account row carrying the hashed password. */
async function linkCredential(
  ctx: Awaited<Auth['$context']>,
  userId: string,
  hashedPassword: string,
): Promise<void> {
  await ctx.internalAdapter.linkAccount({
    userId,
    providerId: 'credential',
    accountId: userId,
    password: hashedPassword,
  })
}
