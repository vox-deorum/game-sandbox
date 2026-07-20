/**
 * The workflow-runner seam (Stage 6.3): the startup reconcile that fails a run a process death left
 * non-terminal, and the placeholder runner's cancel. Docker-free against `:memory:` storage.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EnvironmentRegistry } from '../../src/environments.js'
import {
  decodeResolvedOfficialLlmPolicy,
  type ResolvedOfficialLlmPolicy,
} from '../../src/llm/config.js'
import type { Storage } from '../../src/storage/index.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'
import { SubmissionSnapshotStore } from '../../src/submission/snapshot-store.js'
import type { SubmissionSource } from '../../src/submission/source/index.js'
import { createPlaceholderRunner, reconcileInterruptedRuns } from '../../src/workflow/runner.js'
import { createWorkflowRunner } from '../../src/workflow/workflow-runner.js'
import { FakeDriver } from '../support/fake-driver.js'

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
  const roots: string[] = []

  beforeEach(async () => {
    storage = await openSqliteStorage(':memory:')
  })

  afterEach(async () => {
    await storage.close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
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

  it('a recovered real runner consumes the frozen policy after incompatible season changes', async () => {
    const season = await storage.createSeason({
      env_id: ENV_ID,
      deps_version: 1,
      label: 'Frozen policy',
    })
    await storage.updateSeasonConfig(season.id, {
      deps_version: 1,
      matches: [{ slots: ['submission'], seeds: [1], games: 1 }],
      overrides: { llm: { enabled: true, models: ['small'] } },
    })
    const frozen: ResolvedOfficialLlmPolicy = {
      enabled: true,
      models: { small: { model: 'provider-at-creation', cost_weight: 7 } },
      session: { token_budget: 41, rate_limit_rpm: 3 },
    }
    const run = await storage.createRunWithSchedule(
      season.id,
      'dev-user',
      [],
      [{ match_index: 0, game_index: 0, seed: 1, slots: [{ kind: 'builtin-naive' }] }],
      () => frozen,
    )
    await storage.updateSeasonConfig(season.id, {
      deps_version: 1,
      matches: [],
      overrides: {
        llm: {
          enabled: true,
          models: ['medium'],
          official: { token_budget: 999, rate_limit_rpm: 99 },
        },
      },
    })

    const issued: Array<{
      models: Record<string, { upstream: string; costWeight: number }>
      limits: { tokenBudget: number; requestsPerMinute: number }
    }> = []
    const driver = new FakeDriver()
    driver.onLaunch = ({ process }) => {
      process.emit(
        JSON.stringify({
          schema_version: 1,
          environment: ENV_ID,
          seed: 1,
          created_at: '2026-07-19T00:00:00.000Z',
        }),
      )
      process.emit(
        JSON.stringify({
          schema_version: 1,
          tick: 0,
          agents: { player_0: { reward: 1, score: 1, timing: { decision_ms: 1 } } },
          timing: { started_at: 0, duration_ms: 1 },
        }),
      )
      process.emit(
        JSON.stringify({ kind: 'result', ticks: 1, scores: { player_0: 1 }, reason: 'terminated' }),
      )
      process.finish({ code: 0, oomKilled: false })
    }
    const root = mkdtempSync(join(tmpdir(), 'gs-runner-recovery-'))
    roots.push(root)
    const unusedSource: SubmissionSource = {
      verifyReachable: () => {
        throw new Error('source should not be read for a built-in agent')
      },
      resolve: () => {
        throw new Error('source should not be read for a built-in agent')
      },
      fetchTree: () => {
        throw new Error('source should not be read for a built-in agent')
      },
    }
    const recovered = createWorkflowRunner({
      driver,
      storage,
      environments: EnvironmentRegistry.load(),
      source: unusedSource,
      snapshots: new SubmissionSnapshotStore(join(root, 'snapshots')),
      sandbox: { cpus: 1, memoryMb: 512, scratchMb: 256 },
      recordingsDir: join(root, 'recordings'),
      imagePolicy: 'reuse',
      llmInternalPort: 9472,
      officialGrantIssuer: {
        issue: async (input) => {
          issued.push({ models: input.models, limits: input.limits })
          return { keys: { player_0: 'frozen-key' }, revoke: async () => {} }
        },
      },
      officialTelemetry: { aggregateByModel: () => ({}) },
    })
    const terminal = new Promise<string>((resolve) => {
      recovered.subscribe(run.id, (event) => {
        if (event.type === 'terminal') resolve(event.status)
      })
    })
    recovered.enqueue(run.id)
    expect(await terminal).toBe('completed')
    await recovered.shutdown()

    expect(issued).toEqual([
      {
        models: { small: { upstream: 'provider-at-creation', costWeight: 7 } },
        limits: { tokenBudget: 41, requestsPerMinute: 3 },
      },
    ])
    const reloaded = await storage.getRun(run.id)
    if (reloaded === undefined) throw new Error('run was not persisted')
    expect(decodeResolvedOfficialLlmPolicy(reloaded.llm_policy_snapshot)).toEqual(frozen)
  })
})
