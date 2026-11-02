import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DevelopmentKeyService } from '../../src/llm/development-keys.js'
import type { Storage } from '../../src/storage/index.js'
import { DevelopmentLedgerStore } from '../../src/storage/llm/development-ledger/index.js'
import { openSqlite } from '../../src/storage/sqlite.js'
import { llmEnvironments, makeTestLlmOptions } from '../support/llm-options.js'

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
    await handle.storage.updateSeasonConfig(season.id, {
      deps_version: 1,
      matches: [],
      overrides: { llm: { enabled: true, models: ['small', 'medium'] } },
    })
    await handle.storage.setSubmissionStatus(season.id, 'open')

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
          sessionLimits: { tokenBudget: 250_000, requestsPerMinute: 45 },
          developmentLimits: { tokenBudget: 50_000, requestsPerMinute: 12 },
        },
        ledger,
        publicOrigin: 'https://sandbox.test',
        readUserStatus: async () => 'normal',
      })

    let service = serviceFor(handle.storage)
    const first = await service.rotate(season.id, 'user-a')
    const [firstKeyId, firstSecret] = first.api_key.replace('sk-sandbox-dev-', '').split('.')
    const storedFirst = await handle.storage.getDevelopmentKey(season.id, 'user-a')
    expect(first).toMatchObject({
      season_id: season.id,
      base_url: 'https://sandbox.test/api/llm/v1',
      cost_weights: { medium: 2, small: 1 },
      limits: { token_budget: 50_000, rate_limit_rpm: 12 },
    })
    expect([...first.models].sort()).toEqual(['medium', 'small'])
    expect(storedFirst).toMatchObject({ key_id: firstKeyId })
    expect(storedFirst?.secret_hash).not.toBe(firstSecret)
    expect(JSON.stringify(storedFirst)).not.toContain(first.api_key)
    expect(JSON.stringify(storedFirst)).not.toContain(firstSecret)
    await expect(service.authenticate(first.api_key)).resolves.toMatchObject({
      kind: 'development',
    })
    await expect(
      service.authenticate(`sk-sandbox-dev-${firstKeyId}.${firstSecret}x`),
    ).rejects.toMatchObject({ code: 'invalid_api_key' })

    const second = await service.rotate(season.id, 'user-a')
    const [secondKeyId, secondSecret] = second.api_key.replace('sk-sandbox-dev-', '').split('.')
    const storedSecond = await handle.storage.getDevelopmentKey(season.id, 'user-a')
    expect(secondKeyId).not.toBe(firstKeyId)
    expect(secondSecret).not.toBe(firstSecret)
    expect(storedSecond?.key_id).toBe(secondKeyId)
    expect(storedSecond?.secret_hash).not.toBe(storedFirst?.secret_hash)
    expect(JSON.stringify(storedSecond)).not.toContain(second.api_key)
    expect(JSON.stringify(storedSecond)).not.toContain(secondSecret)
    await expect(service.authenticate(first.api_key)).rejects.toMatchObject({
      code: 'invalid_api_key',
    })

    await handle.storage.close()
    handle = await openSqlite(dbPath)
    service = serviceFor(handle.storage)
    await expect(service.authenticate(second.api_key)).resolves.toMatchObject({
      kind: 'development',
    })
  })
})
