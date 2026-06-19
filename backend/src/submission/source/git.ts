/**
 * The git submission source: host-agnostic resolution and a single-commit shallow checkout, using
 * only the two mechanisms the deployment already has (the `git` CLI and, for github.com, the REST
 * API). It resolves a participant's ref to an exact commit and materializes exactly that commit;
 * it never clones history (`--depth 1`) and never stores a tokenized URL.
 *
 * Failures are typed: an unreachable host, an auth-walled repo, a non-resolving ref, and a timeout
 * each surface as a {@link SourceError} (or a `reachable: false` {@link ReachabilityResult}) the
 * worker records as a failed `resolve` stage.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type GitResult, type GitRunner, GitTimeoutError } from './git-process.js'
import { type GitHubClient, parseGitHubRepo, tokenizedUrl } from './github.js'
import {
  type GitSourceInput,
  type ReachabilityResult,
  type ResolvedSource,
  SourceError,
  type SourceFailureKind,
  type TreeHandle,
} from './types.js'

/** A full (unabbreviated) commit SHA, which `ls-remote` will not advertise as a ref. */
const FULL_SHA = /^[0-9a-f]{40}$/i

/** Drop the `refs/heads/` or `refs/tags/` prefix from a resolved ref name for the stored label. */
function stripRefPrefix(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, '')
}

/**
 * Reject a participant-supplied ref that git would parse as an option rather than a ref. The ref is
 * passed as a positional argv to `ls-remote`/`fetch`; a value like `--upload-pack=…` or `--output=…`
 * would otherwise be interpreted as a flag (an argument-injection vector). A real branch/tag/SHA
 * never begins with a dash, so refusing the whole class is both safe and git-version-agnostic.
 */
function assertSafeRef(ref: string | null): void {
  if (ref?.startsWith('-')) {
    throw new SourceError('invalid_input', 'a git ref must not begin with a dash')
  }
}

/** Classify a non-zero git exit from its stderr into a typed failure with a credential-free detail. */
function classifyGitStderr(stderr: string): { failure: SourceFailureKind; detail: string } {
  const text = stderr.toLowerCase()
  if (
    text.includes('authentication failed') ||
    text.includes('could not read username') ||
    text.includes('could not read password') ||
    text.includes('terminal prompts disabled') ||
    text.includes('permission denied')
  ) {
    return {
      failure: 'auth_required',
      detail: 'the repository requires authentication; provide credentials or check access',
    }
  }
  if (
    text.includes("couldn't find remote ref") ||
    text.includes('not our ref') ||
    text.includes('unadvertised object') ||
    text.includes('reference is not a tree')
  ) {
    return {
      failure: 'ref_not_found',
      detail: 'the requested ref does not exist in the repository',
    }
  }
  // Everything else (host resolution, missing repo, refused fetch) is reported as unreachable; the
  // detail is generic on purpose so a tokenized URL echoed in stderr can never leak into the log.
  return { failure: 'unreachable', detail: 'the repository could not be reached' }
}

/** The ls-remote patterns used for a participant-supplied branch/tag/full-ref name. */
function namedRefPatterns(ref: string): string[] {
  return Array.from(new Set([ref, `refs/heads/${ref}`, `refs/tags/${ref}`]))
}

/** Parse advertised refs from `git ls-remote` output. */
function parseLsRemoteMatches(stdout: string): Array<{ sha: string; ref: string }> {
  const matches: Array<{ sha: string; ref: string }> = []
  for (const line of stdout.split('\n')) {
    const match = line.match(/^([0-9a-f]{40})\s+(\S+)$/i)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      matches.push({ sha: match[1], ref: match[2] })
    }
  }
  return matches
}

export class GitSource {
  constructor(
    private readonly runner: GitRunner,
    private readonly github: GitHubClient,
    private readonly token: string | undefined,
  ) {}

