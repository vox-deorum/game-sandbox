/**
 * The submission-source seam's types (Stage 5.2). A participant's input — a git URL with an
 * optional ref, or a dev-only local folder — is turned into the pinning facts a submission row
 * stores plus a read-only checkout the later steps read. These types know nothing about where the
 * code came from; the two implementations (`git.ts`, `local.ts`) and the router (`index.ts`) do.
 *
 * The seam deliberately reads and resolves but does not validate a manifest (step 3) or build an
 * image (step 4). Every failure is a typed, classifiable {@link SourceFailureKind} the worker
 * (step 5) records as a failed `resolve` stage, rolling up to `static_failed` per subplan 1.
 */
import type { SubmissionSourceKind } from '../../storage/index.js'

export type { SubmissionSourceKind }

/** A git repository plus the optional ref the participant named (null takes the default-branch head). */
export interface GitSourceInput {
  kind: 'git'
  /** The repository URL exactly as supplied, without any embedded credentials. */
  repoUrl: string
  /** The branch, tag, or full commit SHA requested, or null to take the default-branch head. */
  ref: string | null
}

/** A folder on the server, treated as trusted developer input (see the dev-gate caveat in the plan). */
export interface LocalSourceInput {
  kind: 'local'
  localPath: string
}

export type SourceInput = GitSourceInput | LocalSourceInput

/**
 * The pinning facts a submission row records, derived from {@link SubmissionSource.resolve}. The
 * tuple [submission.md](../../../docs/specs/submission.md) requires: the clean repo URL (never
 * tokenized), the exact resolved commit, the requested ref, and the ref label git could name.
 */
export interface ResolvedSource {
  kind: SubmissionSourceKind
  /** Clean repo URL (never tokenized); null for local. */
  repoUrl: string | null
  /** The exact resolved commit for git; null for local. */
  commitSha: string | null
  /** The ref the participant requested; null when they gave none and we took the default-branch head. */
  ref: string | null
  /** The ref label git named for the commit (a branch or tag); null for an explicit SHA or local. */
  resolvedRef: string | null
  /** The local folder for a local source; null for git. */
  localPath: string | null
}

/**
 * A read-only checkout of the resolved tree, which the static validator reads and the build
 * pipeline overlays. The worker (step 5) is the single owner of its lifetime and disposes it in a
 * `finally`; {@link dispose} is idempotent and never deletes a developer's local folder.
 */
export interface TreeHandle {
  /** Absolute path to the checkout root. */
  readonly path: string
  /** Release any temp resources held by this handle. Idempotent. */
  dispose(): Promise<void>
}

/** Why a source could not be resolved or reached, classifiable into an owner-visible message. */
export type SourceFailureKind =
  | 'unreachable' // host or repository not found, or a network error
  | 'auth_required' // a private repository with missing or rejected credentials
  | 'ref_not_found' // the requested branch, tag, or commit does not resolve
  | 'timeout' // a git invocation exceeded `SUBMISSION_GIT_TIMEOUT_MS`
  | 'invalid_input' // a malformed URL or ref
  | 'local_disabled' // a local source was requested but `ALLOW_LOCAL_SUBMISSIONS` is off

/**
 * The cheap pre-accept reachability result the form calls before a submission is created
 * ([frontend.md](../../../docs/specs/frontend.md): "verifies the repo and ref are reachable before
 * accepting"), separated from {@link SubmissionSource.resolve} so the UI can fail fast without a
 * checkout. Unlike resolve it never throws — an unreachable repo is a `reachable: false` result.
 */
export interface ReachabilityResult {
  reachable: boolean
  /** Present when not reachable: the typed classification. */
  failure?: SourceFailureKind
  /** Owner-visible detail for the form and the validation log; never carries credentials. */
  detail?: string
}

/** A typed, classifiable source failure the worker records as a failed `resolve` stage with its detail. */
export class SourceError extends Error {
  constructor(
    readonly failure: SourceFailureKind,
    message: string,
  ) {
    super(message)
    this.name = 'SourceError'
  }
}

/** The source seam: reach-check, resolve to pinning facts, and materialize a read-only tree. */
export interface SubmissionSource {
  /** Cheap pre-accept reachability check, no checkout. Never throws for an unreachable repo. */
  verifyReachable(input: SourceInput): Promise<ReachabilityResult>
  /** Resolve the input to its pinning facts; the git ref→commit resolution lives here. */
  resolve(input: SourceInput): Promise<ResolvedSource>
  /** Materialize a read-only checkout of the resolved tree. The caller owns the handle's lifetime. */
  fetchTree(resolved: ResolvedSource): Promise<TreeHandle>
}
