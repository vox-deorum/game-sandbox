import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvironmentRegistry } from '../../src/environments.js'
import type { UserStatus } from '../../src/identity.js'
import {
  DevelopmentKeyService,
  type DevelopmentKeyStorage,
} from '../../src/llm/development-keys.js'
import { LlmMeter } from '../../src/llm/meter.js'
import type { Storage } from '../../src/storage/index.js'
import { DevelopmentLedgerStore } from '../../src/storage/llm/development-ledger/index.js'
import type { SeasonConfig } from '../../src/storage/season-config.js'
import { openSqlite } from '../../src/storage/sqlite.js'
import { makeTestLlmOptions } from '../support/llm-options.js'

function llmEnvironments(): EnvironmentRegistry {
  const environment = {
    env_id: 'llm_env',
    display_name: 'LLM Environment',
    description: 'test env',
    layout: { kind: 'player_bounds', min: 1, max: 1 },
    human_players: [],
    human_timeout_ms: null,
    recommended_episode_ticks: 100,
    pace_interval_ms: null,
    step_limit_ms: 1_000,
    episode_limit_ms: 60_000,
    messaging: false,
    message_cap: null,
    llm: true,
    renderer: 'test',
    seat_order_matters: false,
    view_interval_ms: null,
    live_interval_ms: null,
    parameters: [
      {
        name: 'players',
        title: 'Players',
        description: 'Number of players.',
        type: 'int',
        default: 1,
        min: 1,
        max: 1,
      },
    ],
  }
  return EnvironmentRegistry.parse(
    JSON.stringify([
      environment,
      { ...environment, env_id: 'llm_env_2', display_name: 'LLM Environment 2' },
    ]),
  )
}

function enabledConfig(
  overrides: Partial<NonNullable<NonNullable<SeasonConfig['overrides']>['llm']>> = {},
): SeasonConfig {
  return {
    deps_version: 1,
    matches: [],
    overrides: { llm: { enabled: true, models: ['small', 'medium'], ...overrides } },
  }
}

