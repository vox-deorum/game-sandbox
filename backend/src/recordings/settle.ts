/**
 * Per-session recording isolation (security): each session container mounts only its own recordings
 * directory, never the shared root, so hostile student code cannot read or overwrite another
 * session's recordings. The on-disk layout lives under `<root>/sessions/<scope>/` while a session
 * runs, then {@link settleSessionRecording} promotes the finished recording into the shared flat
 * store `<root>/<id>/recording.jsonl` that {@link RecordingsStore} and retention read, and removes
 * the now-empty session directory. The container writes through the harness's
 * `<recording_dir>/<recording_id>` layout, so `<scope>` is the session id (or workflow game id) and
 * the promoted `<recording_id>` keeps the flat store's shape unchanged.
 */
import { rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** The scope-name directory that groups per-session recording dirs under the recordings root. */
const SESSIONS_DIR = 'sessions'

/** The host directory one session container mounts at /recordings, isolated per session scope. */
export function sessionRecordingsScopeDir(recordingsRoot: string, scope: string): string {
  return join(recordingsRoot, SESSIONS_DIR, scope)
}

/**
 * Promote a finished session's recording from its isolated directory into the shared flat store,
 * then remove the session directory. Idempotent and tolerant of a missing recording, which is
 * exactly the case (a session that ended before writing one) that still leaves a session dir to
 * clean up. A recording that was already settled earlier wins: the redundant session copy is
 * removed rather than shadowing the existing flat copy.
 */
export async function settleSessionRecording(
  recordingsRoot: string,
  scope: string,
  recordingId: string,
): Promise<void> {
  const scopeDir = sessionRecordingsScopeDir(recordingsRoot, scope)
  const source = join(scopeDir, recordingId)
  const destination = join(recordingsRoot, recordingId)
  try {
    await stat(source)
  } catch {
    await rm(scopeDir, { recursive: true, force: true })
    return
  }
  try {
    await rename(source, destination)
  } catch {
    // Only remove the source once the recording is confirmed safe. When the destination already
    // holds a settled copy (a previous promote won, ENOTEMPTY/EEXIST), the redundant session copy
    // can be dropped. Any other rename failure (EACCES, ENOSPC, EIO, EXDEV, ...) leaves the source
    // in place so the recording can be inspected or retried, instead of deleting the only copy and
    // then reporting a loss there is no way to recover.
    const destExists = await stat(destination).then(
      () => true,
      () => false,
    )
    if (!destExists) {
      throw new Error(`failed to promote session recording ${recordingId} from ${scopeDir}`)
    }
    await rm(source, { recursive: true, force: true }).catch(() => undefined)
  }
  await rm(scopeDir, { recursive: true, force: true })
}
