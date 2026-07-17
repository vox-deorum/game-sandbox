/**
 * The leaderboard-retention read: the recording ids the Stage 4 eviction sweep must exempt — the
 * recordings of every season's latest completed run. Superseded runs' recordings fall outside
 * the set and stay reclaimable.
 */
import { type Kysely, sql } from 'kysely'

import type { RecordingCleanupClaimResult } from '../index.js'
import type { Database, RecordingCleanup } from '../schema.js'
import { getLatestCompletedRun } from './runs.js'

/** Active lifecycle rows are the authoritative barrier against claiming a replay for deletion. */
async function isLlmScopeActive(db: Kysely<Database>, scopeId: string): Promise<boolean> {
  const session = await db
    .selectFrom('sessions')
    .select('id')
    .where('id', '=', scopeId)
    .where('status', 'in', ['starting', 'running'])
    .executeTakeFirst()
  if (session !== undefined) {
    return true
  }
  const run = await db
    .selectFrom('season_runs')
    .select('id')
    .where('id', '=', scopeId)
    .where('status', 'in', ['pending', 'running'])
    .executeTakeFirst()
  return run !== undefined
}

/** Recheck latest-completed-run protection inside the same transaction as an eviction claim. */
async function isLeaderboardRecordingProtected(
  db: Kysely<Database>,
  recordingId: string,
): Promise<boolean> {
  const associations = await db
    .selectFrom('season_run_games')
    .innerJoin('season_runs', 'season_runs.id', 'season_run_games.run_id')
    .select(['season_run_games.run_id', 'season_runs.season_id'])
    .where('season_run_games.recording_id', '=', recordingId)
    .execute()
  for (const association of associations) {
    const latest = await getLatestCompletedRun(db, association.season_id)
    if (latest?.id === association.run_id) {
      return true
    }
  }
  return false
}

/**
 * Atomically turn one stale sweep candidate into durable cleanup work. The transaction rechecks all
 * mutable protection state before removing the row. If it removes the scope's final association,
 * that decision is captured on the queue row while the verified-inactive lifecycle prevents new
 * recordings from joining the scope.
 */
export async function claimRecordingCleanup(
  db: Kysely<Database>,
  id: string,
): Promise<RecordingCleanupClaimResult> {
  // The conditional delete and its cleanup-queue trigger are one SQLite statement. Pin updates and
  // lifecycle/protection transitions therefore order entirely before or after this claim, with no
  // await boundary at which a successful mutation can be lost.
  const claimed = await sql<{ id: string }>`
    DELETE FROM recordings
    WHERE recordings.id = ${id}
      AND recordings.pinned = 0
      AND (
        recordings.llm_scope_id IS NULL
        OR (
          NOT EXISTS (
            SELECT 1 FROM sessions
            WHERE sessions.id = recordings.llm_scope_id
              AND sessions.status IN ('starting', 'running')
          )
          AND NOT EXISTS (
            SELECT 1 FROM season_runs
            WHERE season_runs.id = recordings.llm_scope_id
              AND season_runs.status IN ('pending', 'running')
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM season_run_games AS active_game
        INNER JOIN season_runs AS active_run ON active_run.id = active_game.run_id
        WHERE active_game.recording_id = recordings.id
          AND active_run.status IN ('pending', 'running')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM season_run_games
        INNER JOIN season_runs AS associated_run
          ON associated_run.id = season_run_games.run_id
        WHERE season_run_games.recording_id = recordings.id
          AND associated_run.status = 'completed'
          AND associated_run.id = (
            -- Mirrors getLatestCompletedRun / orderByNewestRun (runs.ts). The atomic claim must
            -- recheck protection inside this one statement, so it cannot reuse that query builder;
            -- if the newest-run tie-break changes there, change it here too or this eviction guard
            -- and the board will disagree on which run is "latest" and evict a still-shown replay.
            SELECT latest_run.id
            FROM season_runs AS latest_run
            WHERE latest_run.season_id = associated_run.season_id
              AND latest_run.status = 'completed'
            ORDER BY latest_run.started_at DESC, latest_run.rowid DESC
            LIMIT 1
          )
      )
    RETURNING id
  `.execute(db)
  if (claimed.rows.length > 0) return 'claimed'

  // Classification only guides this sweep's quota bookkeeping. The destructive decision above is
  // already complete and atomic, so concurrent changes during these reads cannot invalidate safety.
  const recording = await db
    .selectFrom('recordings')
    .select(['pinned', 'llm_scope_id'])
    .where('id', '=', id)
    .executeTakeFirst()
  if (recording === undefined) return 'missing'
  if (recording.pinned === 1) return 'pinned'
  if (recording.llm_scope_id !== null && (await isLlmScopeActive(db, recording.llm_scope_id))) {
    return 'active_scope'
  }
  return (await isLeaderboardRecordingProtected(db, id)) ? 'protected' : 'active_scope'
}

export async function listRecordingCleanupQueue(db: Kysely<Database>): Promise<RecordingCleanup[]> {
  return await db.selectFrom('recording_cleanup_queue').selectAll().execute()
}

export async function completeRecordingCleanup(
  db: Kysely<Database>,
  recordingId: string,
): Promise<void> {
  await db.deleteFrom('recording_cleanup_queue').where('recording_id', '=', recordingId).execute()
}

export async function listProtectedLeaderboardRecordingIds(
  db: Kysely<Database>,
): Promise<string[]> {
  // The exempt set is the recordings of each season's latest completed run. Superseded runs'
  // recordings fall outside it (the live retention sweep may reclaim them). Every season is
  // viewable (released, or unreleased-but-operator-worked), so none are excluded here by status.
  const seasons = await db.selectFrom('seasons').select('id').execute()
  const protectedIds = new Set<string>()
  for (const season of seasons) {
    const run = await getLatestCompletedRun(db, season.id)
    if (run === undefined) {
      continue
    }
    const games = await db
      .selectFrom('season_run_games')
      .select('recording_id')
      .where('run_id', '=', run.id)
      .where('recording_id', 'is not', null)
      .execute()
    for (const game of games) {
      if (game.recording_id !== null) {
        protectedIds.add(game.recording_id)
      }
    }
  }
  return [...protectedIds]
}
