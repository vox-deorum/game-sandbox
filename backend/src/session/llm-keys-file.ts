/**
 * The out-of-band handoff that keeps per-player official LLM keys out of the container argv.
 *
 * Each LLM-enabled session/run writes its per-player key map to a host-side file and exposes it to
 * the container through a read-only bind mount. The session config argv carries only the fixed
 * mount path (`keys_file`), so the key material never appears in `docker inspect`, in
 * `/proc/<pid>/cmdline`, or in container process metadata. The file is session-scoped, written
 * world-readable for the container's root user (which drops `CAP_DAC_READ_SEARCH`, so it honors
 * mode bits and cannot read a file owned by the backend's uid), protected by the 0700 staging
 * directory described below, and removed by the launch owner when the session/run is torn down.
 */
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { MountSpec } from '../driver/index.js'

/** Where the read-only keys file is exposed inside every LLM-enabled session container. */
export const LLM_KEYS_CONTAINER_PATH = '/run/llm-keys.json'

/** One session's staged keys file: its mount, the block it backs, and its cleanup. */
export interface LlmKeysFileHandoff {
  /** The host path the keys file was written to. */
  readonly hostPath: string
  /** The read-only mount exposing the keys file to the container at {@link LLM_KEYS_CONTAINER_PATH}. */
  readonly mount: MountSpec
  /** The container-side path the harness reads keys from (its `keys_file` value). */
  readonly keysFile: string
  /** Remove the host-side keys file. Idempotent and best-effort. */
  cleanup(): Promise<void>
}

/**
 * Stage one session's key map for the container. Returns null when there are no keys (nothing to
 * expose). The caller adds {@link LlmKeysFileHandoff.mount} to the sandbox profile and passes the
 * handoff's `keysFile` path through {@link assembleLlmKeysFileConfig} so the argv carries only the
 * path, never the keys.
 *
 * The 0700 directory keeps the key material private on the host (only the backend may traverse it),
 * while the file itself must be world-readable: it is bind-mounted into a container whose root user
 * runs with `CAP_DAC_READ_SEARCH` dropped, so it follows the file's mode bits and cannot open a
 * 0600 file owned by the backend's uid, which would fail every LLM-enabled session with EACCES.
 */
export async function writeLlmKeysFile(
  rootDir: string,
  sessionId: string,
  keys: Readonly<Record<string, string>>,
): Promise<LlmKeysFileHandoff | null> {
  if (Object.keys(keys).length === 0) {
    return null
  }
  await mkdir(rootDir, { recursive: true, mode: 0o700 })
  const hostPath = join(rootDir, `${sessionId}.json`)
  // writeFile's `mode` is reduced by the process umask, which a stricter deployment could tighten
  // back to unreadable-by-the-container; chmod pins the file at the mode the mount needs.
  await writeFile(hostPath, JSON.stringify(keys), { mode: 0o644 })
  await chmod(hostPath, 0o644)
  return {
    hostPath,
    mount: {
      hostPath,
      containerPath: LLM_KEYS_CONTAINER_PATH,
      readOnly: true,
    },
    keysFile: LLM_KEYS_CONTAINER_PATH,
    cleanup: async () => {
      await rm(hostPath, { force: true }).catch(() => undefined)
    },
  }
}

/** Remove every staged keys file, used at startup so an abrupt stop leaves no stale key file behind. */
export async function removeAllLlmKeysFiles(rootDir: string): Promise<void> {
  await rm(rootDir, { recursive: true, force: true }).catch(() => undefined)
}
