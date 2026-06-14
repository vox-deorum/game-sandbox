/**
 * The git wrapper, backed by `simple-git` — the one place in the backend that drives the `git`
 * binary (see the scoped Biome override that permits the `simple-git` import only here; raw
 * `child_process` is banned even in this folder, so the CLI is reached only through this seam).
 * Every invocation runs with credential prompts disabled and two timeouts, so an auth-walled or
 * unreachable repository fails as a typed error rather than hanging.
 *
 * It is injected into {@link GitSource} as a {@link GitRunner} so the unit tests can stub the CLI
 * without spawning git; the production wrapper is {@link createGitRunner}.
 */
import { GitError, GitPluginError, type SimpleGitOptions, simpleGit } from 'simple-git'

/** The captured result of one git invocation; a non-zero exit is a result, not a thrown error. */
export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

/** Thrown when a git invocation exceeds its timeout, so callers map it to a `timeout` failure. */
export class GitTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`git timed out after ${timeoutMs}ms`)
    this.name = 'GitTimeoutError'
  }
}

/** The boundary {@link GitSource} shells out through; the production impl wraps `simple-git`. */
export interface GitRunner {
  run(args: string[], opts?: { cwd?: string }): Promise<GitResult>
}

/** A simple-git timeout (`block`) or wall-clock abort surfaces as a `GitPluginError`. */
function isTimeout(error: unknown): boolean {
  return error instanceof GitPluginError && (error.plugin === 'timeout' || error.plugin === 'abort')
}

/**
 * Build a {@link GitRunner} bound to the configured timeout. Each invocation gets a fresh
 * `simple-git` instance so its `baseDir` (the working tree, for fetch/checkout) and its wall-clock
 * `AbortController` are per-call. Two bounds apply: the `timeout.block` plugin kills a process that
 * produces no output for the window (a hung credential prompt or a dead host), and the abort signal
 * is an overall ceiling for an otherwise-steady but oversized fetch. `GIT_TERMINAL_PROMPT=0` (with
 * an empty `GIT_ASKPASS`) makes an auth-walled repo fail immediately instead of prompting.
 *
 * A non-zero git exit resolves with the captured stderr (the caller classifies it); a timeout or
 * abort rejects with {@link GitTimeoutError}.
 */
export function createGitRunner(timeoutMs: number): GitRunner {
  // Put the backend into a non-interactive git posture for every child this runner spawns: never
  // prompt for credentials, so an auth-walled repo fails fast instead of blocking. These are set on
  // process.env (which children inherit) rather than passed through simple-git's `.env()`: that form
  // *replaces* the child env, and simple-git's unsafe-env guard rejects inherited keys such as
  // `EDITOR`. Setting them here keeps PATH and friends intact and never trips that guard.
  process.env.GIT_TERMINAL_PROMPT = '0'
  process.env.GIT_ASKPASS = ''
  process.env.GCM_INTERACTIVE = 'never'
  return {
    async run(args, opts) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const options: Partial<SimpleGitOptions> = {
        baseDir: opts?.cwd ?? process.cwd(),
        binary: 'git',
        timeout: { block: timeoutMs },
        abort: controller.signal,
        trimmed: false,
      }
      const git = simpleGit(options)
      try {
        const stdout = await git.raw(args)
        return { code: 0, stdout, stderr: '' }
      } catch (error) {
        if (isTimeout(error)) {
          throw new GitTimeoutError(timeoutMs)
        }
        // simple-git rejects a failed command with the captured stderr as the error message; hand it
        // to the caller to classify (auth vs unreachable vs ref-not-found).
        const stderr = error instanceof GitError ? error.message : String(error)
        return { code: 1, stdout: '', stderr }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
