/**
 * Recording retention: the eviction sweep, the merged listing, and pinning.
 *
 * The policy from the recording spec, in two passes over the rows: delete unpinned recordings older
 * than the configured window, then for each user over quota delete oldest-unpinned-first until back
 * within it. Pinned recordings are exempt from both passes but count against the quota, so unbounded
 * pinning could make the quota meaningless, hence the pin guard, which refuses a pin once the user's
 * pinned count reaches the quota. The sweep runs at startup, on an interval, and after each session
 * finalize and workflow-run completion (the moments the data grows). Eviction claims remove the row
 * and create durable cleanup work in one transaction; later filesystem or telemetry failures remain
 * queued for the next sweep.
 *
 * Stage 6.5 layers leaderboard retention on top of this live-session policy. Leaderboard recordings
 * from each season's latest completed run are kept for as long as the season is viewable, so the
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
import type { Recording, RecordingCleanupClaimResult, Storage } from './storage/index.js'

const MS_PER_DAY = 86_400_000
const COMPLETED_OUTCOMES = new Set(['terminated', 'truncated'])

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
  /**
   * How the run that produced this recording ended, so the replay viewer can label its outcome the
   * way the ended-session card does. Joined from the producing session row when one claims the
   * recording, falling back to the recording row's own reason for an automated run that had no
   * session. Null when neither carries one (foreign debris, or a session still running when listed).
   */
  termination_reason: string | null
  /** The winning seat id (`seat_0`, `seat_1`, ...), -1 for a tie, or null without ranking data. */
  winner_id: string | -1 | null
  /**
   * The season the producing session competed in, joined from the session row, so a replay carries
   * the play-open (or submission) season it belongs to. Null when no session claims the recording
   * (foreign debris).
   */
  season_id: string | null
}

/** The outcome of a pin request the HTTP layer maps to a status. */
export type PinResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'pinned_quota' }

/** The narrow telemetry seam: remove one execution scope's SQLite file once it is unreferenced. */
export interface LlmTelemetryReclaimer {
  deleteScope(scopeId: string): void
}

export interface StartupLlmTelemetryReclaimer extends LlmTelemetryReclaimer {
  deleteOrphanedScopes(referencedScopeIds: ReadonlySet<string>): string[]
}

/** Reclaim official startup debris from the durable recording association keep set. */
export async function reclaimOrphanedOfficialTelemetry(
  storage: Pick<Storage, 'listRecordings'>,
  telemetry: StartupLlmTelemetryReclaimer,
  log: (message: string) => void = () => {},
): Promise<void> {
  try {
    const recordings = await storage.listRecordings()
    const referenced = new Set(
      recordings.flatMap((recording) =>
        recording.llm_scope_id === null ? [] : [recording.llm_scope_id],
      ),
    )
    telemetry.deleteOrphanedScopes(referenced)
  } catch (error) {
    log(`retention: startup LLM telemetry cleanup failed: ${String(error)}`)
  }
}

export class Retention {
  private timer: ReturnType<typeof setInterval> | null = null
  /** Serialize triggers so two sweeps cannot simultaneously remove a scope's final references. */
  private sweepTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly storage: Storage,
    private readonly recordings: RecordingsStore,
    private readonly config: RetentionConfig,
    private readonly log: (message: string) => void = () => {},
    /** Injectable wall clock so the window sweep is testable without real time. */
    private readonly now: () => number = Date.now,
    /** Optional: LLM telemetry scopes are reclaimed with the last recording that references them. */
    private readonly llmTelemetry?: LlmTelemetryReclaimer,
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
   * but still count toward the quota. Concurrent triggers queue behind one another so deciding which
   * recording is a scope's final durable association cannot race with another eviction.
   */
  sweep(): Promise<void> {
    const next = this.sweepTail.then(() => this.sweepOnce())
    // Keep the queue usable if an unexpected error escapes the individually guarded operations.
    this.sweepTail = next.catch(() => {})
    return next
  }

