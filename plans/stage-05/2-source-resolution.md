# Stage 5.2: Source Resolution

Status: not started.

Part of [Stage 5](../stage-05-submissions.md). This is build-order step 2: the seam that turns a participant's input, a git URL with an optional ref or a dev-only local folder, into a fetched tree plus the pinning metadata the submission row stores. It resolves and reads; it does not validate the manifest (step 3) or build an image (step 4). Local-folder resolution is fully Docker-free; the git path needs the `git` CLI but no Docker.

## The seam

A `SubmissionSource` interface in `backend/src/submission/source/` exposing what every later step needs without knowing where the code came from:

- `resolve(input)` returns `ResolvedSource`: the pinning facts the [submission.md](../../docs/specs/submission.md) tuple requires, including `kind` (`git` or `local`), `commitSha` (the exact resolved SHA for git, null for local), `repoUrl` without credentials, the requested `ref`, and the resolved ref label when git can name one. For git this is where the ref resolves to a commit and the default is the default-branch head.
- `fetchTree(resolved)` returns a handle to a read-only local checkout of the tree (a temp directory), which the static validator reads and the build pipeline overlays. The handle is disposable and **the worker (step 5) is the single owner of its lifetime**: the validation job acquires the tree once, passes it through the static check and the overlay build, and disposes it in a `finally` so a build that throws mid-pipeline cannot leak the temp worktree. The handle exposes an explicit `dispose()` (idempotent) rather than relying on process-exit cleanup, since the worker is long-lived and processes many submissions.
- `verifyReachable(input)` returns a cheap typed reachability result the form calls _before_ accepting (see [frontend.md](../../docs/specs/frontend.md): "verifies the repo and ref are reachable before accepting"), separated from the full resolve so the UI can fail fast without a checkout.

Two implementations behind the seam, selected by `source_kind` and gated by config.

## Git source

Host-agnostic by design, using the two mechanisms the deployment already has (per the parent plan):

- **`git ls-remote --symref <url> HEAD`** resolves the default branch when the participant gives no ref, returning both the branch name and its commit SHA.
- **`git ls-remote <url> <ref candidates>`** resolves advertised branches and tags. Branch names, full ref names, lightweight tags, and annotated tags are normalized to the commit they point at; annotated tags use the peeled `^{}` result when present.
- **An explicit full commit SHA** is verified by a shallow fetch of that commit into a temporary checkout, because arbitrary commits are not necessarily advertised by `ls-remote`. If the server refuses to fetch it, the ref is treated as non-resolving.
- **`fetchTree`** materializes exactly the resolved commit into a temporary worktree and verifies `rev-parse HEAD` equals the pinned SHA before handing the tree to validation.
- **The GitHub REST API client** is used only for GitHub URLs and only for reachability/auth concerns: authenticated reachability checks for private repos, and token-backed clone/fetch credentials when the operator provides `GITHUB_TOKEN` (public repos need none, per [submission.md](../../docs/specs/submission.md)). Store and log only the clean repo URL, never a tokenized URL. Non-GitHub public repos still work through the git CLI path.

Run `git` through a small process wrapper with an explicit timeout and no credential prompt (non-interactive env, `GIT_TERMINAL_PROMPT=0`), so an unreachable or auth-walled repo fails as a typed error rather than hanging. Stage 3's restricted-import rule currently bans `child_process` across `backend/src`, and [biome.jsonc](../../biome.jsonc) is built on the documented invariant that "every `backend/src` file matches exactly one override." Carving out the git wrapper is therefore **two coordinated edits, not one**: (a) add a new override block scoped to `**/backend/src/submission/source/**` that permits `child_process`/`node:child_process` while still banning `dockerode`, `kysely`, and `better-sqlite3` (so the wrapper does not become a Docker/DB escape hatch), and (b) add a `!**/backend/src/submission/source/**` exclusion to the broad backend block so the source files still match exactly one override. No other backend module may spawn processes. Confine any GitHub HTTP client to this module the same way dockerode and kysely are confined elsewhere.

## Local-folder source (dev only)

The development-only path from [submission.md](../../docs/specs/submission.md): the participant (really, a sandbox developer) names a folder on the server. `resolve` records `kind: local`, no commit, the folder path; `fetchTree` returns the folder directly (or a copy if the build step needs an isolated tree). It exists so the whole validate-and-build pipeline can run against the worked example, the extra Flappy Bird examples, and intentionally malformed repos without GitHub.

It is **gated off in normal deployments**: the `ALLOW_LOCAL_SUBMISSIONS` config flag defaults off and controls whether the local source is constructed and whether the API (step 5) and the dev-build form even offer it. With the flag off, a local-source request is refused before any filesystem access, and the form shows no local-path field. With the flag on, the supplied path is treated as **trusted developer input**: the gate, not path-sanitization, is the security boundary, so this stage does not constrain the path to a sandbox root. That trade-off is acceptable only because the flag is dev-only and off by default; note it explicitly so no deployment turns the flag on under the assumption the path is sandboxed.

## Config

New configuration consumed through the typed `Config` object (the module-level-read ban from Stage 3 still holds): optional `GITHUB_TOKEN` for private-repo auth and authenticated reachability, `ALLOW_LOCAL_SUBMISSIONS` defaulting to false, and `SUBMISSION_GIT_TIMEOUT_MS` defaulting to 15000. Tests pass explicit config slices; source modules do not read environment variables directly.

## Tests

Local-folder resolution is fully unit-testable with no Docker and no network: point it at checked-in fixture folders and assert the resolved metadata and the fetched tree. The git path's unit coverage stubs the process wrapper and the HTTP client to assert default-branch pinning, branch/tag pinning, explicit-commit fetch verification, the reachability call shape, token redaction, and that a non-resolving ref and an unreachable repo each surface as the right typed failure. An opt-in integration test that actually runs `ls-remote` and shallow fetches a real public repo is gated like the other Docker/network-touching suites. Tests also assert the dev gate: with `ALLOW_LOCAL_SUBMISSIONS` off, the local source is never constructed and a local request is refused.

## Done when

Given a public git URL with no ref, the source resolves to the default-branch head SHA and fetches that tree; given an explicit branch, tag, or full commit SHA, it pins the intended commit. A local-folder path (gate on) fetches the fixture tree with no commit. An unreachable repo, an auth-walled repo without credentials, and a non-resolving ref each return a typed, classifiable failure rather than hanging or throwing opaquely; the worker (step 5) records these as the `resolve` stage of the validation log (failed, with the typed reason as its detail) while still rolling the submission up to `static_failed`, so the owner's poll distinguishes "could not fetch the repo" from "manifest is malformed". With the gate off, local submissions are refused before touching the filesystem. The fetched tree is the input the static validator (step 3) reads next.
