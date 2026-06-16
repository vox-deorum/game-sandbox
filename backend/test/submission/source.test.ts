/**
 * Unit coverage for the submission source seam (Stage 5.2), entirely Docker- and network-free: the
 * local-folder source runs against a checked-in fixture tree, and the git source's `ls-remote`/fetch
 * behaviour is driven through a stubbed {@link GitRunner} and a stubbed {@link GitHubClient}. The
 * opt-in test that talks to a real public repo lives with the other network-touching suites.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { SubmissionOptions } from '../../src/config.js'
import {
  createSubmissionSource,
  type GitHubClient,
  type GitHubRepo,
  type GitResult,
  type GitRunner,
  GitTimeoutError,
  parseGitHubRepo,
  SourceError,
  tokenizedUrl,
} from '../../src/submission/source/index.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sources')
const LOCAL_BASIC = join(FIXTURES, 'local-basic')

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

/** A programmable git CLI stub: the handler maps an invocation's argv to its captured result. */
class FakeGitRunner implements GitRunner {
  readonly calls: Array<{ args: string[]; cwd?: string }> = []
  constructor(private readonly handler: (args: string[]) => GitResult | Promise<GitResult>) {}
  async run(args: string[], opts?: { cwd?: string }): Promise<GitResult> {
    this.calls.push({ args, cwd: opts?.cwd })
    return await this.handler(args)
  }
}

/** A git stub that fails every invocation; used where the github client should answer instead. */
const unusedRunner: GitRunner = {
  run: () => Promise.reject(new Error('the runner should not be called on this path')),
}

/** A github client stub recording its calls and returning a fixed result. */
function fakeGitHubClient(
  result: Awaited<ReturnType<GitHubClient['checkRepo']>>,
): GitHubClient & { calls: GitHubRepo[] } {
  const calls: GitHubRepo[] = []
  return {
    calls,
    checkRepo: (repo) => {
      calls.push(repo)
      return Promise.resolve(result)
    },
  }
}

function ok(stdout: string): GitResult {
  return { code: 0, stdout, stderr: '' }
}

function config(overrides: Partial<SubmissionOptions> = {}): SubmissionOptions {
  return {
    allowLocalSubmissions: false,
    gitTimeoutMs: 15_000,
    loadCheckTimeoutMs: 30_000,
    ...overrides,
  }
}

describe('parseGitHubRepo and tokenizedUrl', () => {
  it('parses github https URLs and ignores other hosts and schemes', () => {
    expect(parseGitHubRepo('https://github.com/alice/agent')).toEqual({
      owner: 'alice',
      repo: 'agent',
    })
    expect(parseGitHubRepo('https://github.com/alice/agent.git')).toEqual({
      owner: 'alice',
      repo: 'agent',
    })
    expect(parseGitHubRepo('https://gitlab.com/alice/agent')).toBeNull()
    expect(parseGitHubRepo('git@github.com:alice/agent.git')).toBeNull()
    expect(parseGitHubRepo('https://github.com/alice')).toBeNull()
    expect(parseGitHubRepo('https://github.com/alice/agent/tree/main')).toBeNull()
  })

  it('injects the token only for github https URLs and leaves the clean URL untouched', () => {
    const clean = 'https://github.com/alice/agent.git'
    const tokenized = tokenizedUrl(clean, 'secrettoken')
    expect(tokenized).toContain('x-access-token:secrettoken@github.com')
    // The clean URL the caller holds is never mutated.
    expect(clean).toBe('https://github.com/alice/agent.git')
    // No token, non-github host, or empty token all return the URL unchanged.
    expect(tokenizedUrl(clean, undefined)).toBe(clean)
    expect(tokenizedUrl('https://gitlab.com/alice/agent.git', 'secrettoken')).toBe(
      'https://gitlab.com/alice/agent.git',
    )
  })
})