describe('DevelopmentKeyService', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  it('returns plaintext once, persists only its hash, rotates both parts, and survives restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gs-development-keys-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const dbPath = join(root, 'app.sqlite')
    let handle = await openSqlite(dbPath)
    cleanups.push(async () => handle.storage.close())
    const ledger = new DevelopmentLedgerStore(join(root, 'ledger'))
    cleanups.push(() => ledger.close())
    const season = await handle.storage.createSeason({ env_id: 'llm_env', deps_version: 1 })
    await handle.storage.updateSeasonConfig(season.id, enabledConfig())
    await handle.storage.setSubmissionStatus(season.id, 'open')

    let byte = 0
    const serviceFor = (storage: Storage): DevelopmentKeyService =>
      new DevelopmentKeyService({
        storage,
        environments: llmEnvironments(),
        llm: {
          ...makeTestLlmOptions(),
          upstreamUrl: 'https://provider.test/v1',
          models: {
            small: { upstream: 'provider-small', costWeight: 1 },
            medium: { upstream: 'provider-medium', costWeight: 2 },
          },
        },
        ledger,
        publicOrigin: 'https://sandbox.test',
        readUserStatus: async () => 'normal',
        now: () => new Date('2026-07-16T01:02:03.000Z'),
        random: (bytes) => Buffer.alloc(bytes, ++byte),
      })

    let service = serviceFor(handle.storage)
    const first = await service.rotate(season.id, 'user-a')
    const [firstKeyId, firstSecret] = first.api_key.replace('sk-sandbox-dev-', '').split('.')
    const storedFirst = await handle.storage.getDevelopmentKey(season.id, 'user-a')
    expect(first).toMatchObject({
      season_id: season.id,
      base_url: 'https://sandbox.test/api/llm/v1',
      models: ['medium', 'small'],
      cost_weights: { medium: 2, small: 1 },
      limits: { token_budget: 100_000, rate_limit_rpm: 30 },
    })
    expect(storedFirst).toMatchObject({
      key_id: firstKeyId,
      secret_hash: createHash('sha256')
        .update(firstSecret as string)
        .digest('hex'),
      rotated_at: null,
    })
    expect(JSON.stringify(storedFirst)).not.toContain(first.api_key)
    expect(JSON.stringify(storedFirst)).not.toContain(firstSecret)

    const second = await service.rotate(season.id, 'user-a')
    const storedSecond = await handle.storage.getDevelopmentKey(season.id, 'user-a')
    expect(storedSecond?.key_id).not.toBe(firstKeyId)
    expect(storedSecond?.secret_hash).not.toBe(storedFirst?.secret_hash)
    expect(storedSecond?.created_at).toBe(storedFirst?.created_at)
    expect(storedSecond?.rotated_at).toBe('2026-07-16T01:02:03.000Z')
    await expect(service.authenticate(first.api_key)).rejects.toMatchObject({
      code: 'invalid_api_key',
    })

    await handle.storage.close()
    handle = await openSqlite(dbPath)
    service = serviceFor(handle.storage)
    await expect(service.authenticate(second.api_key)).resolves.toMatchObject({
      kind: 'development',
      accountingScope: { key: `development:${season.id}:user-a` },
    })
  })

  it('uses one indexed key-id lookup and applies current account and season policy on every auth', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gs-development-auth-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const handle = await openSqlite(join(root, 'app.sqlite'))
    cleanups.push(() => handle.storage.close())
    const ledger = new DevelopmentLedgerStore(join(root, 'ledger'))
    cleanups.push(() => ledger.close())
    const season = await handle.storage.createSeason({ env_id: 'llm_env', deps_version: 1 })
    await handle.storage.updateSeasonConfig(season.id, enabledConfig())
    let status: UserStatus | null = 'normal'
    const lookup = vi.fn(handle.storage.getDevelopmentKeyByKeyId.bind(handle.storage))
    const storage: DevelopmentKeyStorage = {
      getSeason: handle.storage.getSeason.bind(handle.storage),
      rotateDevelopmentKey: handle.storage.rotateDevelopmentKey.bind(handle.storage),
      getDevelopmentKeyByKeyId: lookup,
    }
    const llm = {
      ...makeTestLlmOptions(),
      upstreamUrl: 'https://provider.test/v1',
      models: {
        small: { upstream: 'provider-small', costWeight: 1 },
        medium: { upstream: 'provider-medium', costWeight: 2 },
      },
    }
    const service = new DevelopmentKeyService({
      storage,
      environments: llmEnvironments(),
      llm,
      ledger,
      publicOrigin: 'https://sandbox.test',
      readUserStatus: async () => status,
      random: (bytes) => Buffer.alloc(bytes, bytes),
    })
    await expect(service.rotate(season.id, 'user-a')).rejects.toMatchObject({
      status: 403,
      code: 'development_closed',
    })
    await handle.storage.setSubmissionStatus(season.id, 'open')
    const credential = (await service.rotate(season.id, 'user-a')).api_key
    lookup.mockClear()

    const grant = await service.authenticate(credential)
    expect(lookup).toHaveBeenCalledOnce()
    expect(grant).toMatchObject({
      models: {
        small: { upstream: 'provider-small', costWeight: 1 },
        medium: { upstream: 'provider-medium', costWeight: 2 },
      },
      accountingScope: {
        key: `development:${season.id}:user-a`,
        limits: { tokenBudget: 100_000, requestsPerMinute: 30 },
        weights: { small: 1, medium: 2 },
      },
    })
    const queryPlan = handle.sqlite
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM llm_development_keys WHERE key_id = ?')
      .all('public-id') as Array<{ detail: string }>
    expect(queryPlan.some((row) => row.detail.includes('llm_development_keys_key_id'))).toBe(true)

    await handle.storage.setSubmissionStatus(season.id, 'closed')
    await expect(service.authenticate(credential)).rejects.toMatchObject({
      status: 403,
      code: 'development_closed',
    })
    await handle.storage.setSubmissionStatus(season.id, 'open')
    await expect(service.authenticate(credential)).resolves.toMatchObject({ kind: 'development' })

    status = 'pending'
    await expect(service.authenticate(credential)).rejects.toMatchObject({
      status: 403,
      code: 'account_not_active',
    })
    status = null
    await expect(service.authenticate(credential)).rejects.toMatchObject({
      status: 403,
      code: 'account_not_active',
    })
    status = 'admin'
    await handle.storage.updateSeasonConfig(
      season.id,
      enabledConfig({ models: ['small'], development: { token_budget: 50, rate_limit_rpm: 1 } }),
    )
    await expect(service.authenticate(credential)).resolves.toMatchObject({
      models: { small: { upstream: 'provider-small', costWeight: 1 } },
      accountingScope: {
        limits: { tokenBudget: 50, requestsPerMinute: 1 },
        weights: { small: 1 },
      },
    })
    await handle.storage.updateSeasonConfig(season.id, enabledConfig({ enabled: false }))
    await expect(service.authenticate(credential)).rejects.toMatchObject({
      status: 403,
      code: 'llm_not_enabled',
    })
  })

  it('keeps meter scope and rate history on the user-season pair across rotation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gs-development-scope-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const handle = await openSqlite(':memory:')
    cleanups.push(() => handle.storage.close())
    const ledger = new DevelopmentLedgerStore(join(root, 'ledger'))
    cleanups.push(() => ledger.close())
    const meter = new LlmMeter({ now: () => 1_000 })
    const firstSeason = await handle.storage.createSeason({ env_id: 'llm_env', deps_version: 1 })
    const secondSeason = await handle.storage.createSeason({ env_id: 'llm_env_2', deps_version: 1 })
    await handle.storage.updateSeasonConfig(firstSeason.id, enabledConfig())
    await handle.storage.updateSeasonConfig(secondSeason.id, enabledConfig())
    await handle.storage.setSubmissionStatus(firstSeason.id, 'open')
    await handle.storage.setSubmissionStatus(secondSeason.id, 'open')
    let byte = 0
    const service = new DevelopmentKeyService({
      storage: handle.storage,
      environments: llmEnvironments(),
      llm: {
        ...makeTestLlmOptions(),
        upstreamUrl: 'https://provider.test/v1',
        models: {
          small: { upstream: 'provider-small', costWeight: 1 },
          medium: { upstream: 'provider-medium', costWeight: 2 },
        },
      },
      ledger,
      publicOrigin: 'https://sandbox.test',
      readUserStatus: async () => 'normal',
      random: (bytes) => Buffer.alloc(bytes, ++byte),
    })
    const first = await service.authenticate(
      (await service.rotate(firstSeason.id, 'user-a')).api_key,
    )
    // A successful call would record one rate event; the window is keyed by scope, so it must survive
    // a key rotation for the same participant and season.
    const reservation = await meter.reserve(first.accountingScope, 'small', 1, 1)
    meter.recordRateEvent(reservation)
    meter.release(reservation)
    const rotated = await service.authenticate(
      (await service.rotate(firstSeason.id, 'user-a')).api_key,
    )
    const otherUser = await service.authenticate(
      (await service.rotate(firstSeason.id, 'user-b')).api_key,
    )
    const otherSeason = await service.authenticate(
      (await service.rotate(secondSeason.id, 'user-a')).api_key,
    )

    expect(rotated.accountingScope.key).toBe(first.accountingScope.key)
    expect(meter.inspect(rotated.accountingScope.key).rateEvents).toEqual([1_000])
    expect(otherUser.accountingScope.key).not.toBe(rotated.accountingScope.key)
    expect(otherSeason.accountingScope.key).not.toBe(rotated.accountingScope.key)
    expect(meter.inspect(otherUser.accountingScope.key).rateEvents).toEqual([])
    expect(meter.inspect(otherSeason.accountingScope.key).rateEvents).toEqual([])
  })
})
