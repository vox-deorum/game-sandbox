/**
 * The Stage 8.7 Docker-gated Spades-chat exit criteria, end to end against a real Docker daemon and
 * the real harness `ChatRouter`. These only mean something with a real container running the real
 * colocated Spades example agents through the real harness chat hook, so they live in this Docker-gated
 * lane rather than the harness's own (mocked) unit tests:
 *
 * - A real-driver Spades session seating the `daredevil` (broadcast) and `signaler` (targeted)
 *   example agents produces messages that appear both in a spectator's streamed lines (the broadcast)
 *   and in the full recording (broadcast and targeted alike).
 * - A `chat` command frame written into the container's stdin by the owner of a human-mode session
 *   is routed by the harness and lands in the recording, attributed to the human player.
 * - The built-in `/opt/agents/builtin/spades/naive` scripted baseline loads and plays a complete game when
 *   every seat is `builtin-agent`.
 * - A season's `overrides.messaging.enabled = false` silences chatty agents with no code change (the
 *   made nil becomes a set nil, exactly the workflow's messaging-off path), and a season cap lower
 *   than every example message's length drops them all the same way.
 * - The orchestrator resolves a live session's messaging rules from the play-open season's overrides,
 *   so setting them there before starting a session reproduces the same silence live.
 *
 * The daredevil demo hand is pinned against `environments/spades/tests/test_spades_chat.py`, the Python-side
 * integration test that drives the same examples through the same harness directly: seed 1236 with
 * `daredevil` at players 0/2 (partners) and the chat-less `counter` at 1/3 scores
 * `{player_0: 121, player_1: 46, player_2: 121, player_3: 46}` with messaging on, and the broadcast
 * text is exactly `"nil! cover me"`. The messaging-override test below asserts exactly those scores.
 *
 * The first test mixes that daredevil pair (for the broadcast) with `signaler` at 1/3 so a broadcast
 * and a targeted message ride the same game. Only the daredevil broadcast is a pinned scenario; the
 * signaler's targeted `"strong:<suit>"` signal is deterministic on this fixed seed (seat 1 is dealt a
 * side-suit ace, so it signals its partner) but this mixed roster is not a separately pinned Python
 * scenario, so that test asserts the signal's presence rather than its exact suit.
 */
import { copyFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readRecording } from '@game-sandbox/schema'
import Docker from 'dockerode'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDockerDriver } from '../../src/driver/docker/index.js'
import { EnvironmentRegistry } from '../../src/environments/registry.js'
import type { AgentRef } from '../../src/storage/index.js'
import { SubmissionSnapshotStore } from '../../src/submission/snapshot-store.js'
import { createSubmissionSource } from '../../src/submission/source/index.js'
import type { TerminalRunStatus } from '../../src/workflow/runner.js'
import { createWorkflowRunner } from '../../src/workflow/workflow-runner.js'
import { createRunOrFail } from '../support/harness.js'
import { TEST_DISABLED_OFFICIAL_LLM_POLICY } from '../support/llm-options.js'
import { DEPS_VERSION } from './support/base-image.js'
import { type Stack, startSession, startStack, waitForEnded } from './support/stack.js'
import { WsClient } from './support/ws-client.js'

const ENV_ID = 'spades'
const NIL_WARNING = 'nil! cover me'
/** The exact partnership-seat scores on the pinned daredevil-versus-counter hand with messaging on. */
const DAREDEVIL_SCORES_ON = { seat_0: 121, seat_1: 46 }

const BASE_SANDBOX = fileURLToPath(new URL('../../../templates/base/sandbox', import.meta.url))
const HARNESS_SOURCE = fileURLToPath(
  new URL('../../../harness/src/game_sandbox_harness', import.meta.url),
)
const LOCAL_PLAY = fileURLToPath(new URL('../../../environments/local_play', import.meta.url))
const SPADES_SANDBOX = fileURLToPath(
  new URL('../../../environments/spades/template/sandbox', import.meta.url),
)
const EXAMPLES_DIR = fileURLToPath(
  new URL('../../../environments/spades/examples', import.meta.url),
)

/** Skip `__pycache__` entries when copying a template/sandbox tree (mirrors hearts-multi-player). */
function skipPycache(src: string): boolean {
  return !/[\\/]__pycache__(?:[\\/]|$)/.test(src)
}

