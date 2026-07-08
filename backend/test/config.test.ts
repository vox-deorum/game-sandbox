import { describe, expect, it } from 'vitest'

import { type Config, loadConfig } from '../src/config.js'

// Every startup now requires explicit auth configuration, so supply valid, non-published values and
// let each test override just the variables it cares about. The auth validation matrix (required
// variables, insecure-defaults opt-in, loopback rules, GitHub both-or-neither) is covered separately
// in test/auth/foundation.test.ts.
const AUTH_ENV = {
  PUBLIC_ORIGIN: 'https://sandbox.example.edu',
  AUTH_SECRET: 'an-explicit-secret-of-at-least-32-chars',
  ADMIN_EMAIL: 'ops@example.edu',
  ADMIN_PASSWORD: 'an-explicit-admin-password',
}
const load = (env: NodeJS.ProcessEnv = {}): Config => loadConfig({ ...AUTH_ENV, ...env })

describe('loadConfig', () => {
  it('applies class-scale defaults when only the required auth variables are set', () => {
    const config = load({})
    expect(config.port).toBe(8080)
    expect(config.siteName).toBe('Game Sandbox')
    // The short name defaults to the site name, so it is 'Game Sandbox' out of the box too.
    expect(config.siteShortName).toBe('Game Sandbox')
    expect(config.executionDriver).toBe('docker')
    expect(config.docker.imagePolicy).toBe('reuse')
    expect(config.docker.imageTagPrefix).toBe('game-sandbox')
    expect(config.sandbox).toEqual({ cpus: 1, memoryMb: 512, scratchMb: 256 })
    // The db and recordings paths are derived from the data dir.
    expect(config.dbPath.endsWith('sandbox.db')).toBe(true)
    expect(config.recordingsDir.endsWith('recordings')).toBe(true)
    // A fresh checkout plays out of the box: the dev user is session- and operator-allowlisted.
    expect(config.sessionAllowlist).toEqual(['dev-user'])
    expect(config.operatorAllowlist).toEqual(['dev-user'])
    // The retention spec's defaults: 30-day window, 100 per user, hourly sweep.
    expect(config.recordingRetentionDays).toBe(30)
    expect(config.recordingUserQuota).toBe(100)
    expect(config.recordingSweepIntervalMs).toBe(3_600_000)
  })

  it('overrides the site name from SITE_NAME, ignoring an empty value', () => {
    expect(load({ SITE_NAME: 'Acme Arena' }).siteName).toBe('Acme Arena')
    // An empty value falls back to the default rather than blanking the brand.
    expect(load({ SITE_NAME: '' }).siteName).toBe('Game Sandbox')
  })

  it('defaults the short name to the resolved site name and overrides it independently', () => {
    // With only SITE_NAME set, the short name mirrors it for free.
    expect(load({ SITE_NAME: 'Acme Arena' }).siteShortName).toBe('Acme Arena')
    // SITE_SHORT_NAME overrides just the short form; the full name is unaffected.
    const both = load({ SITE_NAME: 'Acme Arena', SITE_SHORT_NAME: 'Acme' })
    expect(both.siteName).toBe('Acme Arena')
    expect(both.siteShortName).toBe('Acme')
    // An empty short name falls back to the site name, not to a blank brand.
    expect(load({ SITE_NAME: 'Acme Arena', SITE_SHORT_NAME: '' }).siteShortName).toBe('Acme Arena')
  })

  it('defaults the docs root to the repo docs/ and leaves the index override unset', () => {
    const config = load({})
    // Derived via path.join off the repo root, so assert the tail rather than a separator-specific path.
    expect(config.docsDir.endsWith('docs')).toBe(true)
    expect(config.docsIndexFile).toBeUndefined()
  })

  it('overrides the docs root and index file, ignoring empty values', () => {
    const config = load({ DOCS_DIR: '/srv/docs', DOCS_INDEX_FILE: '/srv/class/home.md' })
    expect(config.docsDir).toBe('/srv/docs')
    expect(config.docsIndexFile).toBe('/srv/class/home.md')
    // Empty values fall back to the default root and an unset override, not to blanks.
    const empty = load({ DOCS_DIR: '', DOCS_INDEX_FILE: '' })
    expect(empty.docsDir.endsWith('docs')).toBe(true)
    expect(empty.docsIndexFile).toBeUndefined()
  })

  it('parses the retention overrides', () => {
    const config = load({
      RECORDING_RETENTION_DAYS: '7',
      RECORDING_USER_QUOTA: '5',
      RECORDING_SWEEP_INTERVAL_MS: '60000',
    })
    expect(config.recordingRetentionDays).toBe(7)
    expect(config.recordingUserQuota).toBe(5)
    expect(config.recordingSweepIntervalMs).toBe(60000)
  })

  it('parses SESSION_ALLOWLIST as a trimmed comma-separated list', () => {
    expect(load({ SESSION_ALLOWLIST: 'alice, bob ,carol' }).sessionAllowlist).toEqual([
      'alice',
      'bob',
      'carol',
    ])
    // An explicitly empty value is an empty allowlist (no one may start a session).
    expect(load({ SESSION_ALLOWLIST: '' }).sessionAllowlist).toEqual([])
  })

  it('parses OPERATOR_ALLOWLIST the same way as the session allowlist', () => {
    expect(load({ OPERATOR_ALLOWLIST: 'op1, op2' }).operatorAllowlist).toEqual(['op1', 'op2'])
    expect(load({ OPERATOR_ALLOWLIST: '' }).operatorAllowlist).toEqual([])
  })

  it('parses overrides and derives paths from DATA_DIR', () => {
    const config = load({
      PORT: '9090',
      DATA_DIR: '/srv/sandbox',
      SESSION_IDLE_TIMEOUT_MS: '15000',
      SANDBOX_MEMORY_MB: '256',
      DOCKER_IMAGE_POLICY: 'rebuild',
    })
    expect(config.port).toBe(9090)
    expect(config.dataDir).toBe('/srv/sandbox')
    expect(config.dbPath).toContain('sandbox.db')
    expect(config.sessionIdleTimeoutMs).toBe(15000)
    expect(config.sandbox.memoryMb).toBe(256)
    expect(config.docker.imagePolicy).toBe('rebuild')
  })

  it('rejects an unknown execution driver', () => {
    expect(() => load({ EXECUTION_DRIVER: 'kubernetes' })).toThrow(/EXECUTION_DRIVER/)
  })

  it('rejects a non-integer port', () => {
    expect(() => load({ PORT: 'eighty-eighty' })).toThrow(/PORT/)
  })

  it('rejects an invalid image policy', () => {
    expect(() => load({ DOCKER_IMAGE_POLICY: 'cache' })).toThrow(/DOCKER_IMAGE_POLICY/)
  })

  it('defaults the submission settings to the dev gate off and no token', () => {
    const { submission } = load({})
    expect(submission.allowLocalSubmissions).toBe(false)
    expect(submission.gitTimeoutMs).toBe(15_000)
    expect(submission.githubToken).toBeUndefined()
    // The size cap defaults to 25 MB, stored as bytes; the snapshot dir derives from the data dir.
    expect(submission.submissionMaxSizeBytes).toBe(25 * 1024 * 1024)
  })

  it('derives the submissions snapshot dir from the data dir', () => {
    expect(load({}).submissionsDir.endsWith('submissions')).toBe(true)
    // Derived via path.join, so assert membership rather than a separator-specific exact string.
    const derived = load({ DATA_DIR: '/srv/sandbox' }).submissionsDir
    expect(derived.includes('sandbox')).toBe(true)
    expect(derived.endsWith('submissions')).toBe(true)
  })

  it('parses SUBMISSION_MAX_SIZE_MB as megabytes and stores it as bytes', () => {
    expect(load({ SUBMISSION_MAX_SIZE_MB: '100' }).submission.submissionMaxSizeBytes).toBe(
      100 * 1024 * 1024,
    )
    // 0 is accepted (a non-negative int); it means "no tree passes", documented rather than special.
    expect(load({ SUBMISSION_MAX_SIZE_MB: '0' }).submission.submissionMaxSizeBytes).toBe(0)
    expect(() => load({ SUBMISSION_MAX_SIZE_MB: 'big' })).toThrow(/SUBMISSION_MAX_SIZE_MB/)
  })

  it('parses the submission overrides', () => {
    const { submission } = load({
      ALLOW_LOCAL_SUBMISSIONS: 'true',
      SUBMISSION_GIT_TIMEOUT_MS: '5000',
      GITHUB_TOKEN: 'ghp_abc',
    })
    expect(submission.allowLocalSubmissions).toBe(true)
    expect(submission.gitTimeoutMs).toBe(5000)
    expect(submission.githubToken).toBe('ghp_abc')
  })

  it('accepts the documented boolean spellings and rejects anything else', () => {
    expect(load({ ALLOW_LOCAL_SUBMISSIONS: '1' }).submission.allowLocalSubmissions).toBe(true)
    expect(load({ ALLOW_LOCAL_SUBMISSIONS: 'no' }).submission.allowLocalSubmissions).toBe(false)
    expect(() => load({ ALLOW_LOCAL_SUBMISSIONS: 'maybe' })).toThrow(/ALLOW_LOCAL_SUBMISSIONS/)
  })
})