describe('git source resolution', () => {
  it('pins the default-branch head when no ref is given', async () => {
    const runner = new FakeGitRunner((args) => {
      expect(args).toContain('--symref')
      return ok(`ref: refs/heads/main\tHEAD\n${SHA_A}\tHEAD\n`)
    })
    const source = createSubmissionSource(config(), { gitRunner: runner })
    const resolved = await source.resolve({
      kind: 'git',
      repoUrl: 'https://example.com/alice/agent.git',
      ref: null,
    })
    expect(resolved).toMatchObject({
      kind: 'git',
      repoUrl: 'https://example.com/alice/agent.git',
      commitSha: SHA_A,
      ref: null,
      resolvedRef: 'main',
      localPath: null,
    })
  })

  it('pins a branch ref to its advertised commit', async () => {
    const runner = new FakeGitRunner(() => ok(`${SHA_A}\trefs/heads/dev\n`))
    const source = createSubmissionSource(config(), { gitRunner: runner })
    const resolved = await source.resolve({
      kind: 'git',
      repoUrl: 'https://example.com/alice/agent.git',
      ref: 'dev',
    })
    expect(resolved.commitSha).toBe(SHA_A)
    expect(resolved.resolvedRef).toBe('dev')
    expect(resolved.ref).toBe('dev')
  })

  it('prefers the peeled target of an annotated tag', async () => {
    const runner = new FakeGitRunner(() =>
      // The tag object SHA, then the peeled commit it points at.
      ok(`${SHA_B}\trefs/tags/v1.0\n${SHA_A}\trefs/tags/v1.0^{}\n`),
    )
    const source = createSubmissionSource(config(), { gitRunner: runner })
    const resolved = await source.resolve({
      kind: 'git',
      repoUrl: 'https://example.com/alice/agent.git',
      ref: 'v1.0',
    })
    expect(resolved.commitSha).toBe(SHA_A)
    expect(resolved.resolvedRef).toBe('v1.0')
  })

  it('pins an explicit full commit SHA without an ls-remote round trip', async () => {
    const runner = new FakeGitRunner(() => {
      throw new Error('ls-remote must not run for an explicit SHA')
    })
    const source = createSubmissionSource(config(), { gitRunner: runner })
    const resolved = await source.resolve({
      kind: 'git',
      repoUrl: 'https://example.com/alice/agent.git',
      ref: SHA_A.toUpperCase(),
    })
    expect(resolved.commitSha).toBe(SHA_A)
    expect(resolved.resolvedRef).toBeNull()
    expect(runner.calls).toHaveLength(0)
  })

  it('surfaces a non-resolving ref as ref_not_found', async () => {
    const runner = new FakeGitRunner(() => ok(''))
    const source = createSubmissionSource(config(), { gitRunner: runner })
    await expect(
      source.resolve({ kind: 'git', repoUrl: 'https://example.com/alice/agent.git', ref: 'nope' }),
    ).rejects.toMatchObject({ failure: 'ref_not_found' })
  })

  it('classifies an unreachable host as unreachable', async () => {
    const runner = new FakeGitRunner(() => ({
      code: 128,
      stdout: '',
      stderr: 'fatal: could not resolve host: example.com',
    }))
    const source = createSubmissionSource(config(), { gitRunner: runner })
    await expect(
      source.resolve({ kind: 'git', repoUrl: 'https://example.com/alice/agent.git', ref: null }),
    ).rejects.toMatchObject({ failure: 'unreachable' })
  })

  it('classifies an auth-walled repo as auth_required', async () => {
    const runner = new FakeGitRunner(() => ({
      code: 128,
      stdout: '',
      stderr: "fatal: Authentication failed for 'https://example.com/alice/agent.git/'",
    }))
    const source = createSubmissionSource(config(), { gitRunner: runner })
    await expect(
      source.resolve({ kind: 'git', repoUrl: 'https://example.com/alice/agent.git', ref: null }),
    ).rejects.toMatchObject({ failure: 'auth_required' })
  })

  it('maps a git timeout to a timeout failure', async () => {
    const runner = new FakeGitRunner(() => Promise.reject(new GitTimeoutError(15_000)))
    const source = createSubmissionSource(config(), { gitRunner: runner })
    await expect(
      source.resolve({ kind: 'git', repoUrl: 'https://example.com/alice/agent.git', ref: null }),
    ).rejects.toMatchObject({ failure: 'timeout' })
  })

  it('rejects a non-http(s) URL as invalid_input before shelling out', async () => {
    const runner = new FakeGitRunner(() => {
      throw new Error('the runner must not run for an invalid URL')
    })
    const source = createSubmissionSource(config(), { gitRunner: runner })
    await expect(
      source.resolve({ kind: 'git', repoUrl: 'git@github.com:alice/agent.git', ref: null }),
    ).rejects.toMatchObject({ failure: 'invalid_input' })
    expect(runner.calls).toHaveLength(0)
  })
})

