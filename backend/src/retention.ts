/**
 * Recording retention: the eviction sweep, the merged listing, and pinning.
 *
 * The policy from the recording spec, in two passes over the rows: delete unpinned recordings older
 * than the configured window, then for each user over quota delete oldest-unpinned-first until back
 * within it. Pinned recordings are exempt from both passes but count against the quota, so unbounded
 * pinning could make the quota meaningless, hence the pin guard, which refuses a pin once the user's
 * pinned count reaches the quota. The sweep runs at startup, on an interval, and after each session
 * finalize and workflow-run completion (the moments the data grows). Deletion removes the directory and
 * then the row; the listing tolerates either half missing, so a crash mid-deletion leaves only
 * ignorable debris the next pass cleans.
 *
 * Stage 6.5 layers leaderboard retention on top of this live-session policy. Leaderboard recordings
 * from each iteration's latest completed run are kept for as long as the iteration is viewable, so the
 * sweep filters those protected ids out before either pass, so they are neither evicted nor counted
 * toward a user's quota. A superseded run's recordings fall outside the protected set and rejoin the
 * normal window/quota passes, so repeated re-runs do not accumulate recordings without bound.
 *
 * The recording itself is the directory on the volume ({@link RecordingsStore}); the row in storage
 * is its retention metadata. The merged listing pairs each readable directory with its row, so an
 * entry carries the header plus owner, age, and pin state. A directory with no row (foreign debris,
 * or pre-backfill data) is listed header-only and never evicted.
 */
import type { RecordingsStore } from './recordings.js'
import type { Recording, Storage } from './storage/index.js'

const MS_PER_DAY = 86_400_000

/** The retention knobs, sliced from {@link import('./config.js').Config}. */
export interface RetentionConfig {
  recordingRetentionDays: number
  recordingUserQuota: number
  recordingSweepIntervalMs: number
}

/** One entry of the merged `GET /api/recordings` listing: the header plus retention metadata. */
export interface RecordingListing {
  id: string
  header: unknown
  /** Null for a rowless directory (foreign debris listed header-only). */
  user_id: string | null
  created_at: string | null
  pinned: boolean
}

/** The outcome of a pin request the HTTP layer maps to a status. */
export type PinResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'pinned_quota' }