function skipGeneratedEnvironment(src: string): boolean {
  return skipPycache(src) && !/[\\/]sandbox[\\/]env(?:[\\/]|$)/.test(src)
}

/** Assemble one example's submission tree: the composed base+spades sandbox overlay, its agent.py,
 * and a manifest declaring the current deps version. Returns the tree's directory. */
function composeExampleTree(exampleName: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gs-spades-${exampleName}-`))
  cpSync(BASE_SANDBOX, join(dir, 'sandbox'), { recursive: true, filter: skipPycache })
  cpSync(HARNESS_SOURCE, join(dir, 'sandbox', 'harness'), { recursive: true, filter: skipPycache })
  for (const helper of [
    'card_utils.py',
    'card_spaces.py',
    'shared_modules.py',
    'semantic_cards.py',
  ]) {
    copyFileSync(join(LOCAL_PLAY, helper), join(dir, 'sandbox', helper))
  }
  // These examples import sandbox helpers only, never sandbox.env. Extend the recipe if that
  // constraint changes.
  cpSync(SPADES_SANDBOX, join(dir, 'sandbox'), {
    recursive: true,
    force: true,
    filter: skipGeneratedEnvironment,
  })
  copyFileSync(join(EXAMPLES_DIR, exampleName, 'agent.py'), join(dir, 'agent.py'))
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ entry_point: 'agent', class_name: 'Agent', template_version: DEPS_VERSION }),
  )
  return dir
}

/** Every message line across a recording's states, in tick order. */
function allMessages(states: ReturnType<typeof readRecording>['states']): Array<{
  from: string
  to: string | null
  text: string
}> {
  const out: Array<{ from: string; to: string | null; text: string }> = []
  for (const state of states) {
    for (const message of state.messages ?? []) {
      out.push(message)
    }
  }
  return out
}

/** Read the optional live chat contract without coupling this Docker-gated test to generated types. */
function chatOptions(state: object): { sender: string } | undefined {
  const value = (state as { chat_options?: unknown }).chat_options
  if (typeof value !== 'object' || value === null) return undefined
  const sender = (value as { sender?: unknown }).sender
  return typeof sender === 'string' ? { sender } : undefined
}

describe('Spades chat (Docker)', () => {
  let stack: Stack
  const trees: string[] = []

  beforeEach(async () => {
    // Local-source example trees need the dev gate on so the composed image builds from them.
    stack = await startStack({
      submission: {
        allowLocalSubmissions: true,
        gitTimeoutMs: 15_000,
        loadCheckTimeoutMs: 30_000,
        submissionMaxSizeBytes: 25 * 1024 * 1024,
      },
    })
  })

  afterEach(async () => {
    await stack.close()
    for (const tree of trees.splice(0)) {
      rmSync(tree, { recursive: true, force: true })
    }
    await removeSessionOverlayImages()
  })

  /** Seed a `ready` local-source Spades submission for `user` from `exampleName`'s agent.py. */
  async function seedExample(user: string, exampleName: string): Promise<string> {
    const season = await stack.storage.getPublicPlaySeason(ENV_ID)
    if (season === undefined) {
      throw new Error('no open spades play season')
    }
    const dir = composeExampleTree(exampleName)
    trees.push(dir)
    const submission = await stack.storage.createSubmission({
      season_id: season.id,
      env_id: ENV_ID,
      user_id: user,
      source_kind: 'local',
      repo_url: null,
      commit_sha: null,
      local_path: dir,
      ref: null,
      created_at: new Date().toISOString(),
    })
    await stack.storage.updateSubmissionStatus(submission.id, 'ready')
    return submission.id
  }

  /** Fetch and parse a session's recording. */
  async function fetchRecording(id: string): Promise<ReturnType<typeof readRecording>> {
    const response = await fetch(`${stack.httpBase}/api/recordings/${ENV_ID}-${id}`)
    expect(response.status).toBe(200)
    return readRecording(await response.text())
  }

  it('plays a real-driver Spades session with two chatting example agents whose messages appear in the streamed lines and the recording', async () => {
    const daredevil = await seedExample('daredevil', 'daredevil')
    const signaler = await seedExample('signaler', 'signaler')

    const { id, wsPath } = await startSession(
      stack,
      {
        env_id: ENV_ID,
        seats: {
          seat_0: { kind: 'submission', submission_id: daredevil },
          seat_1: { kind: 'submission', submission_id: signaler },
        },
        seed: 1236,
      },
      'dev-user',
    )

    // A spectator connects before the game finishes, so its streamed lines carry the broadcast
    // (spectators see broadcasts; a targeted message is withheld from a spectator's stream but is
    // still in the recording, per the relay's visibility rule).
    const spectator = await WsClient.connect(
      `${stack.wsBase}${wsPath}`,
      (await stack.users.headersFor('alice')).cookie,
    )
    try {
      const row = await waitForEnded(stack, id, 180_000)
      expect(row.termination_reason).toBe('terminated')

      await spectator.waitFor(
        () => spectator.states().some((state) => (state.messages ?? []).length > 0),
        15_000,
      )
      const streamedMessages = spectator.states().flatMap((state) => state.messages ?? [])
      expect(streamedMessages).toContainEqual({ from: 'player_0', to: null, text: NIL_WARNING })

      const { states } = await fetchRecording(id)
      const messages = allMessages(states)
      // The daredevil's broadcast warning is in the recording, and so is at least one signaler's
      // targeted message (whichever signaler bids and gets a turn to speak first on this seed).
      expect(messages).toContainEqual({ from: 'player_0', to: null, text: NIL_WARNING })
      expect(messages.some((m) => m.to !== null && m.text.startsWith('strong:'))).toBe(true)
    } finally {
      spectator.close()
    }
  }, 180_000)

  it('routes a `chat` frame written into container stdin through to the harness queue', async () => {
    // A human-mode partnership session has player_0 as the deterministic human and player_2 as its
    // companion. The owner sends the companion a targeted chat frame. Messaging
    // is on and the frame is well within the Spades cap (120), so the relay's pre-gate forwards it to
    // container stdin and the harness accepts it. The recording is the observable proof the frame
    // reached the harness queue: a message attributed from player_0 to player_2 can only exist if the
    // frame traversed stdin -> command pump -> chat queue -> router (delayed inbox delivery itself is
    // covered by the harness's own unit tests, which can inspect the in-process queue this test cannot).
    const companion = await seedExample('signaler_companion', 'signaler')
    const opponent = await seedExample('signaler_opponent', 'signaler')

    const { id, wsPath } = await startSession(
      stack,
      {
        env_id: ENV_ID,
        seats: {
          seat_0: {
            kind: 'human',
            companion: { kind: 'submission', submission_id: companion },
          },
          seat_1: { kind: 'submission', submission_id: opponent },
        },
        seed: 3,
      },
      'dev-user',
    )

    const owner = await WsClient.connect(
      `${stack.wsBase}${wsPath}`,
      (await stack.users.headersFor('dev-user')).cookie,
    )
    try {
      // The active human policy identifies the designated sender. The harness admits the frame at
      // its next boundary, independent of the state that caused the browser to render this policy.
      await owner.waitFor(
        () => owner.states().some((state) => chatOptions(state)?.sender === 'player_0'),
        30_000,
      )
      owner.send({
        kind: 'chat',
        player: 'player_0',
        to: 'player_2',
        text: 'partner, watch the spades',
      })

      await waitForEnded(stack, id, 180_000)
      const { states } = await fetchRecording(id)
      const messages = allMessages(states)
      expect(messages).toContainEqual({
        from: 'player_0',
        to: 'player_2',
        text: 'partner, watch the spades',
      })
    } finally {
      owner.close()
    }
  }, 180_000)

  it('loads the built-in /opt/agents/builtin/spades/naive agent under the explicit four-seat solo plan', async () => {
    const { id } = await startSession(
      stack,
      {
        env_id: ENV_ID,
        parameters: { seat_plan: 'solo' },
        seats: {
          seat_0: { kind: 'builtin-agent', name: 'naive' },
          seat_1: { kind: 'builtin-agent', name: 'naive' },
          seat_2: { kind: 'builtin-agent', name: 'naive' },
          seat_3: { kind: 'builtin-agent', name: 'naive' },
        },
        seed: 42,
      },
      'dev-user',
    )

    const row = await waitForEnded(stack, id, 180_000)
    expect(row.termination_reason).toBe('terminated')

    const { header, states } = await fetchRecording(id)
    expect(header.environment).toBe(ENV_ID)
    expect(states.length).toBeGreaterThan(0)
    for (let i = 0; i < 4; i++) {
      expect(header.players?.[`player_${i}`]?.kind).toBe('agent')
    }
  }, 180_000)

  it('silences chatty agents and rejects over-cap sends through overrides.messaging with no code change', async () => {
    const driver = await createDockerDriver({
      imageTagPrefix: 'game-sandbox',
      imagePolicy: 'reuse',
      overlayBuildTimeoutMs: 120_000,
      llmRelay: { mode: 'host-gateway' },
    })
    // The runner must write recordings into the SAME directory `stack.recordings` reads from, or the
    // `stack.recordings.stream(recording_id)` below can't find the file (the runner's own recordingsDir
    // would be a different tree). Only the snapshot store needs a throwaway dir of its own here.
    const snapshotsDir = mkdtempSync(join(tmpdir(), 'gs-spades-wf-snap-'))
    const runner = createWorkflowRunner({
      driver,
      storage: stack.storage,
      environments: EnvironmentRegistry.load(),
      source: createSubmissionSource({
        allowLocalSubmissions: true,
        gitTimeoutMs: 15_000,
        loadCheckTimeoutMs: 30_000,
        submissionMaxSizeBytes: 25 * 1024 * 1024,
      }),
      snapshots: new SubmissionSnapshotStore(resolve(join(snapshotsDir, 'submissions'))),
      sandbox: { cpus: 1, memoryMb: 512, memoryPerPlayerMb: 32, scratchMb: 256 },
      recordingsDir: stack.recordingsDir,
      imagePolicy: 'reuse',
    })

    try {
      const daredevil = await seedExample('daredevil', 'daredevil')
      const counter = await seedExample('counter', 'counter')
      const submissions: AgentRef[] = [
        { kind: 'submission', submission_id: daredevil, user_id: 'daredevil' },
        { kind: 'submission', submission_id: counter, user_id: 'counter' },
      ]

      /** Run a fresh season with the given messaging override and return the one game's recording
       * plus its per-seat final scores, via the real workflow runner. */
      async function runWithOverride(
        messaging: { enabled?: boolean; message_cap?: number } | undefined,
        seatPlan: 'partnership' | 'solo' = 'partnership',
      ): Promise<{
        messages: ReturnType<typeof allMessages>
        scoreBySeat: Record<number, number>
      }> {
        const scheduledSeats =
          seatPlan === 'partnership'
            ? submissions
            : [
                submissions[0] as AgentRef,
                submissions[1] as AgentRef,
                submissions[0] as AgentRef,
                submissions[1] as AgentRef,
              ]
        const season = await stack.storage.createSeason({
          env_id: ENV_ID,
          deps_version: DEPS_VERSION,
          label: null,
        })
        await stack.storage.updateSeasonConfig(season.id, {
          deps_version: DEPS_VERSION,
          matches: [
            {
              seats: scheduledSeats.map(() => 'submission' as const),
              seeds: [1236],
              games: 1,
            },
          ],
          ...(messaging !== undefined ? { overrides: { messaging } } : {}),
        })
        const run = await createRunOrFail(stack.storage, season.id, 'dev-user', () => ({
          parametersSnapshot: { seat_plan: seatPlan },
          scheduledGames: [
            {
              match_index: 0,
              game_index: 0,
              seed: 1236,
              seats: scheduledSeats,
              seat_plan: seatPlan,
            },
          ],
          llmPolicy: TEST_DISABLED_OFFICIAL_LLM_POLICY,
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
        expect(status).toBe('completed')

        const games = await stack.storage.listRunGames(run.id)
        expect(games).toHaveLength(1)
        const game = games[0]
        expect(game?.recording_id).not.toBeNull()
        const text = await streamToString(stack.recordings.stream(game?.recording_id as string))
        const { states } = readRecording(text)
        // The authoritative per-seat final score is the game-result row's episode_score (the
        // normalized higher-is-better leaderboard score the runner derives from the recording),
        // keyed by seat index. The recording's per-tick cumulative `score` field is NOT a reliable
        // source: Spades credits its terminal team reward on the final actor's line only, so a seat's
        // own step lines never carry its team total.
        const results = await stack.storage.listGameResultsByRun(run.id)
        const scoreBySeat: Record<number, number> = {}
        for (const result of results) {
          scoreBySeat[result.seat_index] = result.episode_score
        }
        return { messages: allMessages(states), scoreBySeat }
      }

      // Messaging on (default season, no override): the exact pinned demo-hand scores, matching
      // environments/spades/tests/test_spades_chat.py's daredevil score regression.
      // The partnership reducer preserves the team score as its mean.
      const on = await runWithOverride(undefined)
      expect(on.messages).toContainEqual({ from: 'player_0', to: null, text: NIL_WARNING })
      expect(on.scoreBySeat[0]).toBe(DAREDEVIL_SCORES_ON.seat_0)
      expect(on.scoreBySeat[1]).toBe(DAREDEVIL_SCORES_ON.seat_1)

      // Messaging disabled by the season override: no code change to the agents, yet the broadcast
      // never arrives, the partner never covers, and the nil is set — a strictly worse team score
      // than the made-nil case above (the same qualitative consequence the Python harness test pins).
      const off = await runWithOverride({ enabled: false })
      expect(off.messages).toEqual([])
      expect(off.scoreBySeat[0]).toBeLessThan(DAREDEVIL_SCORES_ON.seat_0)

      // Messaging enabled but the cap lowered below every example message's length (13-15 code
      // points): validate_outgoing drops every send, so the recording again has zero messages and
      // the nil is set exactly as with messaging off.
      const cappedLow = await runWithOverride({ message_cap: 5 })
      expect(cappedLow.messages).toEqual([])
      expect(cappedLow.scoreBySeat[0]).toBeLessThan(DAREDEVIL_SCORES_ON.seat_0)

      // The same real workflow path also expands and reduces the explicit four-seat solo plan.
      const solo = await runWithOverride({ enabled: false }, 'solo')
      expect(solo.messages).toEqual([])
      expect(Object.keys(solo.scoreBySeat).sort()).toEqual(['0', '1', '2', '3'])
      expect(solo.scoreBySeat[0]).toBe(solo.scoreBySeat[2])
      expect(solo.scoreBySeat[1]).toBe(solo.scoreBySeat[3])
    } finally {
      rmSync(snapshotsDir, { recursive: true, force: true })
    }
  }, 300_000)

  it('picks up the play-open season overrides live through the orchestrator, silencing chatty agents', async () => {
    const season = await stack.storage.getPublicPlaySeason(ENV_ID)
    if (season === undefined) {
      throw new Error('no open spades play season')
    }
    // Turn messaging off on the environment's live play-open season; the orchestrator resolves this
    // at session start and ANDs it with the environment metadata (spades is messaging-enabled by
    // default), so the effective rule for every session against this season becomes disabled.
    const result = await stack.storage.updateSeasonConfig(season.id, {
      deps_version: DEPS_VERSION,
      matches: [],
      overrides: { messaging: { enabled: false } },
    })
    expect(result.ok).toBe(true)

    const daredevil = await seedExample('daredevil', 'daredevil')
    const counter = await seedExample('counter', 'counter')

    const { id } = await startSession(
      stack,
      {
        env_id: ENV_ID,
        seats: {
          seat_0: { kind: 'submission', submission_id: daredevil },
          seat_1: { kind: 'submission', submission_id: counter },
        },
        seed: 1236,
      },
      'dev-user',
    )

    const row = await waitForEnded(stack, id, 180_000)
    expect(row.termination_reason).toBe('terminated')

    const { states } = await fetchRecording(id)
    // The live session's resolved messaging rule (persisted on the session row and handed to the
    // container config) silenced the table: no broadcast ever arrives, so the recording carries no
    // messages at all. A live session produces no game-results row, so the message absence — not a
    // score — is the driver-level proof the orchestrator applied the play-open season's override here
    // (the behavioural score consequence of the same silence is pinned in the workflow path above).
    expect(allMessages(states)).toEqual([])
  }, 180_000)
})

/** Drain a readable stream to a string (the recording JSONL for `readRecording`). */
async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf-8'))
  }
  return chunks.join('')
}

/** Remove every composed session-overlay image this suite built, tolerating already-absent ones. */
async function removeSessionOverlayImages(): Promise<void> {
  const docker = new Docker()
  const images = await docker.listImages()
  for (const image of images) {
    for (const tag of image.RepoTags ?? []) {
      if (tag.startsWith('game-sandbox/session-overlay:')) {
        await docker
          .getImage(tag)
          .remove({ force: true })
          .catch(() => undefined)
      }
    }
  }
}
