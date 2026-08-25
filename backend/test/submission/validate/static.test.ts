/**
 * Unit coverage for the static validator (Stage 5.3), entirely Docker- and network-free: each case
 * points the pure {@link validateStatic} function at a checked-in fixture tree under
 * `fixtures/validate/` and asserts the typed accept or the one specific rejection reason. This is the
 * stage's first demonstrable slice — every malformed fixture must reject with its correct code, and a
 * valid manifest (mirroring the worked example's real `manifest.json`) must accept.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { validateStatic } from '../../../src/submission/validate/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, '..', '..', 'fixtures', 'validate')
const fixture = (name: string) => join(FIXTURES, name)

// The single-version Stage 5 deployment: one base image (v1) and an open season pinned to v1.
const KNOWN_V1 = new Set([1])
const DEPS_V1 = 1

describe('static validator — accepts', () => {
  it('accepts a valid manifest and returns the parsed fields', async () => {
    const result = await validateStatic(fixture('valid'), DEPS_V1, KNOWN_V1)
    expect(result).toEqual({
      ok: true,
      manifest: { entry_point: 'agent', class_name: 'Agent', template_version: 1 },
    })
  })

  it('accepts a package-style entry point resolving to pkg/agent.py', async () => {
    const result = await validateStatic(fixture('entry-point-package'), DEPS_V1, KNOWN_V1)
    expect(result.ok).toBe(true)
  })
})

describe('static validator — manifest presence and JSON', () => {
  it('rejects a missing manifest.json', async () => {
    const result = await validateStatic(fixture('manifest-missing'), DEPS_V1, KNOWN_V1)
    expect(result).toMatchObject({ ok: false, reason: { code: 'manifest_missing' } })
  })

  it('rejects a tree root that does not exist as manifest_missing, not a crash', async () => {
    const result = await validateStatic(fixture('does-not-exist'), DEPS_V1, KNOWN_V1)
    expect(result).toMatchObject({ ok: false, reason: { code: 'manifest_missing' } })
  })

  it('rejects malformed JSON', async () => {
    const result = await validateStatic(fixture('invalid-json'), DEPS_V1, KNOWN_V1)
    expect(result).toMatchObject({ ok: false, reason: { code: 'manifest_invalid_json' } })
  })
})

describe('static validator — manifest fields', () => {
  it.each([
    ['missing-entry-point', 'entry_point'],
    ['missing-class-name', 'class_name'],
    ['missing-template-version', 'template_version'],
    ['bad-entry-point', 'entry_point'],
    ['bad-class-name', 'class_name'],
    ['bad-template-version', 'template_version'],
  ])('rejects %s naming the offending field %s', async (name, field) => {
    const result = await validateStatic(fixture(name), DEPS_V1, KNOWN_V1)
    expect(result).toMatchObject({ ok: false, reason: { code: 'manifest_field_invalid', field } })
  })

  it('rejects an unknown key, naming the key', async () => {
    const result = await validateStatic(fixture('unknown-key'), DEPS_V1, KNOWN_V1)
    expect(result).toMatchObject({
      ok: false,
      reason: { code: 'manifest_unknown_key', key: 'extra' },
    })
  })
})

describe('static validator — entry point existence', () => {
  it('rejects an entry point that names no file in the tree', async () => {
    const result = await validateStatic(fixture('entry-point-missing'), DEPS_V1, KNOWN_V1)
    expect(result).toMatchObject({ ok: false, reason: { code: 'entry_point_missing' } })
  })
})

describe('static validator — template version', () => {
  it('rejects a template_version with no deployment base image', async () => {
    const result = await validateStatic(fixture('unknown-template-version'), DEPS_V1, KNOWN_V1)
    expect(result).toMatchObject({ ok: false, reason: { code: 'unknown_template_version' } })
  })

  it('rejects a known template_version that does not match the open season (synthetic multi-version)', async () => {
    // Reachable only when the deployment has a base image for a version the season does not pin:
    // known versions {1, 2}, season pinned to 1, manifest targets 2.
    const result = await validateStatic(
      fixture('template-version-mismatch'),
      DEPS_V1,
      new Set([1, 2]),
    )
    expect(result).toMatchObject({ ok: false, reason: { code: 'template_version_mismatch' } })
  })

  it('reports unknown_template_version before template_version_mismatch (check 5 precedes check 6)', async () => {
    // The same tv=2 fixture, but with only v1 known, must trip the unknown check first — proving the
    // single-version deployment never reaches the mismatch branch.
    const result = await validateStatic(fixture('template-version-mismatch'), DEPS_V1, KNOWN_V1)
    expect(result).toMatchObject({ ok: false, reason: { code: 'unknown_template_version' } })
  })
})

describe('static validator — symlink escape is rejected, not followed', () => {
  it('treats a manifest symlinked out of the tree as missing, and an escaping entry point as missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'static-symlink-'))
    const outside = mkdtempSync(join(tmpdir(), 'static-outside-'))
    try {
      const secret = join(outside, 'secret.json')
      writeFileSync(
        secret,
        JSON.stringify({ entry_point: 'agent', class_name: 'Agent', template_version: 1 }),
      )
      try {
        symlinkSync(secret, join(root, 'manifest.json'))
      } catch {
        // Windows without symlink privilege (or any platform that refuses): nothing to assert.
        return
      }
      const manifestResult = await validateStatic(root, DEPS_V1, KNOWN_V1)
      expect(manifestResult).toMatchObject({ ok: false, reason: { code: 'manifest_missing' } })

      // Now give it a real in-root manifest but symlink the entry-point file out of the tree. Remove
      // the symlink first — writing through it would follow it to the out-of-tree target.
      rmSync(join(root, 'manifest.json'))
      writeFileSync(
        join(root, 'manifest.json'),
        JSON.stringify({ entry_point: 'agent', class_name: 'Agent', template_version: 1 }),
      )
      const outsideAgent = join(outside, 'agent.py')
      writeFileSync(outsideAgent, 'class Agent: pass\n')
      symlinkSync(outsideAgent, join(root, 'agent.py'))
      const entryResult = await validateStatic(root, DEPS_V1, KNOWN_V1)
      expect(entryResult).toMatchObject({ ok: false, reason: { code: 'entry_point_missing' } })
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
