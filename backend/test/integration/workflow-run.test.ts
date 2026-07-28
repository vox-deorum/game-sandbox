/**
 * The Stage 6.4 exit criterion end to end against a real Docker daemon: a small season runs to
 * completion through the workflow runner. It uses a worked Flappy Bird example as a submission plus
 * the always-scheduled Naive baseline, with two seeds, and asserts every game produced a replayable
 * recording with a valid header and that the deterministic example reproduces an identical
 * `episode_score` across two runs.
 *
 * It reuses the Stage 5 Docker-gated harness — the base image built in global setup, the overlay built
 * from a local-source submission — rather than standing up new container plumbing. Gated behind the
 * Docker daemon like the rest of the integration suite.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { readRecording } from '@game-sandbox/schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDockerDriver } from '../../src/driver/docker/index.js'
import { EnvironmentRegistry } from '../../src/environments.js'
import type { ResolvedOfficialLlmPolicy } from '../../src/llm/config.js'
import { RecordingsStore } from '../../src/recordings.js'
import type { AgentRef, SeasonRun, Storage } from '../../src/storage/index.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'
import { SubmissionSnapshotStore } from '../../src/submission/snapshot-store.js'
import { createSubmissionSource } from '../../src/submission/source/index.js'
import type { TerminalRunStatus, WorkflowRunner } from '../../src/workflow/runner.js'
import { createWorkflowRunner } from '../../src/workflow/workflow-runner.js'
import { createRunOrFail } from '../support/harness.js'
import { DEPS_VERSION } from './support/base-image.js'

const ENV_ID = 'flappy_bird'

function disabledLlmPolicy(): ResolvedOfficialLlmPolicy {
  return {
    enabled: false,
    models: {},
    session: { token_budget: 1, rate_limit_rpm: 1 },
  }
}
/** A deterministic agent: flap on a fixed period so the episode is a pure function of the seed. */
const DETERMINISTIC_AGENT = [
  'class Agent:',
  '    def reset(self, seed):',
  '        self.tick = 0',
  '    def act(self, observation):',
  '        self.tick += 1',
  '        return 1 if self.tick % 8 == 0 else 0',
  '',
].join('\n')

/** Write a worked-example submission tree (manifest + deterministic agent); return its path. */
function writeExample(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gs-wf-'))
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ entry_point: 'agent', class_name: 'Agent', template_version: DEPS_VERSION }),
  )
  writeFileSync(join(dir, 'agent.py'), DETERMINISTIC_AGENT)
  return dir
}

