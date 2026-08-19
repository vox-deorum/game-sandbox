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
import {
  CANONICAL_SUBMISSION_SEAT,
  ensureSubmissionImage,
  resolveSubmissionLaunchImage,
} from '../../src/submission/submission-image.js'
import { FakeDriver } from '../support/fake-driver.js'

const SEAT = 'seat_0'

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
      SEAT,
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
      SEAT,
    )

    expect(image.ref).toContain('sub-2')
    expect(calls.fetched).toBe(1)
  })
})

describe('resolveSubmissionLaunchImage seat routing', () => {
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

  /** A snapshot store already holding `id`'s tree, so a rebuild never reaches the source seam. */
  async function snapshotsWith(id: string): Promise<SubmissionSnapshotStore> {
    const store = new SubmissionSnapshotStore(tmp('gs-img-snap-'))
    const sourceTree = tmp('gs-img-tree-')
    writeFileSync(join(sourceTree, 'manifest.json'), '{"entry_point":"agent"}')
    await store.write(id, sourceTree)
    return store
  }

  /** A source seam that fails loudly if touched: these tests must resolve from the warm cache or snapshot. */
  function unusedSource(): SubmissionSource {
    const fail = (): never => {
      throw new Error('the source seam must not be touched on these paths')
    }
    return { verifyReachable: fail, resolve: fail, fetchTree: fail }
  }

  /** Seed a warm per-submission overlay (built for the canonical seat) the reuse path can find by id. */
  function seedWarmOverlay(driver: FakeDriver, id: string): string {
    const ref = `game-sandbox/submission-overlay:deps-v1-${id}`
    driver.overlayImages.set(ref, {
      ref,
      kind: 'submission',
      submissionId: id,
      createdAtMs: 1,
    })
    return ref
  }

  it('reuses the warm per-submission overlay for a lone submission in the canonical seat', async () => {
    const driver = new FakeDriver()
    const warmRef = seedWarmOverlay(driver, 'sub-1')
    const image = await resolveSubmissionLaunchImage(
      {
        driver,
        snapshots: await snapshotsWith('sub-1'),
        source: unusedSource(),
        imagePolicy: 'reuse',
      },
      [{ seatId: CANONICAL_SUBMISSION_SEAT, submission: gitSubmission('sub-1') }],
      1,
    )

    // The id-keyed warm image is returned untouched; nothing recomposed.
    expect(image.ref).toBe(warmRef)
    expect(driver.imageRequests).toHaveLength(0)
  })

  it('composes a per-seat session image for a lone submission outside the canonical seat', async () => {
    const driver = new FakeDriver()
    // The warm overlay is present, but it was built for seat_0; a seat_1 seating must not reuse it,
    // or the launched image would carry the agent's code under the wrong seat directory.
    const warmRef = seedWarmOverlay(driver, 'sub-1')
    const image = await resolveSubmissionLaunchImage(
      {
        driver,
        snapshots: await snapshotsWith('sub-1'),
        source: unusedSource(),
        imagePolicy: 'reuse',
      },
      [{ seatId: 'seat_1', submission: gitSubmission('sub-1') }],
      1,
    )

    expect(image.ref).not.toBe(warmRef)
    expect(image.ref).toContain('session-overlay')
    // It composed a one-seat session image staging the code into seat_1's own directory.
    const spec = driver.imageRequests.at(-1)
    expect(spec?.kind).toBe('session-overlay')
    expect(spec?.kind === 'session-overlay' && spec.seats).toEqual([
      expect.objectContaining({ seatId: 'seat_1', submissionId: 'sub-1' }),
    ])
  })

  it('rejects an empty seat set rather than silently composing an empty image', async () => {
    const driver = new FakeDriver()
    await expect(
      resolveSubmissionLaunchImage(
        {
          driver,
          snapshots: await snapshotsWith('sub-1'),
          source: unusedSource(),
          imagePolicy: 'reuse',
        },
        [],
        1,
      ),
    ).rejects.toThrow(/at least one submitted seat/)
    expect(driver.imageRequests).toHaveLength(0)
  })
})
