/**
 * Stage 9.7 regression coverage for the environments that must remain deterministic when LLM
 * access resolves to disabled. This deliberately runs through the real orchestrator and registry,
 * while keeping the Docker boundary fake so it can pin the launch contract in the normal unit lane.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EnvironmentRegistry } from '../../src/environments.js'
import type { ResolvedLlm } from '../../src/llm/config.js'
import { Orchestrator } from '../../src/session/orchestrator.js'
import type { Storage } from '../../src/storage/index.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'
import { FakeDriver } from '../support/fake-driver.js'
import { makeConfig } from '../support/harness.js'

const DISABLED_POLICY: ResolvedLlm = {
  enabled: false,
  models: {},
  official: { tokenBudget: 100_000, requestsPerMinute: 60 },
  development: { tokenBudget: 100_000, requestsPerMinute: 30 },
}

const CASES = [
  {
    envId: 'flappy_bird',
    slots: { player_0: { kind: 'builtin-agent' as const } },
    messaging: { enabled: false, cap: null },
  },
  {
    envId: 'spades',
    slots: {
      player_0: { kind: 'builtin-agent' as const },
      player_1: { kind: 'builtin-agent' as const },
      player_2: { kind: 'builtin-agent' as const },
      player_3: { kind: 'builtin-agent' as const },
    },
    messaging: { enabled: true, cap: 120 },
  },
] as const

describe('disabled LLM session regression', () => {
  let storage: Storage
  let driver: FakeDriver
  let orchestrator: Orchestrator
  let recordingsDir: string
  let issuedGrants: number
  const seasons = new Map<string, string>()

  beforeEach(async () => {
    storage = await openSqliteStorage(':memory:')
    driver = new FakeDriver()
    recordingsDir = mkdtempSync(join(tmpdir(), 'gs-disabled-llm-session-'))
    issuedGrants = 0

    const config = makeConfig({
      recordingsDir,
      // Keep deployment wiring available. The injected resolver is the effective policy a session
      // receives, so this verifies that disabled access wins over otherwise configured LLM settings.
      llm: {
        ...makeConfig().llm,
        upstreamUrl: 'http://upstream.example.test/v1',
        upstreamKey: 'upstream-secret',
        models: { small: { upstream: 'provider-small', costWeight: 1 } },
      },
    })
    const environments = EnvironmentRegistry.load()
    for (const { envId } of CASES) {
      const season = await storage.ensureOpenSeason(envId, 1)
      seasons.set(envId, season.id)
    }
    orchestrator = new Orchestrator({
      driver,
      storage,
      environments,
      config,
      resolveLiveLlm: () => DISABLED_POLICY,
      officialGrantIssuer: {
        issue: async () => {
          issuedGrants += 1
          return { keys: {}, revoke: async () => {} }
        },
      },
    })
  })

  afterEach(async () => {
    await orchestrator.shutdown()
    await storage.close()
    rmSync(recordingsDir, { recursive: true, force: true })
  })

  it.each(
    CASES,
  )('keeps $envId on the ordinary sandbox and harness launch contract when access is disabled', async ({
    envId,
    slots,
    messaging,
  }) => {
    const started = await orchestrator.start({
      userId: 'alice',
      envId,
      seasonId: seasons.get(envId) ?? 'missing',
      parameters: envId === 'spades' ? { seats: 4 } : { seats: 1, pipe_gap: 100 },
      seed: 7,
      slots,
    })
    const launch = driver.lastLaunch()
    if (launch === undefined) throw new Error('expected a session launch')
    const config = JSON.parse(launch.spec.argv[0] ?? '{}') as Record<string, unknown>

    expect(issuedGrants).toBe(0)
    expect(launch.spec.sandbox.network).toBe('none')
    // LaunchSpec has no environment map. Its absence prevents disabled sessions from gaining
    // injected OpenAI variables through the orchestration boundary.
    expect(Object.hasOwn(launch.spec, 'environment')).toBe(false)
    expect(config).not.toHaveProperty('llm')
    expect(config).toMatchObject({
      env_id: envId,
      seed: 7,
      slots,
      recording_dir: '/recordings',
      recording_id: `${envId}-${started.id}`,
      messaging_enabled: messaging.enabled,
      message_cap: messaging.cap,
    })
    // The public launch config has no hook-order field. Its ordinary slot/messaging/recording
    // shape is therefore the observable contract this test can pin without inventing a hook seam.
    expect(Object.hasOwn(config, 'hooks')).toBe(false)
    expect((await storage.getSession(started.id))?.llm_enabled).toBe(0)
  })
})
