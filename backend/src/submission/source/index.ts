/**
 * The submission-source seam's public entry point: the {@link SubmissionSource} types plus the
 * factory that wires the git and local implementations behind one router. Callers (the validation
 * worker and the submission API in step 5) depend only on this module, never on which source a
 * request lands in.
 *
 * The git source is always available; the local source is constructed only when the dev gate is on,
 * and a local request is refused (`local_disabled`) before any filesystem access when it is off.
 */
import type { SubmissionOptions } from '../../config.js'
import { GitSource } from './git.js'
import { createGitRunner, type GitRunner } from './git-process.js'
import { createGitHubClient, type GitHubClient } from './github.js'
import { LocalSource } from './local.js'
import {
  type ReachabilityResult,
  SourceError,
  type SourceInput,
  type SubmissionSource,
} from './types.js'

export type { GitResult, GitRunner } from './git-process.js'
export { createGitRunner, GitTimeoutError } from './git-process.js'
export type { GitHubClient, GitHubRepo } from './github.js'
export { createGitHubClient, parseGitHubRepo, tokenizedUrl } from './github.js'
export * from './types.js'

/** Test seam: inject fakes for the `git` CLI and the GitHub HTTP client. */
export interface SubmissionSourceDeps {
  gitRunner?: GitRunner
  githubClient?: GitHubClient
}

/**
 * Construct the submission source seam from its config slice. Tests pass an explicit config and may
 * inject a stubbed git runner and GitHub client; production uses the CLI-backed runner and the
 * `fetch`-backed client.
 */
export function createSubmissionSource(
  config: SubmissionOptions,
  deps: SubmissionSourceDeps = {},
): SubmissionSource {
  const runner = deps.gitRunner ?? createGitRunner(config.gitTimeoutMs)
  const githubClient = deps.githubClient ?? createGitHubClient(config.githubToken)
  const git = new GitSource(runner, githubClient, config.githubToken)
  const local = config.allowLocalSubmissions ? new LocalSource() : null

  return {
    async verifyReachable(input: SourceInput): Promise<ReachabilityResult> {
      if (input.kind === 'local') {
        return local === null ? localDisabledResult() : await local.verifyReachable(input)
      }
      return await git.verifyReachable(input)
    },
    async resolve(input) {
      if (input.kind === 'local') {
        if (local === null) {
          throw localDisabledError()
        }
        return await local.resolve(input)
      }
      return await git.resolve(input)
    },
    async fetchTree(resolved) {
      if (resolved.kind === 'local') {
        if (local === null) {
          throw localDisabledError()
        }
        return await local.fetchTree(resolved)
      }
      return await git.fetchTree(resolved)
    },
  }
}

function localDisabledResult(): ReachabilityResult {
  return {
    reachable: false,
    failure: 'local_disabled',
    detail: 'local submissions are disabled on this deployment',
  }
}

function localDisabledError(): SourceError {
  return new SourceError('local_disabled', 'local submissions are disabled on this deployment')
}
