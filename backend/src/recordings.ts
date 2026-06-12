/**
 * Read access to the recordings volume for the HTTP API.
 *
 * Sessions write recordings through the harness's `FolderRecordingStore` onto the shared volume —
 * one directory per recording, `<root>/<id>/recording.jsonl`. This is the read side the frontend
 * needs in this stage: list the ids with their headers, and stream a recording's JSONL. Retention,
 * quotas, and pinning are Stage 4 concerns; this lists and fetches only.
 */
import { createReadStream } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

import { parseHeader, type RecordingHeader } from '@game-sandbox/schema'

const RECORDING_FILE = 'recording.jsonl'
/** Headers are tiny; cap the header read so a huge recording never loads into memory for a listing. */
const HEADER_READ_LIMIT = 64 * 1024

export interface RecordingSummary {
  id: string
  header: RecordingHeader
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
        summaries.push({ id: entry.name, header })
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
}
