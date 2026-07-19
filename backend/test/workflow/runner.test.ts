/**
 * The workflow-runner seam (Stage 6.3): the startup reconcile that fails a run a process death left
 * non-terminal, and the placeholder runner's cancel. Docker-free against `:memory:` storage.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ResolvedOfficialLlmPolicy } from '../../src/llm/config.js'
import type { Storage } from '../../src/storage/index.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'
import { createPlaceholderRunner, reconcileInterruptedRuns } from '../../src/workflow/runner.js'

const ENV_ID = 'flappy_bird'

function disabledLlmPolicy(): ResolvedOfficialLlmPolicy {
  return {
    enabled: false,
    models: {},
    session: { token_budget: 1, rate_limit_rpm: 1 },
  }
}

describe('workflow runner seam', () => {
  let storage: Storage

  beforeEach(async () => {
    storage = await openSqliteStorage(':memory:')
  })

  afterEach(async () => {
    await storage.close()
  })

  /** A declared, configured season plus a created run (status `pending`). */
  async function makeRun(): Promise<string> {
    const season = await storage.createSeason({
      env_id: ENV_ID,
      deps_version: 1,
      label: null,
    })
    await storage.updateSeasonConfig(season.id, {
      deps_version: 1,
      matches: [{ slots: ['submission'], seeds: [1], games: 1 }],
    })
    const run = await storage.createRunWithSchedule(
      season.id,
      'dev-user',
      [],
      [{ match_index: 0, game_index: 0, seed: 1, slots: [{ kind: 'builtin-naive' }] }],
      disabledLlmPolicy,
    )
    return run.id
  }

  it('reconciles leftover running and pending runs to failed, leaving terminal runs alone', async () => {
    const running = await makeRun()
    await storage.setRunStatus(running, 'running')
    const pending = await makeRun() // stays pending
    const completed = await makeRun()
    await storage.setRunStatus(completed, 'completed')

    const failedCount = await reconcileInterruptedRuns(storage)
    expect(failedCount).toBe(2)

    expect((await storage.getRun(running))?.status).toBe('failed')
    expect((await storage.getRun(running))?.error).toMatch(/restarted/)
    expect((await storage.getRun(pending))?.status).toBe('failed')
    // A completed run is never disturbed by the reconcile.
    expect((await storage.getRun(completed))?.status).toBe('completed')
  })

  it('is a no-op when nothing is in progress', async () => {
    const completed = await makeRun()
    await storage.setRunStatus(completed, 'completed')
    expect(await reconcileInterruptedRuns(storage)).toBe(0)
  })

  it('placeholder cancel marks the run cancelled in storage', async () => {
    const runId = await makeRun()
    const runner = createPlaceholderRunner(storage)
    runner.cancel(runId)
    // The cancel write is fire-and-forget; let the microtask settle.
    await new Promise((resolve) => setImmediate(resolve))
    expect((await storage.getRun(runId))?.status).toBe('cancelled')
  })
})