export class Retention {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly storage: Storage,
    private readonly recordings: RecordingsStore,
    private readonly config: RetentionConfig,
    private readonly log: (message: string) => void = () => {},
    /** Injectable wall clock so the window sweep is testable without real time. */
    private readonly now: () => number = Date.now,
  ) {}

  /** Run the sweep once at startup, then on the configured interval. */
  start(): void {
    void this.sweep()
    this.timer = setInterval(() => void this.sweep(), this.config.recordingSweepIntervalMs)
    // Don't keep the process alive solely for the sweep timer.
    this.timer.unref?.()
  }

  /** Stop the interval timer (process shutdown). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * The eviction sweep: window first, then per-user quota. Pinned rows are exempt from both passes
   * but still count toward the quota. Safe to call concurrently with itself in the sense that a
   * double-delete is a no-op (the directory and row removals tolerate a missing half).
   */
  async sweep(): Promise<void> {
    let allRows: Recording[]
    try {
      allRows = await this.storage.listRecordings()
    } catch (error) {
      this.log(`retention: listing rows failed: ${String(error)}`)
      return
    }

    // Exempt the current-run leaderboard recordings of every viewable iteration. If we cannot
    // determine the protected set, skip the sweep entirely rather than risk reclaiming a protected
    // recording; the next pass retries.
    let protectedIds: Set<string>
    try {
      protectedIds = new Set(await this.storage.listProtectedLeaderboardRecordingIds())
    } catch (error) {
      this.log(`retention: listing protected leaderboard recordings failed: ${String(error)}`)
      return
    }
    // Filter protected ids out before either pass, so they are neither evicted nor counted toward a
    // user's quota; what remains is the live-session population the Stage 4 policy governs.
    const rows = allRows.filter((row) => !protectedIds.has(row.id))

    const evicted = new Set<string>()
    const cutoff = this.now() - this.config.recordingRetentionDays * MS_PER_DAY

    // Pass 1: window. An unpinned recording older than the window goes.
    for (const row of rows) {
      if (row.pinned === 0 && Date.parse(row.created_at) < cutoff) {
        await this.evict(row.id)
        evicted.add(row.id)
      }
    }

    // Pass 2: quota, per user. Pinned rows count toward the quota but are never evicted, so a user
    // can sit over quota entirely on pinned recordings. The pin guard is what bounds that.
    const remaining = rows.filter((row) => !evicted.has(row.id))
    const byUser = new Map<string, Recording[]>()
    for (const row of remaining) {
      const list = byUser.get(row.user_id) ?? []
      list.push(row)
      byUser.set(row.user_id, list)
    }
    for (const userRows of byUser.values()) {
      let over = userRows.length - this.config.recordingUserQuota
      if (over <= 0) {
        continue
      }
      const unpinnedOldestFirst = userRows
        .filter((row) => row.pinned === 0)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
      for (const row of unpinnedOldestFirst) {
        if (over <= 0) {
          break
        }
        await this.evict(row.id)
        over -= 1
      }
    }
  }

  /** Remove a recording: the directory first, then the row (a crash between leaves only debris). */
  private async evict(id: string): Promise<void> {
    try {
      await this.recordings.delete(id)
      await this.storage.deleteRecording(id)
    } catch (error) {
      this.log(`retention: evicting ${id} failed: ${String(error)}`)
    }
  }

  /**
   * The merged listing: every readable recording directory paired with its retention row, optionally
   * narrowed to one environment. Newest first by `created_at`; rowless directories sort last and are
   * matched against their header's environment.
   */
  async list(filter?: { env?: string }): Promise<RecordingListing[]> {
    const [volume, rows] = await Promise.all([
      this.recordings.list(),
      this.storage.listRecordings(),
    ])
    const rowById = new Map(rows.map((row) => [row.id, row]))

    const merged: RecordingListing[] = volume.map((entry) => {
      const row = rowById.get(entry.id)
      return {
        id: entry.id,
        header: entry.header,
        user_id: row?.user_id ?? null,
        created_at: row?.created_at ?? null,
        pinned: row?.pinned === 1,
      }
    })

    const matchEnv = (entry: RecordingListing): boolean => {
      if (filter?.env === undefined) {
        return true
      }
      const row = rowById.get(entry.id)
      const envFromHeader = (entry.header as { environment?: unknown } | null)?.environment
      return row?.env_id === filter.env || envFromHeader === filter.env
    }

    return merged.filter(matchEnv).sort((a, b) => {
      // Newest first; a rowless directory (null created_at) sorts after dated ones.
      if (a.created_at === null) {
        return b.created_at === null ? a.id.localeCompare(b.id) : 1
      }
      if (b.created_at === null) {
        return -1
      }
      return b.created_at.localeCompare(a.created_at)
    })
  }

  /** Pin a recording (owner-only), refusing once the user is at their pinned quota. Idempotent. */
  async pin(id: string, userId: string): Promise<PinResult> {
    const row = await this.storage.getRecording(id)
    if (row === undefined) {
      return { ok: false, reason: 'not_found' }
    }
    if (row.user_id !== userId) {
      return { ok: false, reason: 'forbidden' }
    }
    if (row.pinned === 1) {
      return { ok: true }
    }
    const pinnedCount = await this.storage.countPinnedByUser(userId)
    if (pinnedCount >= this.config.recordingUserQuota) {
      return { ok: false, reason: 'pinned_quota' }
    }
    await this.storage.setRecordingPinned(id, true)
    return { ok: true }
  }

  /** Unpin a recording (owner-only). Idempotent. */
  async unpin(id: string, userId: string): Promise<PinResult> {
    const row = await this.storage.getRecording(id)
    if (row === undefined) {
      return { ok: false, reason: 'not_found' }
    }
    if (row.user_id !== userId) {
      return { ok: false, reason: 'forbidden' }
    }
    await this.storage.setRecordingPinned(id, false)
    return { ok: true }
  }
}
