import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KeyRegistry } from '../../src/llm/key-registry.js'
import { LlmLeaseHandle } from '../../src/session/llm-lease.js'
import {
  createOfficialGrantIssuer,
  type IssueOfficialGrantsInput,
  type OfficialGrantIssuer,
} from '../../src/session/official-grants.js'
import { ExecutionTelemetryStore } from '../../src/storage/llm/execution-telemetry.js'

const INPUT: IssueOfficialGrantsInput = {
  sessionId: 'sess-1',
  scopeId: 'scope-1',
  agentPlayers: ['player_0'],
  models: { small: { upstream: 'upstream-small', costWeight: 1 } },
  limits: { tokenBudget: 100, requestsPerMinute: 5 },
}

describe('LlmLeaseHandle', () => {
  let keysDir: string
  let store: ExecutionTelemetryStore
  let registry: KeyRegistry
  let issuer: OfficialGrantIssuer

  beforeEach(() => {
    keysDir = mkdtempSync(join(tmpdir(), 'gs-llm-lease-keys-'))
    store = new ExecutionTelemetryStore(join(keysDir, 'telemetry'))
    registry = new KeyRegistry()
    issuer = createOfficialGrantIssuer(registry, store)
  })

  afterEach(() => {
    store.close()
    rmSync(keysDir, { recursive: true, force: true })
  })

  it('stages the lease, points the argv at the mounted file, and splices the mount into the profile', async () => {
    const handle = new LlmLeaseHandle()
    try {
      const lease = await handle.stage(issuer, INPUT, keysDir, 'sess-1')
      const bearer = lease.keys.player_0
      if (bearer === undefined) throw new Error('expected an issued key for player_0')
      expect(registry.authenticateOfficial(bearer).sessionId).toBe('sess-1')

      const base = [{ hostPath: '/recordings', containerPath: '/recordings', readOnly: false }]
      expect(handle.block(9472)).toEqual({
        llm: {
          base_url: 'http://llm-proxy:9472/v1',
          tick_url: 'http://llm-proxy:9472/internal/tick',
          inflight_url: 'http://llm-proxy:9472/internal/inflight',
          keys_file: '/run/llm-keys.json',
        },
      })
      const mounts = handle.withKeysMount(base)
      expect(mounts).toEqual([
        ...base,
        {
          hostPath: expect.any(String),
          containerPath: '/run/llm-keys.json',
          readOnly: true,
        },
      ])

      const keysMount = mounts[1]
      if (keysMount === undefined) throw new Error('expected a keys-file mount')
      const staged: unknown = JSON.parse(await readFile(keysMount.hostPath, 'utf8'))
      expect(staged).toEqual(lease.keys)

      // The container's root drops CAP_DAC_READ_SEARCH, so it honors mode bits and needs the
      // world-readable bit. The exact mode is 0644 on POSIX and 0666 on Windows.
      const keysFile = await stat(keysMount.hostPath)
      expect(keysFile.mode & 0o004).toBe(0o004)

      await handle.teardown()
      await handle.teardown()
      await expect(readFile(keysMount.hostPath)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(() => registry.authenticateOfficial(bearer)).toThrow(
        expect.objectContaining({ status: 401, code: 'invalid_api_key' }),
      )
    } finally {
      await handle.teardown()
    }
  })

  it('revokes an issued lease whose keys file could not be staged', async () => {
    // A dataDir leaf that is a file makes the staged write fail deterministically after the issue.
    writeFileSync(join(keysDir, 'blocker'), 'occupied')
    const lease = await issuer.issue(INPUT)
    const handle = new LlmLeaseHandle()
    try {
      const bearer = lease.keys.player_0
      if (bearer === undefined) throw new Error('expected an issued key for player_0')
      expect(registry.authenticateOfficial(bearer).sessionId).toBe('sess-1')
      await expect(
        handle.stage({ issue: async () => lease }, INPUT, join(keysDir, 'blocker'), 'sess-1'),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(EEXIST|ENOTDIR)$/) })
      await handle.teardown()
      expect(() => registry.authenticateOfficial(bearer)).toThrow(
        expect.objectContaining({ status: 401, code: 'invalid_api_key' }),
      )
    } finally {
      await handle.teardown()
      await lease.revoke()
    }
  })

  it('exposes an empty block and no extra mount before anything is staged', async () => {
    const handle = new LlmLeaseHandle()
    const base = [{ hostPath: '/recordings', containerPath: '/recordings', readOnly: false }]

    expect(handle.block(9472)).toEqual({})
    expect(handle.withKeysMount(base)).toEqual(base)
    await handle.teardown()
  })
})
