/**
 * The roster row type, derived directly from the real `authClient.admin.listUsers` return so every
 * surface (the page, the table, the dialogs) shares exactly the fields the Better Auth admin plugin
 * emits, with no hand-maintained shape to drift from it. This is the one page family that touches
 * `authClient.admin` directly, so there is no api/client.ts wrapper type to reuse.
 */
import type { authClient } from '../auth.js'

export type ListUsersResult = Awaited<ReturnType<typeof authClient.admin.listUsers>>
export type RosterUser = Extract<ListUsersResult, { error: null }>['data']['users'][number]
