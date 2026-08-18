import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LLM_KEYS_CONTAINER_PATH } from '../../src/session/llm-keys-file.js'
import { LlmLeaseHandle } from '../../src/session/llm-lease.js'
import type {
  IssueOfficialGrantsInput,
  OfficialGrantIssuer,
} from '../../src/session/official-grants.js'

/** A fake issuer returning the given key map, recording the issue input and counting revocations. */
function fakeIssuer(keys: Record<string, string>): {
  issue: OfficialGrantIssuer['issue']
  issued: () => IssueOfficialGrantsInput | undefined
  revocations: () => number
} {
  let issued: IssueOfficialGrantsInput | undefined
  let revocations = 0
  return {
    issue: async (input) => {
      issued = input
      return {
        keys,
        revoke: () => {
          revocations += 1
          return Promise.resolve()
        },
      }
    },
    issued: () => issued,
    revocations: () => revocations,
  }
}

const INPUT: IssueOfficialGrantsInput = {
  sessionId: 'sess-1',
  scopeId: 'scope-1',
  agentPlayers: ['player_0'],
  models: { small: { upstream: 'upstream-small', costWeight: 1 } },
  limits: { tokenBudget: 100, requestsPerMinute: 5 },
}

describe('LlmLeaseHandle', () => {
  let keysDir: string

  beforeEach(() => {
    keysDir = mkdtempSync(join(tmpdir(), 'gs-llm-lease-'))
  })

  afterEach(() => {
    rmSync(keysDir, { recursive: true, force: true })
  })

  it('stages the lease, points the argv at the mounted file, and splices the mount into the profile', async () => {
    const issuer = fakeIssuer({ player_0: 'secret-key' })
    const handle = new LlmLeaseHandle()

    const lease = await handle.stage(issuer, INPUT, keysDir, 'sess-1')
    expect(handle.lease).toBe(lease)
    expect(issuer.issued()).toMatchObject({ sessionId: 'sess-1', agentPlayers: ['player_0'] })

    const base = [{ hostPath: '/recordings', containerPath: '/recordings', readOnly: false }]
    expect(handle.block(9472)).toEqual({
      llm: {
        base_url: 'http://llm-proxy:9472/v1',
        tick_url: 'http://llm-proxy:9472/internal/tick',
        inflight_url: 'http://llm-proxy:9472/internal/inflight',
        keys_file: LLM_KEYS_CONTAINER_PATH,
      },
    })
    expect(handle.withKeysMount(base)).toEqual([
      ...base,
      {
        hostPath: join(keysDir, 'sess-1.json'),
        containerPath: LLM_KEYS_CONTAINER_PATH,
        readOnly: true,
      },
    ])
    await expect(stat(join(keysDir, 'sess-1.json'))).resolves.toBeDefined()
    // The staged file must be world-readable (remembered as `r` for other): the container's root
    // runs with CAP_DAC_READ_SEARCH dropped, so it honors mode bits and could not open a 0600 file
    // owned by the backend's uid (see writeLlmKeysFile). Privacy is the 0700 staging directory.
    await expect(stat(join(keysDir, 'sess-1.json'))).resolves.toMatchObject({ mode: 0o100644 })
  })

  it('teardown removes the staged keys file and revokes the lease together', async () => {
    const issuer = fakeIssuer({ player_0: 'secret-key' })
    const handle = new LlmLeaseHandle()
    await handle.stage(issuer, INPUT, keysDir, 'sess-1')

    const keysPath = join(keysDir, 'sess-1.json')
    await expect(stat(keysPath)).resolves.toBeDefined()
    await handle.teardown()
    await expect(stat(keysPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(issuer.revocations()).toBe(1)
  })

  it('revokes an issued lease whose keys file could not be staged', async () => {
    // A dataDir leaf that is a file makes the staged write fail deterministically after the issue.
    writeFileSync(join(keysDir, 'blocker'), 'occupied')
    const issuer = fakeIssuer({ player_0: 'secret-key' })
    const handle = new LlmLeaseHandle()

    await expect(handle.stage(issuer, INPUT, join(keysDir, 'blocker'), 'sess-1')).rejects.toThrow()
    // The lease was issued but its keys never landed: a single teardown must still revoke it.
    await handle.teardown()
    expect(issuer.revocations()).toBe(1)
  })

  it('exposes an empty block and no extra mount before anything is staged', async () => {
    const handle = new LlmLeaseHandle()
    const base = [{ hostPath: '/recordings', containerPath: '/recordings', readOnly: false }]

    expect(handle.block(9472)).toEqual({})
    expect(handle.withKeysMount(base)).toEqual(base)
    await handle.teardown()
  })
})
