# Stage 5.2: Source Resolution

Status: done.

Part of [Stage 5](../stage-05-submissions.md). This is build-order step 2: the seam that turns a participant's input into a fetched tree plus the pinning metadata the submission row stores. That input is either a git URL with an optional ref or a dev-only local folder. The seam resolves and reads; it does not validate the manifest (step 3) or build an image (step 4). Local-folder resolution is fully Docker-free; the git path needs the `git` CLI but no Docker.

## The seam

A `SubmissionSource` interface in `backend/src/submission/source/` exposing what every later step needs without knowing where the code came from:

- `resolve(input)` returns `ResolvedSource`: the pinning facts the [submission.md](../../docs/specs/submission.md) tuple requires, including `kind` (`git` or `local`), `commitSha` (the exact resolved SHA for git, null for local), `repoUrl` without credentials, the requested `ref`, and the resolved ref label when git can name one. For git this is where the ref resolves to a commit and the default is the default-branch head.
- `fetchTree(resolved)` returns a handle to a read-only local checkout of the tree (a temp directory), which the static validator reads and the build pipeline overlays. The handle is disposable, and **the worker (step 5) is the single owner of its lifetime**. The validation job acquires the tree once, passes it through the static check and the overlay build, and disposes it in a `finally` so a build that throws mid-pipeline cannot leak the temp worktree. The handle exposes an explicit, idempotent `dispose()` rather than relying on process-exit cleanup, since the worker is long-lived and processes many submissions.
- `verifyReachable(input)` returns a cheap typed reachability result the form calls _before_ accepting (see [frontend.md](../../docs/specs/frontend.md): "verifies the repo and ref are reachable before accepting"), separated from the full resolve so the UI can fail fast without a checkout.

Two implementations behind the seam, selected by `source_kind` and gated by config.

## Git source

Host-agnostic by design, using the two mechanisms the deployment already has (per the parent plan):

- **`git ls-remote --symref <url> HEAD`** resolves the default branch when the participant gives no ref, returning both the branch name and its commit SHA.
- **`git ls-remote <url> <ref candidates>`** resolves advertised branches and tags. Branch names, full ref names, lightweight tags, and annotated tags are normalized to the commit they point at; annotated tags use the peeled `^{}` result when present.
- **An explicit full commit SHA** is verified by a shallow fetch of that commit into a temporary checkout, because arbitrary commits are not necessarily advertised by `ls-remote`. If the server refuses to fetch it, the ref is treated as non-resolving.
- **`fetchTree`** materializes exactly the resolved commit into a temporary worktree — a single-commit shallow checkout, `--depth 1`, so repository history is never cloned — and verifies `rev-parse HEAD` equals the pinned SHA before handing the tree to validation. `--depth 1` bounds the _history_ fetched, not the _tree_ size: a single pathological commit can still be arbitrarily large. The `SUBMISSION_GIT_TIMEOUT_MS` ceiling is the only bound this stage puts on that, so a giant tree fails as a timeout rather than filling the disk slowly. An explicit checked-out-bytes cap is deferred — noted in this file's limitations and the parent's deferred choices — rather than left as a silent assumption that repos are small.
- **The GitHub REST API client** is used only for GitHub URLs and only for reachability and auth concerns: authenticated reachability checks for private repos, and token-backed clone/fetch credentials when the operator provides `GITHUB_TOKEN` (public repos need none, per [submission.md](../../docs/specs/submission.md)). Store and log only the clean repo URL, never a tokenized URL. Non-GitHub public repos still work through the git CLI path.

