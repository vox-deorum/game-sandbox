/**
 * The session-base build-context allow-list. Proves the predicate packs only the registered input
 * trees (with the ancestor directories tar-fs needs to descend), still prunes caches inside those
 * trees, and matches whole segments rather than string prefixes. The digest tests prove it sees
 * exactly the same trees, so a change outside them never moves the digest.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildContextIgnore,
  computeBuildInputsDigest,
} from '../../../src/driver/docker/build-inputs.js'

/** The same tree list the version-1 session base image registers for its build. */
const INPUTS = ['backend/images/session-base/deps-v1', 'harness', 'environments'] as const

describe('session base build-context filter', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gs-build-inputs-'))
    dirs.push(dir)
    return dir
  }

  describe('buildContextIgnore', () => {
    const root = '/work'

    function ignores(path: string[]): boolean {
      return buildContextIgnore(root, INPUTS)(join(root, ...path))
    }

    it('keeps the ancestor directories of the inputs so tar-fs can descend', () => {
      expect(ignores(['backend'])).toBe(false)
      expect(ignores(['backend', 'images'])).toBe(false)
      expect(ignores(['backend', 'images', 'session-base'])).toBe(false)
    })

    it('ignores anything outside the input trees, root files included', () => {
      expect(ignores(['.tls', 'ca.pem'])).toBe(true)
      expect(ignores(['data', 'db.sqlite'])).toBe(true)
      expect(ignores(['frontend', 'src', 'main.ts'])).toBe(true)
      expect(ignores(['backend', 'src', 'main.ts'])).toBe(true)
      expect(ignores(['backend', 'images', 'session-base', 'other', 'x'])).toBe(true)
      expect(ignores(['package.json'])).toBe(true)
      expect(ignores(['.env'])).toBe(true)
      expect(ignores(['.env.local'])).toBe(true)
    })

    it('keeps the input roots and the files under them', () => {
      expect(ignores(['harness', 'src', 'x.py'])).toBe(false)
      expect(ignores(['backend', 'images', 'session-base', 'deps-v1', 'Dockerfile'])).toBe(false)
      expect(ignores(['environments'])).toBe(false)
    })

    it('still prunes caches inside allowed trees', () => {
      expect(ignores(['harness', '__pycache__', 'm.pyc'])).toBe(true)
      expect(ignores(['environments', 'hearts', 'mod.pyc'])).toBe(true)
    })

    it('matches whole segments, not string prefixes', () => {
      expect(ignores(['backend2', 'x'])).toBe(true)
      expect(ignores(['harnessx', 'x'])).toBe(true)
    })
  })

  describe('computeBuildInputsDigest', () => {
    function inputTree(): string {
      const root = tmp()
      mkdirSync(join(root, 'backend', 'images', 'session-base', 'deps-v1'), { recursive: true })
      writeFileSync(
        join(root, 'backend', 'images', 'session-base', 'deps-v1', 'Dockerfile'),
        'FROM x\n',
      )
      mkdirSync(join(root, 'harness'))
      writeFileSync(join(root, 'harness', 'pyproject.toml'), 'harness\n')
      mkdirSync(join(root, 'environments'))
      writeFileSync(join(root, 'environments', 'pyproject.toml'), 'environments\n')
      return root
    }

    it('a change outside the inputs leaves the digest unchanged', async () => {
      const root = inputTree()
      const before = await computeBuildInputsDigest(root, INPUTS)
      mkdirSync(join(root, 'backend', 'src'), { recursive: true })
      writeFileSync(join(root, 'backend', 'src', 'main.ts'), 'export {}\n')
      writeFileSync(join(root, 'root-file.txt'), 'x')
      expect(await computeBuildInputsDigest(root, INPUTS)).toBe(before)
    })

    it('a change inside an input tree moves the digest', async () => {
      const root = inputTree()
      const before = await computeBuildInputsDigest(root, INPUTS)
      mkdirSync(join(root, 'harness', 'src'), { recursive: true })
      writeFileSync(join(root, 'harness', 'src', 'agent.py'), 'print(1)\n')
      expect(await computeBuildInputsDigest(root, INPUTS)).not.toBe(before)
    })

    it('a cache file added inside an allowed tree does not move the digest', async () => {
      const root = inputTree()
      const before = await computeBuildInputsDigest(root, INPUTS)
      mkdirSync(join(root, 'harness', '__pycache__'))
      writeFileSync(join(root, 'harness', '__pycache__', 'm.pyc'), 'x')
      expect(await computeBuildInputsDigest(root, INPUTS)).toBe(before)
    })
  })
})
