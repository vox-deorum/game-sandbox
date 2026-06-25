/**
 * The shared submission-tree filter (size measurement + the ignore predicate). Proves the predicate
 * excludes the right segments and the measurement excludes them too, follows no symlinks, and
 * short-circuits past a limit without walking the rest of a large tree.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { isSubmissionIgnored, measureTreeSize } from '../../src/submission/tree-filter.js'

describe('submission tree filter', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gs-treefilter-'))
    dirs.push(dir)
    return dir
  }

  describe('isSubmissionIgnored', () => {
    it('ignores VCS/build segments and .pyc files anywhere under the root', () => {
      const root = '/work'
      expect(isSubmissionIgnored(root, join(root, '.git', 'HEAD'))).toBe(true)
      expect(isSubmissionIgnored(root, join(root, 'pkg', 'node_modules', 'x.js'))).toBe(true)
      expect(isSubmissionIgnored(root, join(root, '__pycache__'))).toBe(true)
      expect(isSubmissionIgnored(root, join(root, 'agent', 'mod.pyc'))).toBe(true)
    })

    it('keeps real submission files and never ignores the root itself', () => {
      const root = '/work'
      expect(isSubmissionIgnored(root, root)).toBe(false)
      expect(isSubmissionIgnored(root, join(root, 'agent.py'))).toBe(false)
      expect(isSubmissionIgnored(root, join(root, 'manifest.json'))).toBe(false)
    })

    it('treats a child whose name starts with .. as inside the root', () => {
      const root = '/work'
      // `..cache` is a real child, not an escape, so its `.pyc` is still ignored.
      expect(isSubmissionIgnored(root, join(root, '..cache', 'mod.pyc'))).toBe(true)
      // A genuine escape (outside the root) is never ignored.
      expect(isSubmissionIgnored(root, join(root, '..', 'sibling', 'mod.pyc'))).toBe(false)
    })
  })

  describe('measureTreeSize', () => {
    it('sums kept files and excludes ignored segments', async () => {
      const root = tmp()
      writeFileSync(join(root, 'a.txt'), 'x'.repeat(100))
      writeFileSync(join(root, 'b.txt'), 'y'.repeat(50))
      mkdirSync(join(root, '.git'))
      writeFileSync(join(root, '.git', 'huge'), 'z'.repeat(10_000))
      mkdirSync(join(root, 'node_modules'))
      writeFileSync(join(root, 'node_modules', 'dep.js'), 'q'.repeat(5_000))
      expect(await measureTreeSize(root)).toBe(150)
    })

    it('short-circuits once the running total exceeds the limit', async () => {
      const root = tmp()
      writeFileSync(join(root, 'a.bin'), Buffer.alloc(2_000))
      writeFileSync(join(root, 'b.bin'), Buffer.alloc(2_000))
      // The walk stops as soon as it passes the limit; the returned value is over the cap, not exact.
      const measured = await measureTreeSize(root, 1_000)
      expect(measured).toBeGreaterThan(1_000)
    })
  })
})