  async verifyReachable(input: GitSourceInput): Promise<ReachabilityResult> {
    if (!this.isHttpUrl(input.repoUrl)) {
      return {
        reachable: false,
        failure: 'invalid_input',
        detail: 'only http(s) git URLs are supported',
      }
    }
    if (input.ref?.startsWith('-')) {
      return {
        reachable: false,
        failure: 'invalid_input',
        detail: 'a git ref must not begin with a dash',
      }
    }
    const github = parseGitHubRepo(input.repoUrl)
    if (github !== null) {
      // A GitHub URL gets an authenticated REST reachability check — cheaper than ls-remote and able
      // to distinguish private-but-authorized from not-found.
      const result = await this.github.checkRepo(github)
      if (!result.reachable) {
        return result
      }
    }
    return await this.verifyGitReachable(input)
  }

  private async verifyGitReachable(input: GitSourceInput): Promise<ReachabilityResult> {
    try {
      const result = await this.runner.run(this.reachabilityArgs(input))
      if (result.code !== 0) {
        return { reachable: false, ...classifyGitStderr(result.stderr) }
      }
      if (input.ref === null || FULL_SHA.test(input.ref)) {
        const hasHead = parseLsRemoteMatches(result.stdout).some((entry) => entry.ref === 'HEAD')
        return hasHead
          ? { reachable: true }
          : {
              reachable: false,
              failure: 'ref_not_found',
              detail: 'the repository has no default-branch HEAD',
            }
      }
      return parseLsRemoteMatches(result.stdout).length > 0
        ? { reachable: true }
        : {
            reachable: false,
            failure: 'ref_not_found',
            detail: `the ref '${input.ref}' does not exist in the repository`,
          }
    } catch (error) {
      if (error instanceof GitTimeoutError) {
        return {
          reachable: false,
          failure: 'timeout',
          detail: 'the repository did not respond within the time limit',
        }
      }
      throw error
    }
  }

  private reachabilityArgs(input: GitSourceInput): string[] {
    const url = this.fetchUrl(input.repoUrl)
    if (input.ref === null || FULL_SHA.test(input.ref)) {
      // A full SHA is not necessarily advertised by ls-remote; this verifies repository/default-HEAD
      // reachability cheaply, and the later shallow fetch remains the commit-existence proof.
      return ['ls-remote', '--symref', url, 'HEAD']
    }
    return ['ls-remote', url, ...namedRefPatterns(input.ref)]
  }

  async resolve(input: GitSourceInput): Promise<ResolvedSource> {
    this.assertHttpUrl(input.repoUrl)
    assertSafeRef(input.ref)
    const url = this.fetchUrl(input.repoUrl)
    if (input.ref === null) {
      return await this.resolveDefaultBranch(input.repoUrl, url)
    }
    if (FULL_SHA.test(input.ref)) {
      // An explicit commit is pinned as-is. `ls-remote` does not advertise arbitrary commits, so its
      // existence is verified at fetchTree (the `--depth 1` fetch plus the rev-parse equality check);
      // if the server refuses to fetch it, that surfaces there as a non-resolving ref.
      return {
        kind: 'git',
        repoUrl: input.repoUrl,
        commitSha: input.ref.toLowerCase(),
        ref: input.ref,
        resolvedRef: null,
        localPath: null,
      }
    }
    return await this.resolveNamedRef(input.repoUrl, url, input.ref)
  }

