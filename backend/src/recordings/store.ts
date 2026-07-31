/**
 * Read access to the recordings volume for the HTTP API.
 *
 * Sessions write recordings through the harness's `FolderRecordingStore` onto the shared volume —
 * one directory per recording, `<root>/<id>/recording.jsonl`. This is the read side the frontend
 * needs in this stage: list the ids with their headers, and stream a recording's JSONL. Retention,
 * quotas, and pinning are Stage 4 concerns; this lists and fetches only.
 */
import { createReadStream } from 'node:fs'
import { open, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

import {
  parseHeader,
  parseStepState,
  type RecordingHeader,
  type StepState,
} from '@game-sandbox/schema'
import { reduceSeatScore } from '@game-sandbox/schema/environment'

const RECORDING_FILE = 'recording.jsonl'
/** Headers are tiny; cap the header read so a huge recording never loads into memory for a listing. */
const HEADER_READ_LIMIT = 64 * 1024
/** Read recordings from the end in bounded chunks when finding the final complete state. */
const TAIL_READ_SIZE = 64 * 1024

export interface RecordingSummary {
  id: string
  header: RecordingHeader
  /** The winning seat id (`seat_0`, `seat_1`, ...), -1 for a tie, or null without ranking data. */
  winner_id: string | -1 | null
}

export class RecordingsStore {
  constructor(private readonly root: string) {}

  /** Every readable recording's id and header, id-sorted; half-written or invalid ones are skipped. */
  async list(): Promise<RecordingSummary[]> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch {
      // No recordings volume yet — nothing has been recorded.
      return []
    }
    const summaries: RecordingSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const header = await this.readHeader(entry.name)
      if (header !== undefined) {
        const finalState = await this.lastState(entry.name)
        summaries.push({ id: entry.name, header, winner_id: winnerId(finalState, header) })
      }
    }
    summaries.sort((a, b) => a.id.localeCompare(b.id))
    return summaries
  }

  /** One recording's header, or `undefined` when it is missing or unreadable. */
  async readHeader(id: string): Promise<RecordingHeader | undefined> {
    const firstLine = await this.firstLine(id)
    if (firstLine === null) {
      return undefined
    }
    try {
      return parseHeader(JSON.parse(firstLine))
    } catch {
      return undefined
    }
  }

  /** Whether a recording exists on the volume. */
  async exists(id: string): Promise<boolean> {
    try {
      await stat(this.filePath(id))
      return true
    } catch {
      return false
    }
  }

  /** A readable stream of a recording's JSONL, for the fetch endpoint. */
  stream(id: string): Readable {
    return createReadStream(this.filePath(id), { encoding: 'utf-8' })
  }

  /**
   * Remove a recording's directory from the volume. Tolerant of a missing directory, so a sweep
   * that crashed after deleting the directory but before deleting the row cleans up on the retry
   * rather than throwing. The retention sweep removes the directory here, then the row.
   */
  async delete(id: string): Promise<void> {
    await rm(join(this.root, id), { recursive: true, force: true })
  }

  private filePath(id: string): string {
    return join(this.root, id, RECORDING_FILE)
  }

  /** Read just the header line without loading a whole (possibly large) recording. */
  private async firstLine(id: string): Promise<string | null> {
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(this.filePath(id), 'r')
    } catch {
      return null
    }
    try {
      const buffer = Buffer.alloc(HEADER_READ_LIMIT)
      const { bytesRead } = await handle.read(buffer, 0, HEADER_READ_LIMIT, 0)
      const text = buffer.toString('utf-8', 0, bytesRead)
      const newline = text.indexOf('\n')
      const line = newline === -1 ? text : text.slice(0, newline)
      return line.trim() === '' ? null : line
    } finally {
      await handle.close()
    }
  }

  /**
   * Read the last complete valid state without loading the full recording. A crashed writer may leave
   * a partial final line, so invalid tail lines are skipped until the newest valid state is found.
   */
  private async lastState(id: string): Promise<StepState | null> {
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(this.filePath(id), 'r')
    } catch {
      return null
    }
    try {
      let position = (await handle.stat()).size
      let suffix = ''
      while (position > 0) {
        const start = Math.max(0, position - TAIL_READ_SIZE)
        const buffer = Buffer.alloc(position - start)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
        const lines = `${buffer.toString('utf-8', 0, bytesRead)}${suffix}`.split('\n')
        suffix = lines.shift() ?? ''
        for (const line of lines.reverse()) {
          const state = parseStateLine(line)
          if (state !== null) {
            return state
          }
        }
        position = start
      }
      return null
    } finally {
      await handle.close()
    }
  }
}

function parseStateLine(line: string): StepState | null {
  if (line.trim() === '') {
    return null
  }
  try {
    return parseStepState(JSON.parse(line))
  } catch {
    return null
  }
}

/**
 * Resolve a winner or the -1 tie sentinel by reducing each seat's player scores. Recordings without
 * complete player ranking data are not eligible for a result label in the replay list.
 */
function winnerId(state: StepState | null, header: RecordingHeader): string | -1 | null {
  const scores = state?.overlay?.leaderboard_scores
  if (
    Array.isArray(scores) &&
    scores.length > 0 &&
    scores.every((score) => typeof score === 'number' && Number.isFinite(score))
  ) {
    const reduced = Object.entries(header.seats).flatMap(([seat, players]) => {
      const playerScores = players.map((player) => {
        const match = /^player_(\d+)$/.exec(player)
        return match === null ? undefined : scores[Number(match[1])]
      })
      return playerScores.every((score): score is number => typeof score === 'number')
        ? [[seat, reduceSeatScore(playerScores)] as const]
        : []
    })
    if (reduced.length !== Object.keys(header.seats).length) {
      return null
    }
    const best = Math.max(...reduced.map(([, score]) => score))
    const winners = reduced.flatMap(([seat, score]) => (score === best ? [seat] : []))
    return winners.length === 1 ? (winners[0] ?? null) : -1
  }

  return null
}
