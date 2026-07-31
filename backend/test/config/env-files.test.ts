import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadEnvironmentFiles } from '../../src/config/env-files.js'

describe('loadEnvironmentFiles', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function root(): string {
    const path = mkdtempSync(join(tmpdir(), 'game-sandbox-env-'))
    roots.push(path)
    return path
  }

  it('loads local values over defaults while preserving supplied values', () => {
    const directory = root()
    writeFileSync(
      join(directory, '.env.default'),
      'DEFAULT_ONLY=from-default\nSHARED=from-default\nPARENT_WINS=from-default\n',
    )
    writeFileSync(join(directory, '.env'), 'LOCAL_ONLY=from-local\nSHARED=from-local\n')
    const env = { PARENT_WINS: 'from-parent', MASKED: undefined }

    expect(loadEnvironmentFiles({ env, root: directory })).toEqual({
      DEFAULT_ONLY: 'from-default',
      LOCAL_ONLY: 'from-local',
      MASKED: undefined,
      PARENT_WINS: 'from-parent',
      SHARED: 'from-local',
    })
  })

  it('requires the tracked default file', () => {
    expect(() => loadEnvironmentFiles({ env: {}, root: root() })).toThrow(/\.env\.default/)
  })

  it('allows the local file to be absent or explicitly skipped', () => {
    const directory = root()
    writeFileSync(join(directory, '.env.default'), 'DEFAULT_ONLY=value\n')
    writeFileSync(join(directory, '.env'), 'LOCAL_ONLY=value\n')

    expect(loadEnvironmentFiles({ env: {}, root: directory, includeLocal: false })).toEqual({
      DEFAULT_ONLY: 'value',
    })
  })
})
