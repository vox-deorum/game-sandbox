/**
 * The development-only local-folder source: a sandbox developer names a folder on the server and the
 * whole validate-and-build pipeline runs against it without GitHub. It exists for the worked example,
 * the extra Flappy Bird examples, and intentionally malformed repos.
 *
 * Construction is gated by `ALLOW_LOCAL_SUBMISSIONS` in the router (`index.ts`); when the gate is off
 * this class is never built and a local request is refused before any filesystem access. With the
 * gate on the supplied path is treated as trusted developer input — the gate, not path-sanitization,
 * is the security boundary, so this does not constrain the path to a sandbox root.
 */
import { stat } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'

import {
  type LocalSourceInput,
  type ReachabilityResult,
  type ResolvedSource,
  SourceError,
  type TreeHandle,
} from './types.js'

export class LocalSource {
  async verifyReachable(input: LocalSourceInput): Promise<ReachabilityResult> {
    try {
      const info = await stat(input.localPath)
      if (!info.isDirectory()) {
        return {
          reachable: false,
          failure: 'unreachable',
          detail: 'the local path is not a directory',
        }
      }
      return { reachable: true }
    } catch {
      return { reachable: false, failure: 'unreachable', detail: 'the local path does not exist' }
    }
  }

  async resolve(input: LocalSourceInput): Promise<ResolvedSource> {
    const info = await stat(input.localPath).catch(() => null)
    if (info === null || !info.isDirectory()) {
      throw new SourceError('unreachable', 'the local path does not exist or is not a directory')
    }
    return {
      kind: 'local',
      repoUrl: null,
      commitSha: null,
      ref: null,
      resolvedRef: null,
      localPath: resolvePath(input.localPath),
    }
  }

  async fetchTree(resolved: ResolvedSource): Promise<TreeHandle> {
    if (resolved.kind !== 'local' || resolved.localPath === null) {
      throw new SourceError('invalid_input', 'a local tree requires a resolved local path')
    }
    // The folder is handed through directly; dispose is a no-op so a developer's working tree is never
    // deleted. The build step (step 4) makes an isolated copy if it needs one.
    return { path: resolved.localPath, dispose: () => Promise.resolve() }
  }
}
