/**
 * The Stage 7.5 exit criteria, end to end against a real Docker daemon: a multi-agent Hearts session
 * runs through the real execution driver, the composed multi-submission session image overlays every
 * submitted slot in its own per-slot directory, and the harness steps every seat in turn.
 *
 * These only mean something with real containers, so they live in the Docker-gated lane:
 *
 * - A four-seat Hearts session steps each seat in turn, recording a per-slot action and per-slot
 *   timing for every seat.
 * - Two submissions that both ship an `agent` module run in one session with no import collision,
 *   each filling two slots, so the same submission also runs as two independent instances. Each
 *   module executes its own code (a fast seat versus a deliberately slow one).
 * - A human-controlled slot that never receives input stalls past its window and auto-plays the
 *   environment's `default_action` (the lowest legal card) every turn, and the game still completes.
 *
 * Submissions are seeded as local-source trees (no git), so the composed image is built from those
 * trees through the same driver a production multi-agent start uses. Gated behind the Docker daemon
 * like the rest of the integration suite (the base image is built in global setup).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type AgentStep, readRecording, type StepState } from '@game-sandbox/schema'
import Docker from 'dockerode'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEPS_VERSION } from './support/base-image.js'
import {
  type SessionRow,
  type Stack,
  startSession,
  startStack,
  waitForEnded,
} from './support/stack.js'

const SEED = 7
/** Four players take thirteen cards each, so a full game is exactly fifty-two recorded plays. */
const TOTAL_PLAYS = 52
const PLAYS_PER_SEAT = 13
/** The timeout sentinel the env records for an auto-played (timed-out) turn (hearts `AUTO_ACTION`). */
const AUTO_ACTION = -1

/** A Hearts agent that always plays its lowest legal card (lowest index in the legal-action mask). */
const LOWEST_AGENT = [
  'class Agent:',
  '    def reset(self, seed):',
  '        pass',
  '    def act(self, observation):',
  '        mask = observation["action_mask"]',
  '        return min(card for card in range(52) if mask[card])',
  '',
].join('\n')

/**
 * A lowest-card agent that deliberately spends ~50 ms per move (well under the 1 s step limit). It
 * plays identically to LOWEST_AGENT, so the game is unchanged, but its per-move time is a
 * deal-independent signature: a seat whose recorded decision time is this slow can only have run
 * this module's code, not a colliding one's.
 */
const SLOW_AGENT = [
  'import time',
  '',
  'class Agent:',
  '    def reset(self, seed):',
  '        pass',
  '    def act(self, observation):',
  '        time.sleep(0.05)',
  '        mask = observation["action_mask"]',
  '        return min(card for card in range(52) if mask[card])',
  '',
].join('\n')

