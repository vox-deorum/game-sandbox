import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RecordingsStore } from '../src/recordings.js'

const HEADER =
  '{"created_at":"2026-06-11T00:00:00+00:00","environment":"flappy_bird","schema_version":1,"seed":0}'
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
    expect(summaries[0]?.header).toMatchObject({ schema_version: 1, environment: 'flappy_bird' })
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
    expect(byId.get('winner')?.winner_id).toBe('P1')
    expect(byId.get('tie')?.winner_id).toBe(-1)
  })

  it('uses the newest complete state when the recording ends with a partial line', async () => {
    await writeRecording('partial', [HEADER, WIN_STATE, '{"schema_version":1'])
    expect((await store.list())[0]?.winner_id).toBe('P1')
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
