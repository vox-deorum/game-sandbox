import { mkdtempSync, rmSync } from 'node:fs'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sessionRecordingsScopeDir, settleSessionRecording } from '../../src/recordings/settle.js'

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
    const dir = join(sessionRecordingsScopeDir(root, scope), recordingId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'recording.jsonl'), content, 'utf-8')
  }

  it('promotes a session recording into the flat store and removes the session directory', async () => {
    const recordingId = 'flappy_bird-sess-1'
    await writeSessionRecording('sess-1', recordingId, 'header\nstate\n')
    await settleSessionRecording(root, 'sess-1', recordingId)

    expect(await readFile(join(root, recordingId, 'recording.jsonl'), 'utf-8')).toBe(
      'header\nstate\n',
    )
    await expect(stat(sessionRecordingsScopeDir(root, 'sess-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('tolerates a session that never wrote a recording, still cleaning the session directory', async () => {
    await settleSessionRecording(root, 'sess-2', 'flappy_bird-sess-2')
    await expect(stat(sessionRecordingsScopeDir(root, 'sess-2'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(
      readFile(join(root, 'flappy_bird-sess-2', 'recording.jsonl'), 'utf-8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves an already-settled flat recording untouched when a stale session copy appears', async () => {
    const recordingId = 'hearts-sess-3'
    await mkdir(join(root, recordingId), { recursive: true })
    await writeFile(join(root, recordingId, 'recording.jsonl'), 'flat\n', 'utf-8')
    await writeSessionRecording('sess-3', recordingId, 'stale\n')

    await settleSessionRecording(root, 'sess-3', recordingId)

    expect(await readFile(join(root, recordingId, 'recording.jsonl'), 'utf-8')).toBe('flat\n')
    await expect(stat(sessionRecordingsScopeDir(root, 'sess-3'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('keeps the source recording when the promote fails for a reason other than an existing destination', async () => {
    const scope = 'sess-4'
    const recordingId = 'flappy_bird-sess-4'
    await writeSessionRecording(scope, recordingId, 'header\nstate\n')
    // A read-only recordings root makes the rename fail (EACCES) while the destination does not
    // exist, so the source must be left in place for inspection/retry rather than deleted first.
    await chmod(root, 0o500)
    try {
      await expect(settleSessionRecording(root, scope, recordingId)).rejects.toThrow(
        /failed to promote session recording/,
      )
    } finally {
      await chmod(root, 0o700)
    }
    expect(
      await readFile(
        join(sessionRecordingsScopeDir(root, scope), recordingId, 'recording.jsonl'),
        'utf-8',
      ),
    ).toBe('header\nstate\n')
    await expect(stat(sessionRecordingsScopeDir(root, scope))).resolves.toBeDefined()
  })
})