describe('git source credentials', () => {
  it('shells out with the tokenized URL but stores and reports only the clean URL', async () => {
    const token = 'ghp_secrettoken'
    const clean = 'https://github.com/alice/agent.git'
    const runner = new FakeGitRunner(() => ok(`ref: refs/heads/main\tHEAD\n${SHA_A}\tHEAD\n`))
    const source = createSubmissionSource(config({ githubToken: token }), {
      gitRunner: runner,
      githubClient: fakeGitHubClient({ reachable: true }),
    })
    const resolved = await source.resolve({ kind: 'git', repoUrl: clean, ref: null })
    // git is invoked with credentials...
    expect(runner.calls[0]?.args.some((arg) => arg.includes(`x-access-token:${token}`))).toBe(true)
    // ...but the stored pinning facts never carry the token.
    expect(resolved.repoUrl).toBe(clean)
    expect(JSON.stringify(resolved)).not.toContain(token)
  })

  it('redacts nothing into the error message when git echoes the tokenized URL', async () => {
    const token = 'ghp_secrettoken'
    const runner = new FakeGitRunner(() => ({
      code: 128,
      stdout: '',
      stderr: `fatal: unable to access 'https://x-access-token:${token}@github.com/alice/agent.git/'`,
    }))
    const source = createSubmissionSource(config({ githubToken: token }), {
      gitRunner: runner,
      githubClient: fakeGitHubClient({ reachable: true }),
    })
    const error = await source
      .resolve({ kind: 'git', repoUrl: 'https://github.com/alice/agent.git', ref: null })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SourceError)
    expect((error as SourceError).message).not.toContain(token)
  })
})

describe('git source reachability', () => {
  it('uses the github REST client for github URLs before checking the default HEAD', async () => {
    const client = fakeGitHubClient({ reachable: true })
    const runner = new FakeGitRunner((args) => {
      expect(args).toEqual(['ls-remote', '--symref', 'https://github.com/alice/agent.git', 'HEAD'])
      return ok(`ref: refs/heads/main\tHEAD\n${SHA_A}\tHEAD\n`)
    })
    const source = createSubmissionSource(config(), {
      gitRunner: runner,
      githubClient: client,
    })
    const result = await source.verifyReachable({
      kind: 'git',
      repoUrl: 'https://github.com/alice/agent.git',
      ref: null,
    })
    expect(result.reachable).toBe(true)
    expect(client.calls).toEqual([{ owner: 'alice', repo: 'agent' }])
    expect(runner.calls).toHaveLength(1)
  })

  it('short-circuits github reachability when the REST client rejects the repo', async () => {
    const client = fakeGitHubClient({ reachable: false, failure: 'auth_required' })
    const source = createSubmissionSource(config(), {
      gitRunner: unusedRunner,
      githubClient: client,
    })
    const result = await source.verifyReachable({
      kind: 'git',
      repoUrl: 'https://github.com/alice/agent.git',
      ref: null,
    })
    expect(result).toMatchObject({ reachable: false, failure: 'auth_required' })
    expect(client.calls).toEqual([{ owner: 'alice', repo: 'agent' }])
  })

  it('falls back to ls-remote for non-github hosts', async () => {
    const runner = new FakeGitRunner((args) => {
      expect(args[0]).toBe('ls-remote')
      return ok(`${SHA_A}\tHEAD\n`)
    })
    const source = createSubmissionSource(config(), { gitRunner: runner })
    const result = await source.verifyReachable({
      kind: 'git',
      repoUrl: 'https://example.com/alice/agent.git',
      ref: null,
    })
    expect(result.reachable).toBe(true)
  })

  it('checks a named ref during reachability and reports a missing one', async () => {
    const runner = new FakeGitRunner((args) => {
      expect(args).toEqual([
        'ls-remote',
        'https://example.com/alice/agent.git',
        'dev',
        'refs/heads/dev',
        'refs/tags/dev',
      ])
      return ok('')
    })
    const source = createSubmissionSource(config(), { gitRunner: runner })
    const result = await source.verifyReachable({
      kind: 'git',
      repoUrl: 'https://example.com/alice/agent.git',
      ref: 'dev',
    })
    expect(result).toMatchObject({ reachable: false, failure: 'ref_not_found' })
  })
})

