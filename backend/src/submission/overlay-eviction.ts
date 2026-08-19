/**
 * Overlay-image eviction (Stage 5.4): the sweep that bounds how much disk a deployment's cached
 * `submission-overlay` and composed `session-overlay` images consume, modeled directly on the Stage 4
 * recording-retention sweep.
 *
 * Every submission that reaches the build stage leaves a cached per-submission overlay image, so
 * without reclamation the daemon's disk grows one image per submission forever. The safety property
 * that makes eviction simple is that an overlay is **never irreplaceable**: step 6's submission-image
 * helper refetches and rebuilds on demand, so evicting any overlay — even an active one — costs at
 * most a rebuild, never data loss. The only thing to avoid is thrashing the images a viewer is about
 * to watch, so the sweep **exempts the overlay images of the currently active `ready` submissions**
 * (the watch picker's live set) and never evicts them; they count toward the budget but are kept like
 * a pinned recording. Everything else is a superseded or failed submission's image the picker can
 * never launch, so reclaiming it is pure win — oldest-first, down to the budget.
 *
 * Composed session overlays are single-use: the orchestrator and workflow runner release one as soon
 * as its session ends, so any tag still present is a not-yet-ended session, a crashed release, or a
 * `-stage` build intermediate the concurrent-build race leaked. They are reclaimed here age-first —
 * each is rebuildable from stored snapshots, so eviction is always safe. The one ring to avoid
 * breaking is the instant between composing and launching an image, so session overlays newer than
 * {@link OverlayEvictionConfig.sessionOverlayReclaimAgeMs} are kept; everything else fills the
 * session budget newest-first, and `-stage` intermediates are always reclaimable debris.
 *
 * It enumerates the daemon's **actual** overlay images (through the driver), not storage rows, so a
 * crash between building an image and writing its row leaves only an orphan the sweep reclaims as
 * debris rather than tripping on. It is driver-neutral: it drives the {@link OverlayImageManager}
 * seam and reads one storage method, learning no Docker specifics.
 */
import type { OverlayImage, OverlayImageManager } from '../driver/index.js'
import type { Storage } from '../storage/index.js'
import { SweepTimer } from '../util/sweep-timer.js'

/** The eviction knobs, sliced from {@link import('../config/config.js').Config}. */
export interface OverlayEvictionConfig {
  /** Max overlay images retained; active-`ready` images count toward it but are never evicted. */
  overlayImageBudget: number
  /** Max composed session overlays retained, newest first; a release normally keeps this near zero. */
  sessionOverlayImageBudget: number
  /** Session overlays younger than this are never evicted (protects a compose about to launch). */
  sessionOverlayReclaimAgeMs: number
  /** How often the sweep runs on its own timer (it also runs at startup and after each build). */
  overlayImageSweepIntervalMs: number
}

/** The single storage read the sweep needs: the exempt set of active-`ready` submission ids. */
type ActiveReadyReader = Pick<Storage, 'listActiveReadySubmissionIds'>

export class OverlayEviction {
  private readonly timer: SweepTimer

  constructor(
    private readonly driver: OverlayImageManager,
    private readonly storage: ActiveReadyReader,
    private readonly config: OverlayEvictionConfig,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.timer = new SweepTimer(() => void this.sweep(), this.config.overlayImageSweepIntervalMs)
  }

  /** Run the sweep once at startup, then on the configured interval. */
  start(): void {
    this.timer.start()
  }

  /** Stop the interval timer (process shutdown). */
  stop(): void {
    this.timer.stop()
  }

  /**
   * The eviction sweep: keep every active-`ready` image plus the newest non-exempt images that fit
   * the remaining budget, and remove the rest oldest-first. Session overlays are kept only while
   * younger than the reclaim-age window or while they fit the session budget, newest first; `-stage`
   * intermediates (and anything the session release missed, crashed on, or never ran for) are
   * reclaimed as debris. Safe to call concurrently with itself — {@link OverlayImageManager.removeImage}
   * tolerates an already-absent image. Also the hook the worker calls after each successful overlay
   * build, the other moment the image set grows.
   */
  async sweep(): Promise<void> {
    let images: Awaited<ReturnType<OverlayImageManager['listOverlayImages']>>
    try {
      images = await this.driver.listOverlayImages()
    } catch (error) {
      this.log(`overlay-eviction: listing images failed: ${String(error)}`)
      return
    }

    let exemptIds: string[]
    try {
      exemptIds = await this.storage.listActiveReadySubmissionIds()
    } catch (error) {
      this.log(`overlay-eviction: reading active submissions failed: ${String(error)}`)
      return
    }
    const exempt = new Set(exemptIds)

    const removed: string[] = []
    removed.push(
      ...this.trackSubmissionImages(
        images.filter((i) => i.kind === 'submission'),
        exempt,
      ),
    )
    removed.push(...this.trackSessionImages(images.filter((i) => i.kind === 'session')))

    for (const ref of removed) {
      try {
        await this.driver.removeImage(ref)
      } catch (error) {
        this.log(`overlay-eviction: removing ${ref} failed: ${String(error)}`)
      }
    }
  }

  private trackSubmissionImages(images: OverlayImage[], exempt: ReadonlySet<string>): string[] {
    // Exempt (live watch-target) images are always kept but count toward the budget, exactly as a
    // pinned recording counts toward the Stage 4 quota. The non-exempt images fill whatever budget
    // remains, newest first; the rest are evicted oldest-first. If the exempt set alone meets or
    // exceeds the budget, no non-exempt image is retained — correct, since they are all superseded
    // or failed images the picker can never launch.
    const nonExempt = images
      .filter((image) => image.submissionId !== null && !exempt.has(image.submissionId))
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
    const exemptCount = images.length - nonExempt.length
    const remainingCapacity = Math.max(0, this.config.overlayImageBudget - exemptCount)
    return nonExempt.slice(remainingCapacity).map((image) => image.ref)
  }

  private trackSessionImages(images: OverlayImage[]): string[] {
    const now = Date.now()
    // A `-stage<i>` build intermediate is pure overhead after its round ends; always reclaim it,
    // whether or not the final composition is kept. Final compositions younger than the reclaim age
    // may still be between compose and launch, so exempt them the way active-`ready` submissions
    // are exempt: kept, and counted toward the budget. The rest trim to the session budget
    // newest-first (a released session leaves nothing here; these are debris between composes).
    const staged = images.filter((image) => image.staged === true)
    const finals = images.filter((image) => image.staged !== true)
    const fresh = finals.filter(
      (image) => now - image.createdAtMs < this.config.sessionOverlayReclaimAgeMs,
    )
    const evictable = finals
      .filter((image) => now - image.createdAtMs >= this.config.sessionOverlayReclaimAgeMs)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
    const capacity = Math.max(0, this.config.sessionOverlayImageBudget - fresh.length)
    return [
      ...staged.map((image) => image.ref),
      ...evictable.slice(capacity).map((image) => image.ref),
    ]
  }
}
