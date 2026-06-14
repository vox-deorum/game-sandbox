/**
 * Opt-in, network-touching coverage for the git submission source: it actually runs `git ls-remote`
 * and a shallow `--depth 1` fetch against a small public repository. It is gated behind
 * `SUBMISSION_NETWORK_TESTS=1` so neither the default unit run (which excludes `test/integration/`)
 * nor the Docker integration job depends on github.com reachability — run it explicitly when
 * validating the real git path. The stubbed unit coverage in `test/submission-source.test.ts` is
 * what runs everywhere.
 */
import { existsSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { createSubmissionSource } from '../../src/submission/source/index.js'

const enabled = process.env.SUBMISSION_NETWORK_TESTS === '1'
// A tiny, stable public repo; override if github.com/octocat is unavailable in a given environment.
const REPO = process.env.SUBMISSION_NETWORK_REPO ?? 'https://github.com/octocat/Hello-World.git'

describe.runIf(enabled)('git submission source against a real public repo', () => {
  const source = createSubmissionSource({
    allowLocalSubmissions: false,
    gitTimeoutMs: 30_000,
    loadCheckTimeoutMs: 30_000,
  })

  it('resolves the default-branch head and shallow-fetches exactly that tree', async () => {
    const resolved = await source.resolve({ kind: 'git', repoUrl: REPO, ref: null })
    expect(resolved.commitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(resolved.resolvedRef).not.toBeNull()
    expect(resolved.repoUrl).toBe(REPO)

    const handle = await source.fetchTree(resolved)
    try {
      expect(existsSync(handle.path)).toBe(true)
    } finally {
      await handle.dispose()
    }
    expect(existsSync(handle.path)).toBe(false)
  }, 60_000)

  it('reports an unreachable repo as not reachable rather than hanging', async () => {
    const result = await source.verifyReachable({
      kind: 'git',
      repoUrl: 'https://github.com/this-org-does-not-exist-zzz/nope.git',
      ref: null,
    })
    expect(result.reachable).toBe(false)
  }, 60_000)
})