describe('git source fetchTree', () => {
  it('checks out the pinned commit and verifies HEAD, then disposes the temp tree', async () => {
    const runner = new FakeGitRunner((args) => {
      if (args[0] === 'rev-parse') {
        return ok(`${SHA_A}\n`)
      }
      return ok('')
    })
    const source = createSubmissionSource(config(), { gitRunner: runner })
    const handle = await source.fetchTree({
      kind: 'git',
      repoUrl: 'https://example.com/alice/agent.git',
      commitSha: SHA_A,
      ref: null,
      resolvedRef: 'main',
      localPath: null,
    })
    expect(existsSync(handle.path)).toBe(true)
    // It fetched at depth 1 by the resolved ref name, not the bare SHA.
    const fetchCall = runner.calls.find((call) => call.args[0] === 'fetch')
    expect(fetchCall?.args).toEqual(expect.arrayContaining(['--depth', '1', 'main']))
    await handle.dispose()
    expect(existsSync(handle.path)).toBe(false)
    // dispose is idempotent.
    await expect(handle.dispose()).resolves.toBeUndefined()
  })

  it('fails and cleans up when the fetched HEAD does not match the pinned commit', async () => {
    const runner = new FakeGitRunner((args) => {
      if (args[0] === 'rev-parse') {
        return ok(`${SHA_B}\n`)
      }
      return ok('')
    })
    const source = createSubmissionSource(config(), { gitRunner: runner })
    let capturedPath: string | undefined
    const original = runner.run.bind(runner)
    runner.run = async (args, opts) => {
      const result = await original(args, opts)
      if (opts?.cwd !== undefined) {
        capturedPath = opts.cwd
      }
      return result
    }
    await expect(
      source.fetchTree({
        kind: 'git',
        repoUrl: 'https://example.com/alice/agent.git',
        commitSha: SHA_A,
        ref: null,
        resolvedRef: 'main',
        localPath: null,
      }),
    ).rejects.toMatchObject({ failure: 'ref_not_found' })
    // The temp tree is removed even though the pipeline threw.
    expect(capturedPath !== undefined && existsSync(capturedPath)).toBe(false)
  })

  it('reports an unfetchable pinned commit as ref_not_found and cleans up', async () => {
    const runner = new FakeGitRunner((args) => {
      if (args[0] === 'fetch') {
        return {
          code: 128,
          stdout: '',
          stderr: `fatal: couldn't find remote ref ${SHA_A}`,
        }
      }
      return ok('')
    })
    const source = createSubmissionSource(config(), { gitRunner: runner })
    let capturedPath: string | undefined
    const original = runner.run.bind(runner)
    runner.run = async (args, opts) => {
      const result = await original(args, opts)
      if (opts?.cwd !== undefined) {
        capturedPath = opts.cwd
      }
      return result
    }
    await expect(
      source.fetchTree({
        kind: 'git',
        repoUrl: 'https://example.com/alice/agent.git',
        commitSha: SHA_A,
        ref: SHA_A,
        resolvedRef: null,
        localPath: null,
      }),
    ).rejects.toMatchObject({ failure: 'ref_not_found' })
    expect(capturedPath !== undefined && existsSync(capturedPath)).toBe(false)
  })
})

describe('local source (dev gate)', () => {
  it('resolves a fixture folder to commitless local metadata and fetches it directly', async () => {
    const source = createSubmissionSource(config({ allowLocalSubmissions: true }))
    const resolved = await source.resolve({ kind: 'local', localPath: LOCAL_BASIC })
    expect(resolved).toMatchObject({
      kind: 'local',
      repoUrl: null,
      commitSha: null,
      ref: null,
      resolvedRef: null,
      localPath: resolve(LOCAL_BASIC),
    })
    const handle = await source.fetchTree(resolved)
    expect(handle.path).toBe(resolve(LOCAL_BASIC))
    // dispose never deletes a developer's folder.
    await handle.dispose()
    expect(existsSync(join(LOCAL_BASIC, 'agent.py'))).toBe(true)
  })

  it('reports a reachable fixture folder and an unreachable missing path', async () => {
    const source = createSubmissionSource(config({ allowLocalSubmissions: true }))
    expect(await source.verifyReachable({ kind: 'local', localPath: LOCAL_BASIC })).toEqual({
      reachable: true,
    })
    const missing = await source.verifyReachable({
      kind: 'local',
      localPath: join(FIXTURES, 'does-not-exist'),
    })
    expect(missing).toMatchObject({ reachable: false, failure: 'unreachable' })
  })

  it('refuses a local request before any filesystem access when the gate is off', async () => {
    const source = createSubmissionSource(config({ allowLocalSubmissions: false }))
    // Even though the fixture folder exists, the gate refuses it.
    const result = await source.verifyReachable({ kind: 'local', localPath: LOCAL_BASIC })
    expect(result).toMatchObject({ reachable: false, failure: 'local_disabled' })
    await expect(source.resolve({ kind: 'local', localPath: LOCAL_BASIC })).rejects.toMatchObject({
      failure: 'local_disabled',
    })
  })
})