The `git` binary is driven through the [`simple-git`](https://www.npmjs.com/package/simple-git) library rather than a hand-rolled `child_process` wrapper, behind a small injectable `GitRunner` seam so the unit tests stub it without spawning git. Each invocation runs with two bounds and a non-interactive posture:

- simple-git's `timeout.block`, which kills a process that produces no output (e.g. a hung credential prompt or dead host);
- a wall-clock `AbortController` ceiling for an otherwise-steady oversized fetch;
- `GIT_TERMINAL_PROMPT=0` and an empty `GIT_ASKPASS`, so an unreachable or auth-walled repo fails as a typed error rather than hanging.

Those env vars are set on `process.env` for the spawned children to inherit, _not_ passed through simple-git's `.env()`. `.env()` replaces the child env and trips simple-git's unsafe-env guard on inherited keys like `EDITOR`.

Because `simple-git` is an importable package, it confines exactly like `dockerode`, which is cleaner than the file-location-only rule a raw `child_process` carve-out would need. [biome.jsonc](../../biome.jsonc) is built on the invariant that "every `backend/src` file matches exactly one override", so the confinement has three parts:

- a new override block scoped to `**/backend/src/submission/source/**` that allows `simple-git` (by omission) while still banning `dockerode`, `kysely`, `better-sqlite3`, **and** raw `child_process`/`node:child_process` (drive git through simple-git, not a bare spawn, even here);
- a `!**/backend/src/submission/source/**` exclusion on the broad backend block;
- adding `simple-git` to the restricted-import `paths` of the broad, storage, and docker blocks so the dependency cannot leak outward, exactly as `dockerode` is handled.

No other backend module may reach the git client.

Confining the GitHub HTTP client needs an honest caveat the dockerode/kysely confinement does not. Those work because `dockerode` and `kysely` are importable packages a `noRestrictedImports` rule can name. The backend currently has **no HTTP client at all**, so the choice of client drives how confinement is enforced:

- If the GitHub helper uses the Node global `fetch`, there is nothing to import and therefore nothing Biome can restrict. Confinement is then by file location (the helper lives only under `submission/source/`) and the CI grep, not a restricted-import rule. This file should say so rather than promise an unenforceable rule.
- If instead a package client is pulled in (e.g. `octokit`/`@octokit/*` or `undici`), add it to the restricted-import `paths` of every backend override **except** the `submission/source/` block, exactly as dockerode is, so the dependency cannot leak outward.

Pick one and record the choice here; the default is global `fetch` with no new dependency.

## Local-folder source (dev only)

The development-only path from [submission.md](../../docs/specs/submission.md): the participant (really, a sandbox developer) names a folder on the server. `resolve` records `kind: local`, no commit, the folder path; `fetchTree` returns the folder directly (or a copy if the build step needs an isolated tree). It exists so the whole validate-and-build pipeline can run against the worked example, the extra Flappy Bird examples, and intentionally malformed repos without GitHub.

It is **gated off in normal deployments**. The `ALLOW_LOCAL_SUBMISSIONS` config flag defaults off and controls whether the local source is constructed and whether the API (step 5) and the dev-build form even offer it. With the flag off, a local-source request is refused before any filesystem access, and the form shows no local-path field.

With the flag on, the supplied path is treated as **trusted developer input**: the gate, not path-sanitization, is the security boundary, so this stage does not constrain the path to a sandbox root. That trade-off is acceptable only because the flag is dev-only and off by default. Note it explicitly so no deployment turns the flag on under the assumption the path is sandboxed.

## Config

New configuration consumed through the typed `Config` object (the module-level-read ban from Stage 3 still holds): optional `GITHUB_TOKEN` for private-repo auth and authenticated reachability, `ALLOW_LOCAL_SUBMISSIONS` defaulting to false, and `SUBMISSION_GIT_TIMEOUT_MS` defaulting to 15000. Tests pass explicit config slices; source modules do not read environment variables directly.

## Tests

Local-folder resolution is fully unit-testable with no Docker and no network: point it at checked-in fixture folders and assert the resolved metadata and the fetched tree.

The git path's unit coverage stubs the `GitRunner` and the HTTP client to assert default-branch pinning, branch/tag pinning, explicit-commit fetch verification, the reachability call shape, token redaction, and that a non-resolving ref and an unreachable repo each surface as the right typed failure. An opt-in integration test that actually runs `ls-remote` and shallow fetches a real public repo is gated like the other Docker- and network-touching suites.

Tests also assert the dev gate: with `ALLOW_LOCAL_SUBMISSIONS` off, the local source is never constructed and a local request is refused.

## Done when

Given a public git URL with no ref, the source resolves to the default-branch head SHA and fetches that tree. Given an explicit branch, tag, or full commit SHA, it pins the intended commit. A local-folder path (gate on) fetches the fixture tree with no commit. An unreachable repo, an auth-walled repo without credentials, and a non-resolving ref each return a typed, classifiable failure rather than hanging or throwing opaquely; the worker (step 5) records these as a failed `resolve` stage with the typed reason as its detail, rolling up to `static_failed` per subplan 1. With the gate off, local submissions are refused before touching the filesystem. The fetched tree is the input the static validator (step 3) reads next.
