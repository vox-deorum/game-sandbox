import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { settleSessionRecording } from '../../src/recordings/settle.js'

describe('settleSessionRecording (per-session recording isolation)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gs-settle-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function writeSessionRecording(
    scope: string,
    recordingId: string,
    content: string,
  ): Promise<void> {
    const dir = join(root, 'sessions', scope, recordingId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'recording.jsonl'), content, 'utf-8')
  }

  it('promotes a session recording into the flat store and removes the session directory', async () => {
    const scope = 'sess-1'
    const recordingId = 'flappy_bird-sess-1'
    await writeSessionRecording(scope, recordingId, 'header\nstate\n')
    await writeSessionRecording('other-sess', 'hearts-sess-9', 'unrelated\n')

    await settleSessionRecording(root, scope, recordingId)

    expect(await readFile(join(root, recordingId, 'recording.jsonl'), 'utf-8')).toBe(
      'header\nstate\n',
    )
    await expect(stat(join(root, 'sessions', scope))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(
      await readFile(
        join(root, 'sessions', 'other-sess', 'hearts-sess-9', 'recording.jsonl'),
        'utf-8',
      ),
    ).toBe('unrelated\n')
  })

  it.each([
    { caseName: 'an abandoned session directory', createScope: true },
    { caseName: 'an entirely absent session directory', createScope: false },
  ])('tolerates $caseName when no recording was written', async ({ createScope }) => {
    const scope = 'sess-2'
    const recordingId = 'flappy_bird-sess-2'
    if (createScope) {
      await mkdir(join(root, 'sessions', scope), { recursive: true })
      await writeFile(join(root, 'sessions', scope, 'harmless.tmp'), 'temporary\n', 'utf-8')
    }

    await settleSessionRecording(root, scope, recordingId)

    await expect(stat(join(root, 'sessions', scope))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(join(root, recordingId, 'recording.jsonl'), 'utf-8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves an already-settled flat recording untouched when a stale session copy appears', async () => {
    const scope = 'sess-3'
    const recordingId = 'hearts-sess-3'
    await mkdir(join(root, recordingId), { recursive: true })
    await writeFile(join(root, recordingId, 'recording.jsonl'), 'flat\n', 'utf-8')
    await writeSessionRecording(scope, recordingId, 'stale\n')

    await settleSessionRecording(root, scope, recordingId)
    await settleSessionRecording(root, scope, recordingId)

    expect(await readFile(join(root, recordingId, 'recording.jsonl'), 'utf-8')).toBe('flat\n')
    await expect(stat(join(root, 'sessions', scope))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the source recording when promote fails, then promotes after the destination parent exists', async () => {
    const scope = 'sess-4'
    // A nested id with no destination parent makes the rename fail deterministically, so the
    // source must survive for inspection and retry.
    const recordingId = 'flappy_bird-sess-4/sub'
    await writeSessionRecording(scope, recordingId, 'header\nstate\n')

    await expect(settleSessionRecording(root, scope, recordingId)).rejects.toThrow()
    expect(
      await readFile(join(root, 'sessions', scope, recordingId, 'recording.jsonl'), 'utf-8'),
    ).toBe('header\nstate\n')

    await mkdir(join(root, 'flappy_bird-sess-4'), { recursive: true })
    await settleSessionRecording(root, scope, recordingId)

    expect(await readFile(join(root, recordingId, 'recording.jsonl'), 'utf-8')).toBe(
      'header\nstate\n',
    )
    await expect(stat(join(root, 'sessions', scope))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
