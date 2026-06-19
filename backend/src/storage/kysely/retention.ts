/**
 * The leaderboard-retention read: the recording ids the Stage 4 eviction sweep must exempt — the
 * recordings of every season's latest completed run. Superseded runs' recordings fall outside
 * the set and stay reclaimable.
 */
import type { Kysely } from 'kysely'

import type { Database } from '../schema.js'
import { getLatestCompletedRun } from './runs.js'

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
