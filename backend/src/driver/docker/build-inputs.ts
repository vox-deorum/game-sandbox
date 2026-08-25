/**
 * The session base image's build-input fingerprint, and the build-context tar filter built from the
 * same tree list.
 *
 * The digest lets `ensureImage` decide whether an existing tag is still fresh: every build stamps
 * the digest of its inputs onto the image as a label, and the `refresh` policy reuses the tag when
 * the label matches the digest of the checkout's current inputs. The digest covers file paths and
 * raw contents only: no mtimes, no mode bits (the Dockerfile normalizes permissions with
 * `chmod -R a+rX` exactly because a Windows checkout carries no reliable execute bits), and empty
 * directories are not recorded.
 */
import { createHash } from 'node:crypto'
import { lstat, opendir, readFile, readlink } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { isSubmissionIgnored } from '../../submission/tree-filter.js'

/**
 * The build-context `ignore` callback bound to a context root: true for every path outside the
 * named `inputs`, so only the input trees get packed. Ancestor directories of an input are kept as
 * empty entries so tar-fs can descend (tar-fs never calls `ignore` on the root, and ignoring a
 * directory prunes its subtree), while the shared submission filter (`isSubmissionIgnored`) still
 * prunes caches inside the allowed trees. `inputs` are context-relative with `/` separators; `rel`
 * splits on the platform {@link sep}. Segment-wise prefix matching, never string prefixes, so
 * `harnessx` does not accidentally match the `harness` input. The tar pack and the input digest use
 * the same filter, so what the digest sees is exactly what the daemon would receive.
 */
export function buildContextIgnore(
  root: string,
  inputs: readonly string[],
): (absolutePath: string) => boolean {
  const inputSegments = inputs.map((input) => input.split('/'))
  return (absolutePath: string) => {
    const rel = relative(root, absolutePath)
    if (rel === '') {
      return false
    }
    const segments = rel.split(sep)
    const atOrUnderInput = inputSegments.some(
      (input) =>
        input.length <= segments.length && input.every((segment, i) => segments[i] === segment),
    )
    if (atOrUnderInput) {
      return isSubmissionIgnored(root, absolutePath)
    }
    const ancestorOfInput = inputSegments.some(
      (input) =>
        input.length > segments.length && segments.every((segment, i) => input[i] === segment),
    )
    return !ancestorOfInput
  }
}

/**
 * A stable digest of the named input trees under `root`, filtered by {@link buildContextIgnore}.
 * One manifest line per kept entry (`blob <sha256 of contents> <path>` for a regular file,
 * `link <sha256 of target> <path>` for a symlink, other kinds skipped, links never followed), paths
 * normalized to `/` separators so Windows and Linux checkouts agree, sorted in code-unit order,
 * then hashed. A registered input that does not exist is a bug, so it throws rather than silently
 * digesting less.
 */
export async function computeBuildInputsDigest(
  root: string,
  inputs: readonly string[],
): Promise<string> {
  const ignore = buildContextIgnore(root, inputs)
  const lines: string[] = []
  for (const input of [...new Set(inputs)].sort()) {
    const absolute = join(root, input)
    const info = await lstat(absolute).catch(() => {
      throw new Error(`build input ${input} does not exist under ${root}`)
    })
    if (info.isDirectory()) {
      await collect(root, absolute, ignore, lines)
    } else {
      lines.push(await manifestLine(root, absolute, info.isSymbolicLink()))
    }
  }
  const manifest = lines.sort().join('')
  return `sha256:${createHash('sha256').update(manifest).digest('hex')}`
}

/** Walk `directory` depth-first, appending a manifest line per kept file or symlink. */
async function collect(
  root: string,
  directory: string,
  ignore: (absolutePath: string) => boolean,
  lines: string[],
): Promise<void> {
  const dir = await opendir(directory)
  for await (const entry of dir) {
    const absolute = join(directory, entry.name)
    // Pruning an ignored directory prunes its whole subtree, matching the tar pack's semantics.
    if (ignore(absolute)) {
      continue
    }
    if (entry.isDirectory()) {
      await collect(root, absolute, ignore, lines)
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      lines.push(await manifestLine(root, absolute, entry.isSymbolicLink()))
    }
  }
}

/** One manifest line for a regular file or symlink, with the path normalized to `/` separators. */
async function manifestLine(root: string, absolute: string, isLink: boolean): Promise<string> {
  const rel = relative(root, absolute).split(sep).join('/')
  const bytes = isLink ? Buffer.from(await readlink(absolute)) : await readFile(absolute)
  const digest = createHash('sha256').update(bytes).digest('hex')
  return `${isLink ? 'link' : 'blob'} ${digest} ${rel}\n`
}
