/**
 * The bounded validation worker (Stage 5.5), Docker-free: it drives the real {@link ValidationWorker}
 * against in-memory storage, a {@link FakeDriver}, and a programmable fake source seam. Each test
 * seeds an open iteration and a pending submission row, enqueues it, awaits the worker idle, and
 * asserts the resulting rollup status and the ordered per-stage check log. It proves the four-stage
 * pipeline, every stage's failure rollup, the crash wrapper that never leaves a check `running`, the
 * tree-handle disposal on both success and throw, the commit pin, and the re-enqueue idempotency.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ExecutionDriver } from '../src/driver/index.js'
import type { Storage, Submission } from '../src/storage/index.js'
import { openSqliteStorage } from '../src/storage/sqlite.js'
import type {
  ResolvedSource,
  SourceInput,
  SubmissionSource,
  TreeHandle,
} from '../src/submission/source/index.js'
import { SourceError } from '../src/submission/source/index.js'
import { ValidationWorker } from '../src/submission/worker.js'
import { FakeDriver } from './support/fake-driver.js'
import { makeConfig } from './support/harness.js'

const ENV_ID = 'flappy_bird'

/** A validate-result envelope line the FakeDriver's launch emits for the load check. */
function envelope(payload: Record<string, unknown>): string {
  return JSON.stringify({ kind: 'validate-result', ...payload })
}

/** A FakeDriver whose launched load check reports the given envelope and exit code. */
function driverEmitting(payload: Record<string, unknown>, code: number): FakeDriver {
  const driver = new FakeDriver()
  driver.onLaunch = (launch) => {
    launch.process.emit(envelope(payload))
    launch.process.finish({ code, oomKilled: false })
  }
  return driver
}

interface FakeSourceOptions {
  resolveError?: SourceError
  fetchError?: Error
  resolved?: ResolvedSource
  treePath?: string
  onDispose?: () => void
}

/** A programmable {@link SubmissionSource}: canned resolve/fetch outcomes, recorded disposal. */
class FakeSource implements SubmissionSource {
  constructor(private readonly opts: FakeSourceOptions) {}

  verifyReachable(): Promise<{ reachable: boolean }> {
    return Promise.resolve({ reachable: true })
  }

  resolve(_input: SourceInput): Promise<ResolvedSource> {
    if (this.opts.resolveError !== undefined) {
      return Promise.reject(this.opts.resolveError)
    }
    return Promise.resolve(
      this.opts.resolved ?? {
        kind: 'git',
        repoUrl: 'https://example.test/repo',
        commitSha: 'c0ffee1234',
        ref: null,
        resolvedRef: 'main',
        localPath: null,
      },
    )
  }

  fetchTree(_resolved: ResolvedSource): Promise<TreeHandle> {
    if (this.opts.fetchError !== undefined) {
      return Promise.reject(this.opts.fetchError)
    }
    return Promise.resolve({
      path: this.opts.treePath ?? '',
      dispose: async () => {
        this.opts.onDispose?.()
      },
    })
  }
}

