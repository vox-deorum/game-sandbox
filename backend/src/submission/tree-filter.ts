/**
 * The single submission tree filter, shared by the size measurement (this file), the snapshot pack
 * (`snapshot-store.ts`), and the overlay build context (`driver/docker/overlay.ts`). One exclusion set
 * for all three is what keeps a rebuild-from-snapshot byte-identical to the original build: they pack
 * the same files in the same order. The set matches the session-base build's (`driver/docker/image.ts`),
 * but the predicate here takes the tree root as an argument so it works against any checkout. `.git` is
 * a member, so VCS history is excluded (a submission is code, not history).
 */
import { lstat, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** Directories never worth packing into a submission snapshot or overlay (build artifacts, VCS, caches). */
export const SUBMISSION_IGNORED_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.venv',
  'build',
  'data',
  'dist',
  '.pytest-tmp',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '__pycache__',
])

/** True when `rel` (a `relative(root, path)` result) escapes the root, rather than naming a child. */
function isOutsideRoot(rel: string): boolean {
  // `relative` yields `..` or `../x` for an escaping path; a real child like `..cache` is not one.
  return rel === '..' || rel.startsWith(`..${sep}`)
}

/**
 * True when `absolutePath` (under `root`) is an ignored directory, lives beneath one, or is a compiled
 * Python artifact. The root itself and anything outside it are never ignored. The session-base build's
 * `isIgnored` composes this same predicate, bound to the repo root.
 */
export function isSubmissionIgnored(root: string, absolutePath: string): boolean {
  const rel = relative(root, absolutePath)
  if (rel === '' || isOutsideRoot(rel)) {
    return false
  }
  if (rel.endsWith('.pyc')) {
    return true
  }
  return rel.split(sep).some((segment) => SUBMISSION_IGNORED_SEGMENTS.has(segment))
}

/** A `tar-fs` `ignore(absolutePath)` callback bound to a tree root; pruning a dir prunes its subtree. */
export function submissionTarIgnore(root: string): (absolutePath: string) => boolean {
  return (absolutePath: string) => isSubmissionIgnored(root, absolutePath)
}

/**
 * The on-disk size, in bytes, of the kept files under `root` (exactly what the snapshot and overlay
 * contain). Symlinks are counted via `lstat` but never followed, so a cyclic or escaping link cannot
 * loop or inflate the total past the link entry itself. With `limitBytes`, the walk stops the moment
 * the running total passes it, so a pathologically large tree is not fully traversed just to learn it
 * is over the cap.
 */
export async function measureTreeSize(root: string, limitBytes?: number): Promise<number> {
  let total = 0
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // A directory that vanished mid-walk contributes nothing; skip it rather than throw.
      continue
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (isSubmissionIgnored(root, abs)) {
        continue
      }
      if (entry.isDirectory()) {
        stack.push(abs)
        continue
      }
      // Count regular files and symlinks by their own (l)stat size; do not follow links.
      const info = await lstat(abs).catch(() => null)
      if (info !== null && (info.isFile() || info.isSymbolicLink())) {
        total += info.size
        if (limitBytes !== undefined && total > limitBytes) {
          return total
        }
      }
    }
  }
  return total
}
