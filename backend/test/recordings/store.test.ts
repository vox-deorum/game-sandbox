import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RecordingsStore } from '../../src/recordings/store.js'

const HEADER =
  '{"created_at":"2026-06-11T00:00:00+00:00","environment":"hearts","parameters":{"players":3},"players":{"player_0":{"kind":"agent","builtin_name":"naive","label":"Naive agent"},"player_1":{"kind":"agent","builtin_name":"naive","label":"Naive agent"},"player_2":{"kind":"agent","builtin_name":"naive","label":"Naive agent"}},"schema_version":1,"seat_plan":"solo","seats":{"seat_0":["player_0"],"seat_1":["player_1"],"seat_2":["player_2"]},"seed":0}'
const STATE = '{"schema_version":1,"tick":0,"agents":{},"timing":{"started_at":1,"duration_ms":1}}'
const WIN_STATE = JSON.stringify({
  schema_version: 1,
  tick: 1,
  agents: {},
  overlay: { leaderboard_scores: [2, 8, 4] },
  timing: { started_at: 2, duration_ms: 1 },
})
const TIED_STATE = JSON.stringify({
  schema_version: 1,
  tick: 1,
  agents: {},
  overlay: { leaderboard_scores: [8, 2, 8] },
  timing: { started_at: 2, duration_ms: 1 },
})

describe('recordings store over the volume layout', () => {
  let root: string
  let store: RecordingsStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gs-rec-'))
    store = new RecordingsStore(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function writeRecording(id: string, lines: string[]): Promise<void> {
    await mkdir(join(root, id), { recursive: true })
    await writeFile(join(root, id, 'recording.jsonl'), `${lines.join('\n')}\n`, 'utf-8')
  }

  it('lists ids with their parsed headers, id-sorted', async () => {
    await writeRecording('flappy_bird-b', [HEADER, STATE])
    await writeRecording('flappy_bird-a', [HEADER])
    const summaries = await store.list()
    expect(summaries.map((s) => s.id)).toEqual(['flappy_bird-a', 'flappy_bird-b'])
    expect(summaries[0]?.header).toMatchObject({ schema_version: 1, environment: 'hearts' })
  })

  it('reads a header whose static overlay spans several read chunks', async () => {
    const map = `${'✓'.repeat(50 * 1024)}${'x'.repeat(100 * 1024)}`
    const header = JSON.stringify({
      ...(JSON.parse(HEADER) as object),
      overlay_static: { map },
    })
    await writeRecording('static-overlay', [header, STATE])

    expect((await store.readHeader('static-overlay'))?.overlay_static).toEqual({ map })
  })

  it('skips a directory whose header is missing or invalid', async () => {
    await writeRecording('good', [HEADER])
    await writeRecording('empty', [''])
    await writeRecording('garbage', ['not json'])
    expect((await store.list()).map((s) => s.id)).toEqual(['good'])
  })

  it('lists a unique final-state winner and uses -1 for a tie', async () => {
    await writeRecording('winner', [HEADER, STATE, WIN_STATE])
    await writeRecording('tie', [HEADER, TIED_STATE])

    const byId = new Map((await store.list()).map((summary) => [summary.id, summary]))
    expect(byId.get('winner')?.winner_id).toBe('seat_1')
    expect(byId.get('tie')?.winner_id).toBe(-1)
  })

  it('uses the newest complete state when the recording ends with a partial line', async () => {
    await writeRecording('partial', [HEADER, WIN_STATE, '{"schema_version":1'])
    expect((await store.list())[0]?.winner_id).toBe('seat_1')
  })

  it('reduces partnership player scores before choosing a winner', async () => {
    const partnershipHeader = JSON.stringify({
      schema_version: 1,
      environment: 'spades',
      parameters: { seat_plan: 'partnership' },
      players: Object.fromEntries(
        Array.from({ length: 4 }, (_, index) => [
          `player_${index}`,
          { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
        ]),
      ),
      seats: { seat_0: ['player_0', 'player_2'], seat_1: ['player_1', 'player_3'] },
      seat_plan: 'partnership',
    })
    await writeRecording('partnership', [
      partnershipHeader,
      JSON.stringify({
        schema_version: 1,
        tick: 1,
        agents: {},
        overlay: { leaderboard_scores: [12, 3, 12, 3] },
        timing: { started_at: 2, duration_ms: 1 },
      }),
    ])
    expect((await store.list())[0]?.winner_id).toBe('seat_0')
  })

  it('returns no recordings when the volume does not exist yet', async () => {
    const missing = new RecordingsStore(join(root, 'never-created'))
    expect(await missing.list()).toEqual([])
  })

  it('reports existence and streams the raw JSONL', async () => {
    await writeRecording('flappy_bird-1', [HEADER, STATE])
    expect(await store.exists('flappy_bird-1')).toBe(true)
    expect(await store.exists('nope')).toBe(false)

    const chunks: string[] = []
    for await (const chunk of store.stream('flappy_bird-1')) {
      chunks.push(chunk as string)
    }
    expect(chunks.join('')).toBe(`${HEADER}\n${STATE}\n`)
  })
})
