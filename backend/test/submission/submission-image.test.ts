/**
 * The submission-image helper's rebuild path (Stage 5.6 + snapshots): when no cached overlay exists,
 * it materializes the submission's tree and rebuilds the overlay. It prefers the durable snapshot (no
 * git round trip) and falls back to re-cloning the pinned source only when the submission has none.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { Submission } from '../../src/storage/index.js'
import { SubmissionSnapshotStore } from '../../src/submission/snapshot-store.js'
import type {
  ResolvedSource,
  SourceInput,
  SubmissionSource,
  TreeHandle,
} from '../../src/submission/source/index.js'
import { ensureSubmissionImage } from '../../src/submission/submission-image.js'
import { FakeDriver } from '../support/fake-driver.js'

const SLOT = 'player_0'

/** A git submission row with the fields the rebuild path reads. */
function gitSubmission(id: string): Submission {
  return {
    id,
    season_id: 'season-1',
    env_id: 'flappy_bird',
    user_id: 'alice',
    source_kind: 'git',
    repo_url: 'https://example.test/repo',
    commit_sha: 'c0ffee1234',
    local_path: null,
    ref: null,
    status: 'ready',
    reason: null,
    created_at: '2026-01-01T00:00:00.000Z',
    superseded_at: null,
  }
}

describe('ensureSubmissionImage rebuild path', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function tmp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }

  /** A source seam that records whether it was touched and returns a throwaway tree. */
  function recordingSource(): { source: SubmissionSource; calls: { fetched: number } } {
    const calls = { fetched: 0 }
    const source: SubmissionSource = {
      verifyReachable: () => Promise.resolve({ reachable: true }),
      resolve: (_input: SourceInput): Promise<ResolvedSource> =>
        Promise.resolve({
          kind: 'git',
          repoUrl: 'https://example.test/repo',
          commitSha: 'c0ffee1234',
          ref: null,
          resolvedRef: 'main',
          localPath: null,
        }),
      fetchTree: (): Promise<TreeHandle> => {
        calls.fetched += 1
        const path = tmp('gs-img-git-')
        writeFileSync(join(path, 'manifest.json'), '{}')
        return Promise.resolve({ path, dispose: () => Promise.resolve() })
      },
    }
    return { source, calls }
  }

  it('rebuilds from the snapshot without touching the source seam', async () => {
    const store = new SubmissionSnapshotStore(tmp('gs-img-snap-'))
    const sourceTree = tmp('gs-img-tree-')
    writeFileSync(join(sourceTree, 'manifest.json'), '{"entry_point":"agent"}')
    await store.write('sub-1', sourceTree)

    const { source, calls } = recordingSource()
    const driver = new FakeDriver()
    const image = await ensureSubmissionImage(
      { driver, snapshots: store, source, imagePolicy: 'reuse' },
      gitSubmission('sub-1'),
      1,
      SLOT,
    )

    expect(image.ref).toContain('submission-overlay')
    expect(image.ref).toContain('sub-1')
    expect(calls.fetched).toBe(0)
    expect(driver.imageRequests.at(-1)?.kind).toBe('submission-overlay')
  })

  it('falls back to the source seam when the submission has no snapshot', async () => {
    const store = new SubmissionSnapshotStore(tmp('gs-img-snap-'))
    const { source, calls } = recordingSource()
    const driver = new FakeDriver()

    const image = await ensureSubmissionImage(
      { driver, snapshots: store, source, imagePolicy: 'reuse' },
      gitSubmission('sub-2'),
      1,
      SLOT,
    )

    expect(image.ref).toContain('sub-2')
    expect(calls.fetched).toBe(1)
  })
})
