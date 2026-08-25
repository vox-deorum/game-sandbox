/**
 * The access-control config the admin plugin runs on. Better Auth's admin plugin authorizes each
 * `/api/auth/admin/*` endpoint against the acting user's role, comma-splitting the role string and
 * granting a permission if any split role's declared statements allow it (see `has-permission` in
 * the plugin). We declare three roles so the plugin treats all three as first-class:
 *
 * - `admin` is an explicit allowlist of the roster operations this stage supports: list users,
 *   create a user, set a role, ban/unban (both gated by the `ban` statement), and reset a password.
 *   It deliberately omits the plugin's `delete` statement, so `POST /api/auth/admin/remove-user` is
 *   refused server-side even for an admin session, not merely hidden in the UI. It also omits
 *   `impersonate`, `set-email`, `update`, `get`, and every `session` statement, none of which this
 *   stage exposes.
 * - `user`, `guest`, and `pending` carry no admin-plugin permissions.
 *
 * `pending` is the `defaultRole`, the status a new GitHub sign-up lands on; it must be declared here
 * for the plugin to treat it as a real role rather than an unknown value. `guest` is declared (with no
 * permissions) so the admin plugin accepts the token in `create-user` and `set-role`; guests can play
 * and watch but never administer.
 */
import { createAccessControl } from 'better-auth/plugins/access'
import { defaultStatements } from 'better-auth/plugins/admin/access'

export const ac = createAccessControl(defaultStatements)

/** The four canonical roles this deployment supports; `pending` is the admin plugin's default. */
export const VALID_ROLES = ['pending', 'user', 'guest', 'admin'] as const

/** A role name; the single source is {@link VALID_ROLES}, which {@link roles} is checked against. */
export type Role = (typeof VALID_ROLES)[number]

// `satisfies` keeps each role's inferred permission statements (which the admin plugin reads) while
// forcing `roles` to declare exactly the names in VALID_ROLES: drop or add a role in one place and
// the compiler flags the other, so the two can never drift.
export const roles = {
  admin: ac.newRole({ user: ['list', 'create', 'set-role', 'ban', 'set-password'] }),
  user: ac.newRole({}),
  guest: ac.newRole({}),
  pending: ac.newRole({}),
} satisfies Record<Role, unknown>
