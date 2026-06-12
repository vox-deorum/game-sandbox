import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('applies class-scale defaults from an empty environment', () => {
    const config = loadConfig({})
    expect(config.port).toBe(8080)
    expect(config.executionDriver).toBe('docker')
    expect(config.docker.imagePolicy).toBe('reuse')
    expect(config.docker.imageTagPrefix).toBe('game-sandbox')
    expect(config.sandbox).toEqual({ cpus: 1, memoryMb: 512, scratchMb: 256 })
    // The db and recordings paths are derived from the data dir.
    expect(config.dbPath.endsWith('sandbox.db')).toBe(true)
    expect(config.recordingsDir.endsWith('recordings')).toBe(true)
    // A fresh checkout plays out of the box: the dev user is allowlisted by default.
    expect(config.sessionAllowlist).toEqual(['dev-user'])
    // The retention spec's defaults: 30-day window, 100 per user, hourly sweep.
    expect(config.recordingRetentionDays).toBe(30)
    expect(config.recordingUserQuota).toBe(100)
    expect(config.recordingSweepIntervalMs).toBe(3_600_000)
  })

  it('parses the retention overrides', () => {
    const config = loadConfig({
      RECORDING_RETENTION_DAYS: '7',
      RECORDING_USER_QUOTA: '5',
      RECORDING_SWEEP_INTERVAL_MS: '60000',
    })
    expect(config.recordingRetentionDays).toBe(7)
    expect(config.recordingUserQuota).toBe(5)
    expect(config.recordingSweepIntervalMs).toBe(60000)
  })

  it('parses SESSION_ALLOWLIST as a trimmed comma-separated list', () => {
    expect(loadConfig({ SESSION_ALLOWLIST: 'alice, bob ,carol' }).sessionAllowlist).toEqual([
      'alice',
      'bob',
      'carol',
    ])
    // An explicitly empty value is an empty allowlist (no one may start a session).
    expect(loadConfig({ SESSION_ALLOWLIST: '' }).sessionAllowlist).toEqual([])
  })

  it('parses overrides and derives paths from DATA_DIR', () => {
    const config = loadConfig({
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
    expect(() => loadConfig({ EXECUTION_DRIVER: 'kubernetes' })).toThrow(/EXECUTION_DRIVER/)
  })

  it('rejects a non-integer port', () => {
    expect(() => loadConfig({ PORT: 'eighty-eighty' })).toThrow(/PORT/)
  })

  it('rejects an invalid image policy', () => {
    expect(() => loadConfig({ DOCKER_IMAGE_POLICY: 'cache' })).toThrow(/DOCKER_IMAGE_POLICY/)
  })
})