describe('workflow run end to end (Docker)', () => {
  let storage: Storage
  let recordingsDir: string
  let recordings: RecordingsStore
  let runner: WorkflowRunner
  let runnerLogs: string[]
  const trees: string[] = []

  beforeEach(async () => {
    storage = await openSqliteStorage(':memory:')
    recordingsDir = mkdtempSync(join(tmpdir(), 'gs-wf-rec-'))
    recordings = new RecordingsStore(resolve(recordingsDir))
    runnerLogs = []
    const driver = await createDockerDriver({
      imageTagPrefix: 'game-sandbox',
      imagePolicy: 'reuse',
      overlayBuildTimeoutMs: 120_000,
    })
    runner = createWorkflowRunner({
      driver,
      storage,
      environments: EnvironmentRegistry.load(),
      source: createSubmissionSource({
        allowLocalSubmissions: true,
        gitTimeoutMs: 15_000,
        loadCheckTimeoutMs: 30_000,
        submissionMaxSizeBytes: 25 * 1024 * 1024,
      }),
      snapshots: new SubmissionSnapshotStore(resolve(join(recordingsDir, 'submissions'))),
      sandbox: { cpus: 1, memoryMb: 512, memoryPerPlayerMb: 32, scratchMb: 256 },
      recordingsDir: resolve(recordingsDir),
      imagePolicy: 'reuse',
      log: (message) => runnerLogs.push(message),
    })
  })

  afterEach(async () => {
    await storage.close()
    rmSync(recordingsDir, { recursive: true, force: true })
    for (const tree of trees.splice(0)) {
      rmSync(tree, { recursive: true, force: true })
    }
  })

  /** Run a fresh run for the season to completion and return the per-game submission scores. */
  async function runOnce(
    seasonId: string,
    submissions: AgentRef[],
    seeds: number[],
  ): Promise<{ run: SeasonRun; status: TerminalRunStatus }> {
    const submissionRef = submissions[0] as AgentRef
    const schedule = [
      // Two submission games (one per seed), then the always-scheduled Naive baseline on each seed.
      {
        match_index: 0,
        game_index: 0,
        seed: seeds[0] as number,
        seats: [submissionRef],
        seat_plan: 'solo',
      },
      {
        match_index: 0,
        game_index: 1,
        seed: seeds[1] as number,
        seats: [submissionRef],
        seat_plan: 'solo',
      },
      {
        match_index: 0,
        game_index: 2,
        seed: seeds[0] as number,
        seats: [{ kind: 'builtin', name: 'naive' } as AgentRef],
        seat_plan: 'solo',
      },
      {
        match_index: 0,
        game_index: 3,
        seed: seeds[1] as number,
        seats: [{ kind: 'builtin', name: 'naive' } as AgentRef],
        seat_plan: 'solo',
      },
    ]
    const run = await createRunOrFail(storage, seasonId, 'dev-user', () => ({
      parametersSnapshot: { players: 1, pipe_gap: 100 },
      scheduledGames: schedule,
      llmPolicy: disabledLlmPolicy(),
    }))
    const status = await new Promise<TerminalRunStatus>((res) => {
      const unsubscribe = runner.subscribe(run.id, (event) => {
        if (event.type === 'terminal') {
          unsubscribe()
          res(event.status)
        }
      })
      runner.enqueue(run.id)
    })
    return { run, status }
  }

  it('runs a submission plus Naive baseline over two seeds and reproduces deterministic scores', async () => {
    const tree = writeExample()
    trees.push(tree)
    const seeds = [11, 22]

    const season = await storage.createSeason({
      env_id: ENV_ID,
      deps_version: DEPS_VERSION,
      label: null,
    })
    await storage.updateSeasonConfig(season.id, {
      deps_version: DEPS_VERSION,
      matches: [{ seats: ['submission'], seeds, games: 2 }],
    })
    const submission = await storage.createSubmission({
      season_id: season.id,
      env_id: ENV_ID,
      user_id: 'alice',
      source_kind: 'local',
      repo_url: null,
      commit_sha: null,
      local_path: tree,
      ref: null,
      created_at: new Date().toISOString(),
    })
    await storage.updateSubmissionStatus(submission.id, 'ready')
    const submissionRef: AgentRef = {
      kind: 'submission',
      submission_id: submission.id,
      user_id: 'alice',
    }

    const first = await runOnce(season.id, [submissionRef], seeds)
    expect(first.status, runnerLogs.join('\n')).toBe('completed')

    const games = await storage.listRunGames(first.run.id)
    expect(games).toHaveLength(4)
    // Every game has a replayable recording with a valid header on the shared volume.
    for (const game of games) {
      expect(game.status).toBe('completed')
      expect(game.recording_id).not.toBeNull()
      const text = await streamToString(recordings.stream(game.recording_id as string))
      const parsed = readRecording(text)
      expect(parsed.header.environment).toBe(ENV_ID)
      expect(parsed.states.length).toBeGreaterThan(0)
    }

    // The submission's per-seed scores from the first run, keyed by seed.
    const firstScores = await submissionScoresBySeed(storage, first.run.id, submission.id)

    // Re-run the same configuration: a fresh run, same deterministic schedule and seeds.
    const second = await runOnce(season.id, [submissionRef], seeds)
    expect(second.status).toBe('completed')
    expect(second.run.id).not.toBe(first.run.id)
    expect((await storage.getLatestCompletedRun(season.id))?.id).toBe(second.run.id)

    const secondScores = await submissionScoresBySeed(storage, second.run.id, submission.id)
    expect(secondScores).toEqual(firstScores)
  }, 180_000)
})

/** The submission seat's episode score per seed in a run, so two runs' deterministic scores compare. */
async function submissionScoresBySeed(
  storage: Storage,
  runId: string,
  submissionId: string,
): Promise<Record<number, number>> {
  const games = await storage.listRunGames(runId)
  const results = await storage.listGameResultsByRun(runId)
  const byGame = new Map(games.map((g) => [g.id, g.seed]))
  const scores: Record<number, number> = {}
  for (const result of results) {
    if (result.agent_submission_id === submissionId) {
      const seed = byGame.get(result.game_id)
      if (seed !== undefined) {
        scores[seed] = result.episode_score
      }
    }
  }
  return scores
}

/** Drain a readable stream to a string (the recording JSONL for `readRecording`). */
async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf-8'))
  }
  return chunks.join('')
}
