/**
 * Unit coverage for the overlay-image eviction sweep (Stage 5.4), entirely Docker-free: the policy
 * runs against an in-memory {@link OverlayImageManager} and a stub active-`ready` reader, mirroring
 * how the Stage 4 retention sweep is proven over fakes. It asserts the budget, the oldest-first
 * trim, the active-`ready` exemption, debris tolerance, and the composed-session-overlay rules
 * (recency exemption, and age-alone-forces-eviction of anything past the reclaim window including
 * `-stage` intermediates) — the properties the real Docker `listOverlayImages`/`removeImage` then
 * ride in the Docker-gated suite.
 */
import { describe, expect, it } from 'vitest'

import type { OverlayImage, OverlayImageManager } from '../../src/driver/index.js'
import {
  OverlayEviction,
  type OverlayEvictionConfig,
} from '../../src/submission/overlay-eviction.js'

/** An in-memory overlay-image manager: seed images, observe removals, optionally fail a call. */
class FakeOverlayDriver implements OverlayImageManager {
  readonly removed: string[] = []
  constructor(
    private images: OverlayImage[],
    private readonly opts: { failList?: boolean; failRemove?: (ref: string) => boolean } = {},
  ) {}

  listOverlayImages(): Promise<OverlayImage[]> {
    if (this.opts.failList) {
      return Promise.reject(new Error('daemon unreachable'))
    }
    return Promise.resolve([...this.images])
  }

  removeImage(ref: string): Promise<void> {
    if (this.opts.failRemove?.(ref)) {
      return Promise.reject(new Error(`cannot remove ${ref}`))
    }
    this.removed.push(ref)
    this.images = this.images.filter((image) => image.ref !== ref)
    return Promise.resolve()
  }
}

/** A stub of the one storage read the sweep makes. */
function readyReader(ids: string[]): { listActiveReadySubmissionIds: () => Promise<string[]> } {
  return { listActiveReadySubmissionIds: () => Promise.resolve(ids) }
}

function image(submissionId: string, createdAtMs: number): OverlayImage {
  return { ref: `overlay:${submissionId}`, kind: 'submission', submissionId, createdAtMs }
}

/** A final (non-staged) composed session overlay, or a re-exported `-stage` intermediate. */
function sessionImage(
  key: string,
  createdAtMs: number,
  opts: { staged?: boolean } = {},
): OverlayImage {
  const staged = opts.staged ?? false
  return {
    ref: staged ? `overlay:${key}-stage0` : `overlay:${key}`,
    kind: 'session',
    submissionId: null,
    staged,
    createdAtMs,
  }
}

const RECLAIM_MS = 3_600_000
const BIG_BUDGET = {
  overlayImageBudget: 50,
  sessionOverlayReclaimAgeMs: RECLAIM_MS,
  overlayImageSweepIntervalMs: 3_600_000,
}
const configOf = (overlayImageBudget: number): OverlayEvictionConfig => ({
  overlayImageBudget,
  sessionOverlayReclaimAgeMs: RECLAIM_MS,
  overlayImageSweepIntervalMs: 3_600_000,
})

describe('overlay eviction — active-ready exemption', () => {
  it('evicts a superseded submission image while keeping the active ready one', async () => {
    const driver = new FakeOverlayDriver([image('active', 1000), image('superseded', 900)])
    const eviction = new OverlayEviction(driver, readyReader(['active']), configOf(1))

    await eviction.sweep()

    // The active image counts toward the budget of 1 and is exempt, so the superseded one is evicted.
    expect(driver.removed).toEqual(['overlay:superseded'])
  })

  it('keeps every active ready image even when they exceed the budget, evicting all non-exempt', async () => {
    const driver = new FakeOverlayDriver([
      image('ready-a', 100),
      image('ready-b', 200),
      image('ready-c', 300),
      image('stale', 400),
    ])
    const eviction = new OverlayEviction(driver, readyReader(['ready-a', 'ready-b', 'ready-c']), {
      ...configOf(2), // already exceeded by the three exempt images
    })

    await eviction.sweep()

    // Exempt images are never evicted (they are live watch targets); only the non-exempt one goes.
    expect(driver.removed).toEqual(['overlay:stale'])
  })
})

describe('overlay eviction — budget trim', () => {
  it('trims an over-budget non-exempt set oldest-first, keeping the newest', async () => {
    const driver = new FakeOverlayDriver([
      image('s1', 1),
      image('s2', 2),
      image('s3', 3),
      image('s4', 4),
    ])
    const eviction = new OverlayEviction(driver, readyReader([]), configOf(2))

    await eviction.sweep()

    // Keep the two newest (s3, s4); evict the two oldest. Order is oldest-first within the evicted set.
    expect(new Set(driver.removed)).toEqual(new Set(['overlay:s1', 'overlay:s2']))
    expect(driver.removed).not.toContain('overlay:s3')
    expect(driver.removed).not.toContain('overlay:s4')
  })

  it('removes nothing when the image count is within budget', async () => {
    const driver = new FakeOverlayDriver([image('s1', 1), image('s2', 2)])
    const eviction = new OverlayEviction(driver, readyReader([]), BIG_BUDGET)

    await eviction.sweep()

    expect(driver.removed).toEqual([])
  })
})

