/**
 * GitHub-specific helpers: URL parsing, token-backed credential injection, and a reachability
 * client over the global `fetch`. These are used only for github.com URLs and only for the
 * reachability/auth concerns the host-agnostic `git` CLI path cannot answer cheaply (an
 * authenticated reachability check for a private repo). Non-GitHub repos go entirely through the
 * git CLI.
 *
 * The client uses the Node global `fetch`, so there is no HTTP package to confine with a Biome
 * restricted-import rule; confinement is by file location (this module lives only under
 * `submission/source/`) plus the CI grep, as the plan records.
 */
import type { ReachabilityResult } from './types.js'

/** A parsed GitHub repository coordinate. */
export interface GitHubRepo {
  owner: string
  repo: string
}

/**
 * Parse `owner` and `repo` from a GitHub HTTPS URL, or null when the URL is not a github.com repo
 * URL (a different host, an ssh URL, or a malformed path). Only github.com is treated specially;
 * every other host goes through the host-agnostic git CLI.
 */
export function parseGitHubRepo(repoUrl: string): GitHubRepo | null {
  let url: URL
  try {
    url = new URL(repoUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    return null
  }
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  if (segments.length !== 2) {
    return null
  }
  const owner = segments[0]
  const rawRepo = segments[1]
  if (owner === undefined || rawRepo === undefined) {
    return null
  }
  const repo = rawRepo.replace(/\.git$/, '')
  if (owner === '' || repo === '') {
    return null
  }
  return { owner, repo }
}

/**
 * Rewrite a clean GitHub HTTPS URL to carry `token` as basic-auth credentials so the `git` CLI can
 * clone/fetch a private repo. Only github.com https URLs are rewritten; the no-token case and every
 * other URL are returned unchanged. The clean URL is what gets stored and logged — this tokenized
 * form is built per-invocation and never leaves the process.
 */
export function tokenizedUrl(repoUrl: string, token: string | undefined): string {
  if (token === undefined || token === '') {
    return repoUrl
  }
  if (parseGitHubRepo(repoUrl) === null) {
    return repoUrl
  }
  const url = new URL(repoUrl)
  url.username = 'x-access-token'
  url.password = token
  return url.toString()
}

/** The GitHub reachability client {@link GitSource} injects; the production impl uses `fetch`. */
export interface GitHubClient {
  /** Classify whether a GitHub repo is reachable (optionally authenticated), without a checkout. */
  checkRepo(repo: GitHubRepo): Promise<ReachabilityResult>
}

/** A GitHub REST reachability client over the global `fetch` (no HTTP dependency). */
export function createGitHubClient(token: string | undefined): GitHubClient {
  return {
    async checkRepo(repo) {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'game-sandbox',
        'X-GitHub-Api-Version': '2022-11-28',
      }
      if (token !== undefined && token !== '') {
        headers.Authorization = `Bearer ${token}`
      }
      let response: Response
      try {
        response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, {
          headers,
        })
      } catch {
        return { reachable: false, failure: 'unreachable', detail: 'could not reach github.com' }
      }
      if (response.ok) {
        return { reachable: true }
      }
      if (response.status === 401 || response.status === 403) {
        return {
          reachable: false,
          failure: 'auth_required',
          detail: 'the repository requires authentication; set GITHUB_TOKEN',
        }
      }
      if (response.status === 404) {
        // GitHub returns 404 for both a missing repo and a private one the caller cannot see. With a
        // token it means not-found; without one it most likely means private-and-unauthenticated.
        return token !== undefined && token !== ''
          ? { reachable: false, failure: 'unreachable', detail: 'the repository was not found' }
          : {
              reachable: false,
              failure: 'auth_required',
              detail: 'the repository was not found or is private; set GITHUB_TOKEN',
            }
      }
      return {
        reachable: false,
        failure: 'unreachable',
        detail: `github responded with status ${response.status}`,
      }
    },
  }
}
