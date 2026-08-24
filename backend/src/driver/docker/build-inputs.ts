/**
 * The session base image's build-input fingerprint, and the build-context filter it shares with the
 * tar the daemon receives.
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

import { isSubmissionIgnored, SUBMISSION_IGNORED_SEGMENTS } from '../../submission/tree-filter.js'

/**
 * The submission filter's set, plus `data`: the repo's own data volume (`backend/data/`'s SQLite
 * database and recordings) has no reason to reach the daemon, but a participant's submission keeps
 * its data/ directory, so `data` stays out of {@link SUBMISSION_IGNORED_SEGMENTS} itself.
 */
const BUILD_CONTEXT_IGNORED_SEGMENTS: ReadonlySet<string> = new Set([
  ...SUBMISSION_IGNORED_SEGMENTS,
  'data',
  '.tls'
])
const ROOT_TEMP_PREFIXES = ['.codex-pytest-budget-', '.test-tmp-']

/**
 * The build-context `ignore` callback bound to a context root: true when an outer-edge ignored
 * directory, a root-local `.env` file or temp directory, or a compiled-Python artifact sits on the
 * path. The tar pack and the input digest use the same filter, so what the digest sees is exactly
 * what the daemon would receive.
 */
export function buildContextIgnore(root: string): (absolutePath: string) => boolean {
  return (absolutePath: string) => {
    const rel = relative(root, absolutePath)
    const rootLocalEnvironmentFile =
      !rel.includes(sep) && (rel === '.env' || (rel.startsWith('.env.') && rel !== '.env.default'))
    const rootLocalTemp =
      !rel.includes(sep) && ROOT_TEMP_PREFIXES.some((prefix) => rel.startsWith(prefix))
    const buildContextIgnoredSegment = rel
      .split(sep)
      .some((segment) => BUILD_CONTEXT_IGNORED_SEGMENTS.has(segment))
    // isSubmissionIgnored also covers the shared set anchored at the repo root and compiled-Python artifacts.
    return (
      rootLocalEnvironmentFile ||
      rootLocalTemp ||
      buildContextIgnoredSegment ||
      isSubmissionIgnored(root, absolutePath)
    )
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
  const ignore = buildContextIgnore(root)
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