describe('ValidationWorker', () => {
  let storage: Storage
  const tempDirs: string[] = []

  beforeEach(async () => {
    storage = await openSqliteStorage(':memory:')
  })

  afterEach(async () => {
    await storage.close()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /** Write a submission tree; omit the agent module to fail the static entry-point check. */
  function writeTree(opts: { withAgent?: boolean } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'gs-worker-'))
    tempDirs.push(dir)
    const manifest = { entry_point: 'agent', class_name: 'Agent', template_version: 1 }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
    if (opts.withAgent !== false) {
      writeFileSync(
        join(dir, 'agent.py'),
        'class Agent:\n    def reset(self, seed):\n        pass\n    def act(self, obs):\n        return 0\n',
      )
    }
    return dir
  }

  /** Seed an open iteration and a pending git submission, returning the stored row. */
  async function seedSubmission(source: 'git' | 'local' = 'git'): Promise<Submission> {
    const iteration = await storage.ensureOpenIteration(ENV_ID, 1)
    return storage.createSubmission({
      iteration_id: iteration.id,
      env_id: ENV_ID,
      user_id: 'alice',
      source_kind: source,
      repo_url: source === 'git' ? 'https://example.test/repo' : null,
      commit_sha: null,
      local_path: source === 'local' ? '/srv/agent' : null,
      ref: null,
      created_at: new Date().toISOString(),
    })
  }

  function makeWorker(driver: ExecutionDriver, source: SubmissionSource): ValidationWorker {
    const config = makeConfig()
    return new ValidationWorker({
      driver,
      storage,
      source,
      sandbox: config.sandbox,
      loadCheckTimeoutMs: 5_000,
      knownTemplateVersions: new Set([1]),
    })
  }

  it('drives a good submission through all four stages to ready, pinning the commit', async () => {
    let disposed = 0
    const treePath = writeTree()
    const submission = await seedSubmission()
    const worker = makeWorker(
      driverEmitting({ ok: true }, 0),
      new FakeSource({ treePath, onDispose: () => (disposed += 1) }),
    )

    worker.enqueue(submission.id)
    await worker.whenIdle()

    const row = await storage.getSubmission(submission.id)
    expect(row?.status).toBe('ready')
    expect(row?.commit_sha).toBe('c0ffee1234')
    const checks = await storage.listSubmissionChecks(submission.id)
    expect(checks.map((c) => [c.stage, c.status])).toEqual([
      ['resolve', 'passed'],
      ['static', 'passed'],
      ['build', 'passed'],
      ['load', 'passed'],
    ])
    expect(disposed).toBe(1)
  })

  it('turns an unreachable repo into static_failed with a failed resolve and no static check', async () => {
    const submission = await seedSubmission()
    const worker = makeWorker(
      new FakeDriver(),
      new FakeSource({ resolveError: new SourceError('unreachable', 'repository not found') }),
    )

    worker.enqueue(submission.id)
    await worker.whenIdle()

    const row = await storage.getSubmission(submission.id)
    expect(row?.status).toBe('static_failed')
    expect(row?.reason).toContain('repository not found')
    const checks = await storage.listSubmissionChecks(submission.id)
    expect(checks.map((c) => c.stage)).toEqual(['resolve'])
    expect(checks[0]?.status).toBe('failed')
  })

  it('fails the static stage with its reason after a passing resolve', async () => {
    const treePath = writeTree({ withAgent: false })
    const submission = await seedSubmission()
    const worker = makeWorker(new FakeDriver(), new FakeSource({ treePath }))

    worker.enqueue(submission.id)
    await worker.whenIdle()

    const row = await storage.getSubmission(submission.id)
    expect(row?.status).toBe('static_failed')
    const checks = await storage.listSubmissionChecks(submission.id)
    expect(checks.map((c) => [c.stage, c.status])).toEqual([
      ['resolve', 'passed'],
      ['static', 'failed'],
    ])
    expect(checks[1]?.detail).toContain('names no file')
  })

  it('fails the build stage and still disposes the fetched tree on the throw path', async () => {
    let disposed = 0
    const treePath = writeTree()
    const submission = await seedSubmission()
    const driver = new FakeDriver()
    driver.ensureImage = () => Promise.reject(new Error('overlay build kaboom'))
    const worker = makeWorker(
      driver,
      new FakeSource({ treePath, onDispose: () => (disposed += 1) }),
    )

    worker.enqueue(submission.id)
    await worker.whenIdle()

    const row = await storage.getSubmission(submission.id)
    expect(row?.status).toBe('build_failed')
    const checks = await storage.listSubmissionChecks(submission.id)
    expect(checks.map((c) => [c.stage, c.status])).toEqual([
      ['resolve', 'passed'],
      ['static', 'passed'],
      ['build', 'failed'],
    ])
    expect(checks[2]?.detail).toContain('kaboom')
    expect(disposed).toBe(1)
  })

  it('maps a load-check failure to load_failed with the code and detail', async () => {
    const treePath = writeTree()
    const submission = await seedSubmission()
    const worker = makeWorker(
      driverEmitting({ ok: false, code: 'missing_hook', detail: 'no callable act' }, 1),
      new FakeSource({ treePath }),
    )

    worker.enqueue(submission.id)
    await worker.whenIdle()

    const row = await storage.getSubmission(submission.id)
    expect(row?.status).toBe('load_failed')
    const checks = await storage.listSubmissionChecks(submission.id)
    expect(checks.map((c) => [c.stage, c.status])).toEqual([
      ['resolve', 'passed'],
      ['static', 'passed'],
      ['build', 'passed'],
      ['load', 'failed'],
    ])
    expect(checks[3]?.detail).toContain('missing_hook')
    expect(checks[3]?.detail).toContain('no callable act')
  })

  it('closes the running check and writes a rollup when a stage throws unexpectedly', async () => {
    const submission = await seedSubmission()
    // A non-SourceError thrown from resolve escapes to the crash wrapper rather than the typed path.
    const worker = makeWorker(
      new FakeDriver(),
      new FakeSource({ fetchError: new Error('disk exploded') }),
    )

    worker.enqueue(submission.id)
    await worker.whenIdle()

    const row = await storage.getSubmission(submission.id)
    expect(row?.status).toBe('static_failed')
    const checks = await storage.listSubmissionChecks(submission.id)
    expect(checks).toHaveLength(1)
    expect(checks[0]?.stage).toBe('resolve')
    expect(checks[0]?.status).toBe('failed')
    expect(checks[0]?.ended_at).not.toBeNull()
  })

  it('re-enqueues a submission without duplicating its checks', async () => {
    const treePath = writeTree()
    const submission = await seedSubmission()
    const worker = makeWorker(driverEmitting({ ok: true }, 0), new FakeSource({ treePath }))

    worker.enqueue(submission.id)
    await worker.whenIdle()
    // A startup re-enqueue (or any second run) overwrites the same (submission, stage) rows.
    worker.enqueue(submission.id)
    await worker.whenIdle()

    const checks = await storage.listSubmissionChecks(submission.id)
    expect(checks).toHaveLength(4)
    expect(checks.map((c) => c.stage)).toEqual(['resolve', 'static', 'build', 'load'])
  })

  it('re-enqueues active pending submissions on start()', async () => {
    const treePath = writeTree()
    const submission = await seedSubmission()
    const worker = makeWorker(driverEmitting({ ok: true }, 0), new FakeSource({ treePath }))

    await worker.start()
    await worker.whenIdle()

    expect((await storage.getSubmission(submission.id))?.status).toBe('ready')
  })
})
