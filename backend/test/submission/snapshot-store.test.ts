/**
 * The submission-snapshot store: pack a checked-out tree, stream it back, materialize it into a fresh
 * checkout (drop-in for the source seam's fetchTree), and delete it. Proves the shared filter excludes
 * `.git`/`node_modules`, the materialized tree is byte-identical for the kept files, the atomic write
 * leaves no `.tmp` behind, materialize throws for a missing id, and delete tolerates absence.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  SnapshotMissingError,
  SubmissionSnapshotStore,
} from '../../src/submission/snapshot-store.js'

describe('SubmissionSnapshotStore', () => {
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

  /** A source tree with two real files plus ignored `.git` and `node_modules` content. */
  function writeSourceTree(): string {
    const dir = tmp('gs-snap-src-')
    writeFileSync(join(dir, 'manifest.json'), '{"entry_point":"agent"}')
    mkdirSync(join(dir, 'pkg'))
    writeFileSync(join(dir, 'pkg', 'agent.py'), 'class Agent:\n    pass\n')
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'config'), '[core]\n')
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'node_modules', 'dep.js'), 'module.exports = 1\n')
    return dir
  }

  it('writes, materializes the kept files byte-identically, and excludes ignored dirs', async () => {
    const store = new SubmissionSnapshotStore(tmp('gs-snap-root-'))
    const source = writeSourceTree()

    await store.write('sub-1', source)
    expect(await store.exists('sub-1')).toBe(true)

    const tree = await store.materialize('sub-1')
    dirs.push(tree.path)
    expect(readFileSync(join(tree.path, 'manifest.json'), 'utf8')).toBe('{"entry_point":"agent"}')
    expect(readFileSync(join(tree.path, 'pkg', 'agent.py'), 'utf8')).toBe(
      'class Agent:\n    pass\n',
    )
    expect(existsSync(join(tree.path, '.git'))).toBe(false)
    expect(existsSync(join(tree.path, 'node_modules'))).toBe(false)

    await tree.dispose()
    expect(existsSync(tree.path)).toBe(false)
  })

  it('publishes atomically: no .tmp file is left beside the archive', async () => {
    const root = tmp('gs-snap-root-')
    const store = new SubmissionSnapshotStore(root)
    await store.write('sub-2', writeSourceTree())
    const entries = readdirSync(root)
    expect(entries).toContain('sub-2.tar.gz')
    expect(entries.some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('streams the stored archive bytes', async () => {
    const store = new SubmissionSnapshotStore(tmp('gs-snap-root-'))
    await store.write('sub-3', writeSourceTree())
    const chunks: Buffer[] = []
    for await (const chunk of store.stream('sub-3')) {
      chunks.push(chunk as Buffer)
    }
    // gzip magic bytes (0x1f 0x8b) confirm a real gzip stream came back.
    const head = Buffer.concat(chunks).subarray(0, 2)
    expect([head[0], head[1]]).toEqual([0x1f, 0x8b])
  })

  it('throws SnapshotMissingError when materializing an absent id', async () => {
    const store = new SubmissionSnapshotStore(tmp('gs-snap-root-'))
    expect(await store.exists('nope')).toBe(false)
    await expect(store.materialize('nope')).rejects.toBeInstanceOf(SnapshotMissingError)
  })

  it('delete removes the archive and is a no-op on a missing id', async () => {
    const root = tmp('gs-snap-root-')
    const store = new SubmissionSnapshotStore(root)
    await store.write('sub-4', writeSourceTree())
    await store.delete('sub-4')
    expect(await store.exists('sub-4')).toBe(false)
    await expect(store.delete('sub-4')).resolves.toBeUndefined()
  })
})