  private async sweepOnce(): Promise<void> {
    await this.retryPendingCleanup()

    let allRows: Recording[]
    try {
      allRows = await this.storage.listRecordings()
    } catch (error) {
      this.log(`retention: listing rows failed: ${String(error)}`)
      return
    }

    // Exempt the current-run leaderboard recordings of every viewable season. If we cannot
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
        if (this.wasEvicted(await this.evict(row))) evicted.add(row.id)
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
        // Missing, active, newly protected, and successfully claimed rows all leave this sweep's
        // evictable population, so each frees a quota slot. A concurrent pin still counts toward
        // quota, and a transient error is retried by a later sweep — neither counts as progress.
        if (this.wasEvicted(await this.evict(row))) over -= 1
      }
    }

    await this.retryPendingCleanup()
  }

  /** Atomically revalidate a stale sweep candidate and convert it into durable cleanup work. */
  private async evict(row: Recording): Promise<RecordingCleanupClaimResult | 'error'> {
    try {
      return await this.storage.claimRecordingCleanup(row.id)
    } catch (error) {
      this.log(`retention: evicting ${row.id} failed: ${String(error)}`)
      return 'error'
    }
  }

  /**
   * Whether an evict attempt removed the row from this sweep's evictable population. A live pin
   * ('pinned') keeps its row counted toward quota; a transient failure ('error') leaves the row for
   * a later sweep. Every other outcome — claimed, already gone, or now active/protected — means the
   * row is no longer this sweep's to evict or count.
   */
  private wasEvicted(result: RecordingCleanupClaimResult | 'error'): boolean {
    return result !== 'pinned' && result !== 'error'
  }

  /** Retry claimed cleanup independently from recording pin and leaderboard protection state. */
  private async retryPendingCleanup(): Promise<void> {
    let queue: Awaited<ReturnType<Storage['listRecordingCleanupQueue']>>
    try {
      queue = await this.storage.listRecordingCleanupQueue()
    } catch (error) {
      this.log(`retention: listing cleanup queue failed: ${String(error)}`)
      return
    }
    for (const item of queue) {
      // A queued scope can only be reclaimed by a process wired with the telemetry seam. Defer the
      // whole item — directory included — rather than deleting the directory now and stranding a row
      // that could never be completed; a reclaimer-equipped sweep will finish it.
      if (item.llm_scope_id !== null && this.llmTelemetry === undefined) {
        this.log(`retention: no telemetry reclaimer for ${item.recording_id}; deferring cleanup`)
        continue
      }
      try {
        await this.recordings.delete(item.recording_id)
        if (item.llm_scope_id !== null) {
          this.llmTelemetry?.deleteScope(item.llm_scope_id)
        }
        await this.storage.completeRecordingCleanup(item.recording_id)
      } catch (error) {
        this.log(`retention: cleaning ${item.recording_id} failed: ${String(error)}`)
      }
    }
  }

  /**
   * The merged listing: every readable recording directory paired with its retention row, optionally
   * narrowed to one environment. Newest first by `created_at`; rowless directories sort last and are
   * matched against their header's environment.
   */
  async list(filter?: { env?: string }): Promise<RecordingListing[]> {
    const [volume, rows, sessions] = await Promise.all([
      this.recordings.list(),
      this.storage.listRecordings(),
      this.storage.listSessions(),
    ])
    const rowById = new Map(rows.map((row) => [row.id, row]))
    // The termination reason and season live on the session, keyed back to the recording it produced.
    // Only an ended session carries a reason; a running session's recording lists with a null reason
    // until it ends, then falls back to the recording row's own reason (set for an automated run that
    // had no session). The season is the play-open (or submission) season the session competed in.
    const reasonByRecording = new Map<string, string | null>()
    const seasonByRecording = new Map<string, string | null>()
    for (const session of sessions) {
      if (session.recording_id !== null) {
        reasonByRecording.set(session.recording_id, session.termination_reason)
        seasonByRecording.set(session.recording_id, session.season_id)
      }
    }

    const merged: RecordingListing[] = volume.map((entry) => {
      const row = rowById.get(entry.id)
      const terminationReason = reasonByRecording.get(entry.id) ?? row?.termination_reason ?? null
      return {
        id: entry.id,
        header: entry.header,
        user_id: row?.user_id ?? null,
        created_at: row?.created_at ?? null,
        pinned: row?.pinned === 1,
        termination_reason: terminationReason,
        winner_id: COMPLETED_OUTCOMES.has(terminationReason ?? '') ? entry.winner_id : null,
        season_id: seasonByRecording.get(entry.id) ?? null,
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
    return (await this.storage.setRecordingPinned(id, true))
      ? { ok: true }
      : { ok: false, reason: 'not_found' }
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
    return (await this.storage.setRecordingPinned(id, false))
      ? { ok: true }
      : { ok: false, reason: 'not_found' }
  }
}
