/**
 * Stage 9.4 end to end: a hungry Hearts submission exhausts its weighted token allowance in each
 * of two workflow games, catches the proxy's budget error, and keeps playing legal cards. The test
 * uses one local OpenAI-compatible upstream and the production listener, meter, grant, telemetry,
 * Docker relay, workflow, board, and placement paths. No external model service is contacted.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createDockerDriver } from '../../src/driver/docker/index.js'
import { EnvironmentRegistry } from '../../src/environments.js'
import { persistPlacementsForCompletedRun } from '../../src/leaderboards/placements.js'
import type { ResolvedOfficialLlmPolicy } from '../../src/llm/config.js'
import { LlmHandler } from '../../src/llm/handler.js'
import { KeyRegistry } from '../../src/llm/key-registry.js'
import { buildLlmListener } from '../../src/llm/listener.js'
import { LlmMeter } from '../../src/llm/meter.js'
import { TiktokenCounter } from '../../src/llm/tokenizer.js'
import { MODEL_ALIASES } from '../../src/llm/types.js'
import { UpstreamCaller } from '../../src/llm/upstream.js'
import { createOfficialGrantIssuer } from '../../src/session/official-grants.js'
import type { AgentRef, LlmUsageByModel } from '../../src/storage/index.js'
import { ExecutionTelemetryStore, type ExecutionUsageByModel } from '../../src/storage/llm/index.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'
import { SubmissionSnapshotStore } from '../../src/submission/snapshot-store.js'
import { createSubmissionSource } from '../../src/submission/source/index.js'
import type { RunEvent, TerminalRunStatus, WorkflowRunner } from '../../src/workflow/runner.js'
import { createWorkflowRunner } from '../../src/workflow/workflow-runner.js'
import { DEPS_VERSION } from './support/base-image.js'
import { createLlmUpstreamStub, RETRY_SUCCESS_ATTEMPTS } from './support/llm-upstream.js'

const ENV_ID = 'hearts'
const SUCCESSFUL_CALLS_PER_GAME = 2

const HUNGRY_AGENT = [
  'import sys',
  'from openai import OpenAI, OpenAIError',
  '',
  'class Agent:',
  '    def reset(self, seed):',
  '        self.call_id = 0',
  '',
  '    def act(self, observation):',
  '        try:',
  '            self.call_id += 1',
  '            OpenAI(max_retries=0).chat.completions.create(',
  '                model="small",',
  '                messages=[{"role": "user", "content": f"[stub:retry-success:call-{self.call_id}] Choose a Hearts card."}],',
  '                max_completion_tokens=1,',
  '                stream=False,',
  '            )',
  '        except OpenAIError as error:',
  '            if getattr(error, "code", None) != "budget_exceeded":',
  '                raise',
  '            if not getattr(self, "reported_error", False):',
  '                print(f"hungry-agent caught: {error}", file=sys.stderr, flush=True)',
  '                self.reported_error = True',
  '        mask = observation["action_mask"]',
  '        return min((card for card in range(52) if mask[card]), key=lambda c: (c % 13, c // 13))',
  '',
].join('\n')

describe('workflow LLM budget exhaustion (Docker)', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    const errors: unknown[] = []
    for (const dispose of cleanup.splice(0).reverse()) {
      try {
        await dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'integration cleanup failed')
  })

  it('refreshes the per-game allowance and persists only successful calls everywhere', async () => {
    const upstream = createLlmUpstreamStub()
    const upstreamAddress = await upstream.listen()
    cleanup.push(() => upstream.close())

    const root = mkdtempSync(join(tmpdir(), 'gs-wf-llm-budget-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const submissionTree = writeHungrySubmission()
    cleanup.push(() => rmSync(submissionTree, { recursive: true, force: true }))

    const storage = await openSqliteStorage(':memory:')
    cleanup.push(() => storage.close())
    const telemetry = new ExecutionTelemetryStore(resolve(root, 'llm'))
    cleanup.push(() => telemetry.close())
    const meter = new LlmMeter({ recoveryIntervalMs: 10 })
    cleanup.push(() => meter.close())
    const tokenizer = new TiktokenCounter('cl100k_base')
    cleanup.push(() => tokenizer.close())
    const registry = new KeyRegistry()
    const handler = new LlmHandler({
      meter,
      tokenizer,
      upstream: new UpstreamCaller({
        baseURL: `${upstreamAddress}/v1`,
        apiKey: 'upstream-secret',
        timeoutMs: 10_000,
        maxRetries: 2,
        retryIntervalMs: 20,
      }),
      options: { defaultMaxOutputTokens: 1, maxOutputTokens: 8 },
    })
    const listener = await buildLlmListener({ registry, handler })
    const listenerAddress = await listener.listen({ port: 0, host: '0.0.0.0' })
    cleanup.push(() => listener.close())
    const internalPort = portFrom(listenerAddress)

    const driver = await createDockerDriver(
      {
        imageTagPrefix: 'game-sandbox',
        imagePolicy: 'reuse',
        overlayBuildTimeoutMs: 120_000,
      },
      internalPort,
    )
    const policy: ResolvedOfficialLlmPolicy = {
      enabled: true,
      models: { small: { model: 'provider-small', cost_weight: 4 } },
      session: {
        // The accepted request reserves 31 raw tokens. At 4x, one committed 3-token call plus the
        // next reservation costs 136 units, while two committed calls plus another cost 148.
        token_budget: 140,
        rate_limit_rpm: 100,
      },
    }
    const runner = createWorkflowRunner({
      driver,
      storage,
      environments: EnvironmentRegistry.load(),
      source: createSubmissionSource({
        allowLocalSubmissions: true,
        gitTimeoutMs: 15_000,
        loadCheckTimeoutMs: 30_000,
        submissionMaxSizeBytes: 25 * 1024 * 1024,
      }),
      snapshots: new SubmissionSnapshotStore(resolve(root, 'submissions')),
      sandbox: { cpus: 1, memoryMb: 512, scratchMb: 256 },
      recordingsDir: resolve(root, 'recordings'),
      imagePolicy: 'reuse',
      llmInternalPort: internalPort,
      officialGrantIssuer: createOfficialGrantIssuer(registry, telemetry),
      officialTelemetry: telemetry,
      onRunComplete: async (runId, status) => {
        if (status === 'completed') await persistPlacementsForCompletedRun(storage, runId)
      },
    })
    cleanup.push(() => runner.shutdown())

    const season = await storage.createSeason({
      env_id: ENV_ID,
      deps_version: DEPS_VERSION,
      label: 'LLM budget integration',
    })
    const seeds = [17, 29]
    await storage.updateSeasonConfig(season.id, {
      deps_version: DEPS_VERSION,
      matches: [
        {
          slots: ['submission', 'builtin-naive', 'builtin-naive', 'builtin-naive'],
          seeds,
          games: 2,
        },
      ],
      overrides: {
        step_timeout_ms: 10_000,
        episode_timeout_ms: 180_000,
        llm: {
          enabled: true,
          models: ['small'],
          official: {
            token_budget: policy.session.token_budget,
            rate_limit_rpm: policy.session.rate_limit_rpm,
          },
        },
      },
    })
    const submission = await storage.createSubmission({
      season_id: season.id,
      env_id: ENV_ID,
      user_id: 'alice',
      source_kind: 'local',
      repo_url: null,
      commit_sha: null,
      local_path: submissionTree,
      ref: null,
      created_at: new Date().toISOString(),
    })
    await storage.updateSubmissionStatus(submission.id, 'ready')
    const submissionRef: AgentRef = {
      kind: 'submission',
      submission_id: submission.id,
      user_id: 'alice',
    }
    const slots: AgentRef[] = [
      submissionRef,
      { kind: 'builtin-naive' },
      { kind: 'builtin-naive' },
      { kind: 'builtin-naive' },
    ]
    const run = await storage.createRunWithSchedule(
      season.id,
      'operator',
      [submissionRef],
      seeds.map((seed, gameIndex) => ({
        match_index: 0,
        game_index: gameIndex,
        seed,
        slots,
      })),
      () => policy,
    )

    const terminal = await runToTerminal(runner, run.id)
    expect(terminal.status).toBe('completed')
    const budgetGameIndices = terminal.events.flatMap((event) =>
      event.type === 'log' && event.line.includes('budget_exceeded') ? [event.game_index] : [],
    )
    expect(budgetGameIndices).toEqual([0, 1])
    expect(existsSync(telemetry.pathForScope(run.id))).toBe(true)

    const games = await storage.listRunGames(run.id)
    const results = await storage.listGameResultsByRun(run.id)
    const calls = telemetry.listCalls(run.id)
    expect(games).toHaveLength(2)
    expect(calls, diagnosticText(terminal.events)).toHaveLength(
      SUCCESSFUL_CALLS_PER_GAME * games.length,
    )
    // Each accepted logical request retries twice through the real listener before the shared stub
    // returns one success. The durable store still receives exactly one row per logical request.
    expect(upstream.requests).toHaveLength(calls.length * RETRY_SUCCESS_ATTEMPTS)
    expect(upstream.requests.every((request) => request.model === 'provider-small')).toBe(true)
    expect(
      upstream.requests.every((request) => request.authorization === 'Bearer upstream-secret'),
    ).toBe(true)
    expect(
      games.map((game) => ({
        seed: game.seed,
        score: results.find(
          (result) => result.game_id === game.id && result.agent_submission_id === submission.id,
        )?.episode_score,
      })),
    ).toEqual([
      { seed: 17, score: 0 },
      { seed: 29, score: -2 },
    ])

    let attemptedSubmissionTurns = 0
    for (const game of games) {
      expect(game.status).toBe('completed')
      const gameCalls = telemetry.listCalls(run.id, { sessionId: game.id, slot: 'player_0' })
      expect(gameCalls).toHaveLength(SUCCESSFUL_CALLS_PER_GAME)
      expect(gameCalls.every((call) => call.model === 'small')).toBe(true)

      const gameResults = results.filter((result) => result.game_id === game.id)
      const submissionResult = gameResults.find(
        (result) => result.agent_submission_id === submission.id,
      )
      if (submissionResult === undefined) throw new Error(`missing result for game ${game.id}`)
      expect(submissionResult.failed).toBe(0)
      expect(submissionResult.failure_reason).toBeNull()
      expect(submissionResult.acted_tick_count).toBeGreaterThan(SUCCESSFUL_CALLS_PER_GAME)
      attemptedSubmissionTurns += submissionResult.acted_tick_count
      expect(submissionResult.llm_usage_by_model).toEqual(
        storedUsage(telemetry.aggregateByModel(run.id, { sessionId: game.id, slot: 'player_0' })),
      )
      expect(submissionResult.llm_weighted_cost).toBe(SUCCESSFUL_CALLS_PER_GAME * 3 * 4)
      expect(
        gameResults
          .filter((result) => result.agent_submission_id === null)
          .every((result) => result.llm_usage_by_model === null),
      ).toBe(true)
    }

    // The agent requests on every turn. Only two requests per game reached the upstream or acquired
    // a successful telemetry row, so later budget rejections stayed local and the next game reset it.
    expect(attemptedSubmissionTurns).toBeGreaterThan(calls.length)
    expect(new Set(calls.map((call) => call.sessionId))).toEqual(
      new Set(games.map((game) => game.id)),
    )

    const runUsage = storedUsage(telemetry.aggregateByModel(run.id, { slot: 'player_0' }))
    expect(runUsage).not.toBeNull()
    const board = await storage.getAutomatedBoard(season.id, run)
    const submissionBoard = board.find(
      (row) => row.agent.kind === 'submission' && row.agent.submission_id === submission.id,
    )
    if (submissionBoard === undefined) throw new Error('missing submitted agent from board')
    expect(submissionBoard.failure_count).toBe(0)
    expect(submissionBoard.games).toBe(2)
    expect(submissionBoard.llm_usage_by_model).toEqual(runUsage)
    expect(submissionBoard.llm_weighted_cost).toBe(SUCCESSFUL_CALLS_PER_GAME * games.length * 3 * 4)

    const placements = await storage.listPlacementsByAgent(submissionRef, ENV_ID)
    const placement = placements.find((row) => row.season_id === season.id)
    if (placement === undefined) throw new Error('missing submitted agent placement')
    expect(placement.run_id).toBe(run.id)
    expect(placement.failure_count).toBe(0)
    expect(placement.llm_usage_by_model).toEqual(runUsage)
    expect(placement.llm_weighted_cost).toBe(SUCCESSFUL_CALLS_PER_GAME * games.length * 3 * 4)
  }, 240_000)
})

function writeHungrySubmission(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gs-hungry-hearts-'))
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ entry_point: 'agent', class_name: 'Agent', template_version: DEPS_VERSION }),
  )
  writeFileSync(join(dir, 'agent.py'), HUNGRY_AGENT)
  return dir
}

function portFrom(address: string): number {
  const port = Number.parseInt(new URL(address).port, 10)
  if (!Number.isInteger(port) || port <= 0)
    throw new Error(`listener returned invalid address ${address}`)
  return port
}

function storedUsage(usage: ExecutionUsageByModel): LlmUsageByModel | null {
  for (const model of Object.keys(usage)) {
    if (!MODEL_ALIASES.some((alias) => alias === model)) {
      throw new Error(`execution telemetry contains unsupported model alias ${model}`)
    }
  }
  const stored: LlmUsageByModel = {}
  for (const model of MODEL_ALIASES) {
    const totals = usage[model]
    if (totals === undefined) continue
    stored[model] = {
      calls: totals.calls,
      estimated_calls: totals.estimatedCalls,
      input_tokens: totals.inputTokens,
      reasoning_tokens: totals.reasoningTokens,
      output_tokens: totals.outputTokens,
      latency_ms: totals.latencyMs,
    }
  }
  return Object.keys(stored).length === 0 ? null : stored
}

function runToTerminal(
  runner: WorkflowRunner,
  runId: string,
): Promise<{ status: TerminalRunStatus; events: RunEvent[] }> {
  return new Promise((resolve) => {
    const events: RunEvent[] = []
    const unsubscribe = runner.subscribe(runId, (event) => {
      events.push(event)
      if (event.type !== 'terminal') return
      unsubscribe()
      resolve({ status: event.status, events })
    })
    runner.enqueue(runId)
  })
}

function diagnosticText(events: readonly RunEvent[]): string {
  return events.flatMap((event) => (event.type === 'log' ? [event.line] : [])).join('\n')
}