describe('overlay eviction — debris and failure tolerance', () => {
  it('reclaims an image whose submission id matches no active row as ordinary non-exempt debris', async () => {
    // An orphan from a crash between building the image and writing its row: no matching ready id,
    // so it is simply non-exempt and evictable — reclaimed, not crashed on.
    const driver = new FakeOverlayDriver([image('orphan-debris', 1)])
    const eviction = new OverlayEviction(driver, readyReader([]), configOf(0))

    await eviction.sweep()

    expect(driver.removed).toEqual(['overlay:orphan-debris'])
  })

  it('continues past a remove failure and does not throw', async () => {
    const driver = new FakeOverlayDriver([image('s1', 1), image('s2', 2)], {
      failRemove: (ref) => ref === 'overlay:s1',
    })
    const logged: string[] = []
    const eviction = new OverlayEviction(
      driver,
      readyReader([]),
      { ...BIG_BUDGET, overlayImageBudget: 0 },
      (message) => logged.push(message),
    )

    await expect(eviction.sweep()).resolves.toBeUndefined()
    // s1's removal failed (logged), but s2 was still reclaimed.
    expect(driver.removed).toEqual(['overlay:s2'])
    expect(logged.some((line) => line.includes('overlay:s1'))).toBe(true)
  })

  it('is a no-op when enumerating images fails', async () => {
    const driver = new FakeOverlayDriver([image('s1', 1)], { failList: true })
    const logged: string[] = []
    const eviction = new OverlayEviction(driver, readyReader([]), BIG_BUDGET, (m) => logged.push(m))

    await expect(eviction.sweep()).resolves.toBeUndefined()
    expect(driver.removed).toEqual([])
    expect(logged.some((line) => line.includes('listing images failed'))).toBe(true)
  })
})

describe('overlay eviction — composed session overlays', () => {
  it('reclaims a leaked -stage intermediate regardless of age', async () => {
    // A stage tag is pure overhead after its build round; even a brand-new one must go.
    const now = Date.now()
    const driver = new FakeOverlayDriver([
      sessionImage('final', now - 1_000),
      sessionImage('final', now - 2_000, { staged: true }),
    ])
    const eviction = new OverlayEviction(driver, readyReader([]), BIG_BUDGET)

    await eviction.sweep()

    expect(driver.removed).toEqual(['overlay:final-stage0'])
  })

  it('keeps session overlays younger than the reclaim window', async () => {
    // The compose is single-use, but a sweep could otherwise land in the compose-to-launch instant;
    // a young final image is never evicted, so no amount of them builds up before launch.
    const now = Date.now()
    const driver = new FakeOverlayDriver([
      sessionImage('a', now - 1_000),
      sessionImage('b', now - 2_000),
      sessionImage('c', now - 3_000),
    ])
    const eviction = new OverlayEviction(driver, readyReader([]), BIG_BUDGET)

    await eviction.sweep()

    expect(driver.removed).toEqual([])
  })

  it('evicts every session overlay past the reclaim window — age alone forces eviction', async () => {
    // The critical backstop property: a leaked image is never stranded by a small retained set.
    // Even a single aged final composition is reclaimed, with or without active submissions around.
    const now = Date.now()
    const driver = new FakeOverlayDriver([
      sessionImage('fresh', now - 1_000),
      sessionImage('old-a', now - 10 * RECLAIM_MS),
      sessionImage('old-b', now - 11 * RECLAIM_MS),
    ])
    const eviction = new OverlayEviction(driver, readyReader([]), BIG_BUDGET)

    await eviction.sweep()

    expect(new Set(driver.removed)).toEqual(new Set(['overlay:old-a', 'overlay:old-b']))
    expect(driver.removed).not.toContain('overlay:fresh')
  })

  it('does not let session overlays crowd out per-submission retention', async () => {
    // The two pools are independent: a burst of aged session finals (all reclaimed) never touches
    // the exempt active-ready submission overlay.
    const now = Date.now()
    const driver = new FakeOverlayDriver([
      image('watch-ready', now - 100),
      sessionImage('s1', now - 10 * RECLAIM_MS),
      sessionImage('s2', now - 20 * RECLAIM_MS),
      sessionImage('s3', now - 30 * RECLAIM_MS),
    ])
    const eviction = new OverlayEviction(driver, readyReader(['watch-ready']), configOf(1))

    await eviction.sweep()

    expect(new Set(driver.removed)).toEqual(new Set(['overlay:s1', 'overlay:s2', 'overlay:s3']))
    expect(driver.removed).not.toContain('overlay:watch-ready')
  })
})
