/**
 * The single auth configuration every backend test shares. Kept in its own data-only module (a
 * type-only dependency on {@link AuthOptions}) so the many suites that merely build a {@link Config}
 * via `makeConfig`/`startStack` can reuse these values without importing the Better Auth runtime that
 * `support/auth.ts` pulls in. The values are valid but deliberately test-only; never deploy them.
 */
import type { AuthOptions } from '../../src/config.js'

export const TEST_AUTH_OPTIONS: AuthOptions = {
  secret: 'test-secret-at-least-32-characters!!',
  publicOrigin: 'http://localhost',
  trustedOrigins: ['http://localhost'],
  insecureDevelopment: false,
  adminEmail: 'admin@test.local',
  adminPassword: 'test-admin-password',
  adminName: 'Test Admin',
}