describe('multi-agent Hearts session (Docker)', () => {
  let stack: Stack
  const trees: string[] = []

  beforeEach(async () => {
    // Local-source submissions need the dev gate on so the composed image builds from their trees.
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
    // The composed session images are session-scoped and outside the eviction pool, so reclaim the
    // ones this run created to keep the host clean (the per-test compositions never repeat).
    await removeSessionOverlayImages()
  })

  /** Seed a `ready` local-source Hearts submission for `user`, returning its id. */
  async function seedSubmission(user: string, source: string): Promise<string> {
    const season = await stack.storage.getPublicPlaySeason('hearts')
    if (season === undefined) {
      throw new Error('no open hearts play season')
    }
    const dir = mkdtempSync(join(tmpdir(), 'gs-hearts-'))
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ entry_point: 'agent', class_name: 'Agent', template_version: DEPS_VERSION }),
    )
    writeFileSync(join(dir, 'agent.py'), source)
    trees.push(dir)
    const submission = await stack.storage.createSubmission({
      season_id: season.id,
      env_id: 'hearts',
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

  /** Start a Hearts session, wait for it to end, and return the row plus the parsed recording. */
  async function playHearts(
    slots: Record<string, { kind: 'human' | 'submission'; submission_id?: string }>,
    extra: { human_slot_timeout_ms?: number } = {},
  ): Promise<{
    id: string
    row: SessionRow
    states: StepState[]
    header: ReturnType<typeof readRecording>['header']
  }> {
    const { id } = await startSession(
      stack,
      { env_id: 'hearts', slots, seed: SEED, ...extra },
      'dev-user',
    )
    const row = await waitForEnded(stack, id, 90_000)
    const response = await fetch(`${stack.httpBase}/api/recordings/hearts-${id}`)
    expect(response.status).toBe(200)
    const { header, states } = readRecording(await response.text())
    return { id, row, states, header }
  }

  it('steps every Hearts seat in turn with a per-slot action and per-slot timing', async () => {
    // Four distinct submissions, one per seat: a four-entry composed session image, each overlaid in
    // its own per-slot directory and loaded as its own instance.
    const slots: Record<string, { kind: 'submission'; submission_id: string }> = {}
    for (let i = 0; i < 4; i++) {
      const id = await seedSubmission(`seat_${i}`, LOWEST_AGENT)
      slots[`player_${i}`] = { kind: 'submission', submission_id: id }
    }

    const { row, states, header } = await playHearts(slots)

    expect(row.termination_reason).toBe('terminated')
    expect(states).toHaveLength(TOTAL_PLAYS)

    const actions = valuesBySeat(states, (step) => step.action)
    const decisions = valuesBySeat(states, (step) => step.timing?.decision_ms)
    for (let i = 0; i < 4; i++) {
      const seat = `player_${i}`
      // Every seat takes its turns (thirteen plays across the thirteen tricks), and every play of
      // every seat carries its own decision time: per-slot stepping with a per-slot move clock.
      expect(actions.get(seat)?.length).toBe(PLAYS_PER_SEAT)
      expect(decisions.get(seat)?.length).toBe(PLAYS_PER_SEAT)
      // Each seat is attributed to its own submission in the recording header.
      expect(header.players?.[seat]?.kind).toBe('agent')
      expect(header.players?.[seat]?.submission_id).toBe(slots[seat]?.submission_id)
    }
  })

  it('runs two `agent`-module submissions across four seats, each filling two slots, with no collision', async () => {
    // Two distinct submissions, both shipping a module named `agent`: a fast lowest-card player and a
    // deliberately slow one, each filling two seats. Both play the same cards, so the discriminator is
    // their per-move time, which is independent of the deal. Each submission filling two seats also
    // exercises self-play: the same submission must run as two independent instances. If the two
    // `agent` modules collided, all four seats would run one submission's code and the slow seats
    // would not be measurably slower.
    const fast = await seedSubmission('fast_player', LOWEST_AGENT)
    const slow = await seedSubmission('slow_player', SLOW_AGENT)
    const slots = {
      player_0: { kind: 'submission' as const, submission_id: fast },
      player_1: { kind: 'submission' as const, submission_id: fast },
      player_2: { kind: 'submission' as const, submission_id: slow },
      player_3: { kind: 'submission' as const, submission_id: slow },
    }

    const { id, row, states } = await playHearts(slots)
    expect(row.termination_reason).toBe('terminated')

    // Every seat acted to the end, including both instances of each twice-seated submission.
    const actions = valuesBySeat(states, (step) => step.action)
    for (let i = 0; i < 4; i++) {
      expect(actions.get(`player_${i}`)?.length).toBe(PLAYS_PER_SEAT)
    }

    const decisions = valuesBySeat(states, (step) => step.timing?.decision_ms)
    const slowMs = median([
      ...(decisions.get('player_2') ?? []),
      ...(decisions.get('player_3') ?? []),
    ])
    const fastMs = median([
      ...(decisions.get('player_0') ?? []),
      ...(decisions.get('player_1') ?? []),
    ])
    // The slow submission's seats spend ~50 ms per move; the fast one's are near-instant. Each module
    // ran its own code: a collision onto the fast module would make the slow seats fast too.
    expect(slowMs).toBeGreaterThan(40)
    expect(fastMs).toBeLessThan(25)

    // One attribution row per submitted slot, naming the submission that actually filled it (so the
    // same submission appears against both of its slots).
    const rows = await stack.storage.listSessionSubmissions(id)
    expect(sortedSlotMap(rows)).toEqual([
      { slot_id: 'player_0', submission_id: fast },
      { slot_id: 'player_1', submission_id: fast },
      { slot_id: 'player_2', submission_id: slow },
      { slot_id: 'player_3', submission_id: slow },
    ])
  })

  it('auto-plays a legal move when a human slot stalls past its window', async () => {
    // One human seat with a short window and never any input; three submitted agents fill the rest.
    const agents = await Promise.all([
      seedSubmission('stall_a', LOWEST_AGENT),
      seedSubmission('stall_b', LOWEST_AGENT),
      seedSubmission('stall_c', LOWEST_AGENT),
    ])
    const slots = {
      player_0: { kind: 'human' as const },
      player_1: { kind: 'submission' as const, submission_id: agents[0] },
      player_2: { kind: 'submission' as const, submission_id: agents[1] },
      player_3: { kind: 'submission' as const, submission_id: agents[2] },
    }

    const { row, states, header } = await playHearts(slots, { human_slot_timeout_ms: 200 })

    // The game completed, so every auto-played human move was legal.
    expect(row.termination_reason).toBe('terminated')
    expect(header.players?.player_0?.kind).toBe('human')

    const humanActions = valuesBySeat(states, (step) => step.action).get('player_0') ?? []
    expect(humanActions).toHaveLength(PLAYS_PER_SEAT)
    // Every human turn stalled past its window and auto-played the env default (the timeout sentinel
    // the env resolves to the lowest legal card), so each recorded human action is that sentinel.
    expect(humanActions.every((action) => action === AUTO_ACTION)).toBe(true)
  })
})

/** Collect each seat's numeric values from one per-step field, in tick order, from the recording. */
function valuesBySeat(
  states: StepState[],
  select: (step: AgentStep) => unknown,
): Map<string, number[]> {
  const bySeat = new Map<string, number[]>()
  for (const state of states) {
    for (const [seat, step] of Object.entries(state.agents)) {
      const value = select(step)
      if (typeof value === 'number') {
        const values = bySeat.get(seat) ?? []
        values.push(value)
        bySeat.set(seat, values)
      }
    }
  }
  return bySeat
}

/** The median of a list of numbers; 0 for an empty list. */
function median(values: number[]): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0)
}

/** The session-submission rows as a sorted, comparable slot-to-submission list. */
function sortedSlotMap(
  rows: { slot_id: string; submission_id: string }[],
): { slot_id: string; submission_id: string }[] {
  return [...rows]
    .map((entry) => ({ slot_id: entry.slot_id, submission_id: entry.submission_id }))
    .sort((a, b) => a.slot_id.localeCompare(b.slot_id))
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