  async fetchTree(resolved: ResolvedSource): Promise<TreeHandle> {
    if (resolved.kind !== 'git' || resolved.commitSha === null || resolved.repoUrl === null) {
      throw new SourceError('invalid_input', 'a git tree requires a resolved commit')
    }
    const url = this.fetchUrl(resolved.repoUrl)
    const dir = await mkdtemp(join(tmpdir(), 'gs-submission-'))
    let disposed = false
    const handle: TreeHandle = {
      path: dir,
      dispose: async () => {
        if (disposed) {
          return
        }
        disposed = true
        await rm(dir, { recursive: true, force: true })
      },
    }
    try {
      await this.gitOrThrow(['init', '--quiet', dir])
      // Fetch exactly the resolved commit at depth 1 — no history, no other branches. Fetching by the
      // resolved ref name is more widely permitted than fetching an arbitrary SHA, so prefer it.
      const fetchTarget = resolved.resolvedRef ?? resolved.commitSha
      await this.gitOrThrow(['fetch', '--depth', '1', url, fetchTarget], dir)
      await this.gitOrThrow(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], dir)
      const head = await this.gitOrThrow(['rev-parse', 'HEAD'], dir)
      if (head.stdout.trim().toLowerCase() !== resolved.commitSha) {
        throw new SourceError('ref_not_found', 'the fetched commit did not match the pinned commit')
      }
      return handle
    } catch (error) {
      await handle.dispose()
      throw error
    }
  }

  /** The per-invocation URL git actually uses: tokenized for private github.com, clean otherwise. */
  private fetchUrl(repoUrl: string): string {
    return tokenizedUrl(repoUrl, this.token)
  }

  private isHttpUrl(repoUrl: string): boolean {
    try {
      const url = new URL(repoUrl)
      return url.protocol === 'https:' || url.protocol === 'http:'
    } catch {
      return false
    }
  }

  private assertHttpUrl(repoUrl: string): void {
    if (!this.isHttpUrl(repoUrl)) {
      throw new SourceError('invalid_input', 'only http(s) git URLs are supported')
    }
  }

  /** Run git and turn a non-zero exit or a timeout into a typed {@link SourceError}. */
  private async gitOrThrow(args: string[], cwd?: string): Promise<GitResult> {
    let result: GitResult
    try {
      result = await this.runner.run(args, cwd !== undefined ? { cwd } : undefined)
    } catch (error) {
      if (error instanceof GitTimeoutError) {
        throw new SourceError('timeout', 'the repository did not respond within the time limit')
      }
      throw error
    }
    if (result.code !== 0) {
      const { failure, detail } = classifyGitStderr(result.stderr)
      throw new SourceError(failure, detail)
    }
    return result
  }

  private async resolveDefaultBranch(cleanUrl: string, url: string): Promise<ResolvedSource> {
    // `--symref` returns both the symbolic HEAD (`ref: refs/heads/<branch>  HEAD`) and the commit it
    // points at (`<sha>  HEAD`), so one round trip pins the default-branch head and names the branch.
    const result = await this.gitOrThrow(['ls-remote', '--symref', url, 'HEAD'])
    let branch: string | null = null
    let sha: string | null = null
    for (const line of result.stdout.split('\n')) {
      const symref = line.match(/^ref:\s+(\S+)\s+HEAD$/)
      if (symref?.[1] !== undefined) {
        branch = symref[1]
        continue
      }
      const head = line.match(/^([0-9a-f]{40})\s+HEAD$/i)
      if (head?.[1] !== undefined) {
        sha = head[1]
      }
    }
    if (sha === null) {
      throw new SourceError('ref_not_found', 'the repository has no default-branch HEAD')
    }
    return {
      kind: 'git',
      repoUrl: cleanUrl,
      commitSha: sha.toLowerCase(),
      ref: null,
      resolvedRef: branch !== null ? stripRefPrefix(branch) : null,
      localPath: null,
    }
  }

  private async resolveNamedRef(
    cleanUrl: string,
    url: string,
    ref: string,
  ): Promise<ResolvedSource> {
    // Offer the raw ref plus the head/tag candidates so a short name, a full ref, a branch, and a tag
    // all resolve. Annotated tags advertise a peeled `<sha>  <ref>^{}` line — prefer it, since that
    // is the commit the tag points at rather than the tag object.
    const result = await this.gitOrThrow(['ls-remote', url, ...namedRefPatterns(ref)])
    const matches = parseLsRemoteMatches(result.stdout)
    const peeled = matches.find((entry) => entry.ref.endsWith('^{}'))
    const chosen = peeled ?? matches[0]
    if (chosen === undefined) {
      throw new SourceError('ref_not_found', `the ref '${ref}' does not exist in the repository`)
    }
    return {
      kind: 'git',
      repoUrl: cleanUrl,
      commitSha: chosen.sha.toLowerCase(),
      ref,
      resolvedRef: stripRefPrefix(chosen.ref.replace(/\^\{\}$/, '')),
      localPath: null,
    }
  }
}
