/**
 * The overlay build, sandboxed load check, caching, and eviction against a real Docker daemon
 * (Stage 5.4). These are the exit criteria that only mean something with a real image: a worked
 * example builds an overlay on the base image and loads; a manifest naming a missing class builds
 * but fails the load check with the captured Python reason; the overlay is cached under `reuse`; and
 * the eviction sweep reclaims a superseded overlay while keeping an active one. Gated behind the
 * Docker daemon like the rest of the integration suite (the base image is built in global setup).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createDockerDriver, type DockerDriver } from '../../src/driver/docker/index.js'
import type { SandboxProfile, SubmissionOverlayImageSpec } from '../../src/driver/index.js'
import { OverlayEviction } from '../../src/submission/overlay-eviction.js'
import { runLoadCheck } from '../../src/submission/validate/load-check.js'
import { DEPS_VERSION, TAG_PREFIX } from './support/base-image.js'

const LOAD_CHECK_SANDBOX: SandboxProfile = {
  cpus: 1,
  memoryMb: 512,
  readOnlyRoot: true,
  scratch: { containerPath: '/tmp', sizeMb: 64 },
  network: 'none',
  mounts: [],
}

const GOOD_AGENT = [
  'class Agent:',
  '    def reset(self, seed):',
  '        self.seed = seed',
  '    def act(self, observation):',
  '        return 0',
  '',
].join('\n')

/** Write a minimal submission tree (manifest + agent module) into a fresh temp dir; return its path. */
function writeTree(opts: { className?: string; source?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'gs-overlay-'))
  const manifest = {
    entry_point: 'agent',
    class_name: opts.className ?? 'Agent',
    template_version: DEPS_VERSION,
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'agent.py'), opts.source ?? GOOD_AGENT)
  return dir
}

function overlaySpec(submissionId: string, sourceTreePath: string): SubmissionOverlayImageSpec {
  return {
    kind: 'submission-overlay',
    depsVersion: DEPS_VERSION,
    submissionId,
    sourceTreePath,
    seatId: 'seat_0',
  }
}

async function driver(policy: 'reuse' | 'rebuild' = 'reuse'): Promise<DockerDriver> {
  return createDockerDriver({
    imageTagPrefix: TAG_PREFIX,
    imagePolicy: policy,
    overlayBuildTimeoutMs: 120_000,
  })
}

describe('overlay build and load check (Docker)', () => {
  const trees: string[] = []
  const builtRefs: Array<{ d: DockerDriver; ref: string }> = []

  afterEach(async () => {
    for (const tree of trees.splice(0)) {
      rmSync(tree, { recursive: true, force: true })
    }
    for (const { d, ref } of builtRefs.splice(0)) {
      await d.removeImage(ref).catch(() => undefined)
    }
  })

  it('builds an overlay for a worked example and the load check passes', async () => {
    const d = await driver()
    const tree = writeTree({})
    trees.push(tree)
    const image = await d.ensureImage(overlaySpec('it-overlay-ok', tree))
    builtRefs.push({ d, ref: image.ref })

    const result = await runLoadCheck(d, image, {
      sandbox: LOAD_CHECK_SANDBOX,
      sessionId: 'it-overlay-ok',
      timeoutMs: 60_000,
    })

    expect(result).toEqual({ ok: true })
  })

  it('builds but fails the load check with class_not_found when the manifest names a missing class', async () => {
    const d = await driver()
    const tree = writeTree({ className: 'Ghost' }) // agent.py defines Agent, not Ghost
    trees.push(tree)
    const image = await d.ensureImage(overlaySpec('it-overlay-missing-class', tree))
    builtRefs.push({ d, ref: image.ref })

    const result = await runLoadCheck(d, image, {
      sandbox: LOAD_CHECK_SANDBOX,
      sessionId: 'it-overlay-missing-class',
      timeoutMs: 60_000,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('class_not_found')
      expect(result.detail).toContain('Ghost')
    }
  })

  it('fails the load check with import_error for a module that raises on import', async () => {
    const d = await driver()
    const tree = writeTree({ source: "raise RuntimeError('boom at import')\n" })
    trees.push(tree)
    const image = await d.ensureImage(overlaySpec('it-overlay-bad-import', tree))
    builtRefs.push({ d, ref: image.ref })

    const result = await runLoadCheck(d, image, {
      sandbox: LOAD_CHECK_SANDBOX,
      sessionId: 'it-overlay-bad-import',
      timeoutMs: 60_000,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('import_error')
    }
  })
})

describe('overlay caching and eviction (Docker)', () => {
  const trees: string[] = []
  const builtRefs: Array<{ d: DockerDriver; ref: string }> = []

  afterEach(async () => {
    for (const tree of trees.splice(0)) {
      rmSync(tree, { recursive: true, force: true })
    }
    for (const { d, ref } of builtRefs.splice(0)) {
      await d.removeImage(ref).catch(() => undefined)
    }
  })

  async function createdAt(d: DockerDriver, ref: string): Promise<number> {
    const images = await d.listOverlayImages()
    const found = images.find((image) => image.ref === ref)
    if (found === undefined) {
      throw new Error(`overlay ${ref} not found after build`)
    }
    return found.createdAtMs
  }

  it('reuses the cached overlay image on a second build under reuse policy', async () => {
    const d = await driver('reuse')
    const tree = writeTree({})
    trees.push(tree)

    const first = await d.ensureImage(overlaySpec('it-overlay-cache', tree))
    builtRefs.push({ d, ref: first.ref })
    const firstCreated = await createdAt(d, first.ref)

    const second = await d.ensureImage(overlaySpec('it-overlay-cache', tree))
    expect(second.ref).toBe(first.ref)
    // Reuse returns the existing image untouched: its creation time is unchanged (not rebuilt).
    expect(await createdAt(d, second.ref)).toBe(firstCreated)
  })

  it('enumerates an overlay with its submission id and removes it', async () => {
    const d = await driver()
    const tree = writeTree({})
    trees.push(tree)
    const image = await d.ensureImage(overlaySpec('it-overlay-list', tree))

    const listed = await d.listOverlayImages()
    expect(listed.some((i) => i.ref === image.ref && i.submissionId === 'it-overlay-list')).toBe(
      true,
    )

    await d.removeImage(image.ref)
    const after = await d.listOverlayImages()
    expect(after.some((i) => i.ref === image.ref)).toBe(false)
  })

  it('evicts a superseded overlay while keeping an active ready one', async () => {
    const d = await driver()
    const activeTree = writeTree({})
    const supersededTree = writeTree({})
    trees.push(activeTree, supersededTree)

    const active = await d.ensureImage(overlaySpec('it-evict-active', activeTree))
    const superseded = await d.ensureImage(overlaySpec('it-evict-superseded', supersededTree))
    builtRefs.push({ d, ref: active.ref })

    const eviction = new OverlayEviction(
      d,
      { listActiveReadySubmissionIds: () => Promise.resolve(['it-evict-active']) },
      { overlayImageBudget: 1, overlayImageSweepIntervalMs: 3_600_000 },
    )
    await eviction.sweep()

    const remaining = await d.listOverlayImages()
    const refs = new Set(remaining.map((i) => i.ref))
    expect(refs.has(active.ref)).toBe(true)
    expect(refs.has(superseded.ref)).toBe(false)
  })
})
