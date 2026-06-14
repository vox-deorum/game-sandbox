# Stage 5: Submissions

Status: in progress (subplans 1-2 complete)

## Goal

Participants can submit agents through the website and watch them play. A submission is fetched, pinned, validated without running a game session, stored, built into a session image, and runnable in the watch flow for the current single-agent environment. The first demonstrable slice is validation: every submission is gated by a static check and a sandboxed load check, each rejecting with a specific reason the owner can see. The Flappy Bird slice is single-slot and does not pretend there is an opponent slot (see Scope).

## Scope

Implement submission storage and rules from [submission.md](../docs/specs/submission.md): a submission is the repository pinned to a commit, the resolved user id, and the iteration. The resolved user id is the Stage 4 identity seam: in local development it is still the mock user id, and when GitHub OAuth replaces that seam it is the GitHub username the spec describes. The submission form never accepts a username field. One active submission per participant per iteration; resubmission replaces the active row while preserving history. This stage creates or seeds a minimal current open iteration record per environment so submissions have the right identity boundary and dependency-set version. Stage 6 replaces that placeholder workflow with the operator CLI, full configuration, open and close controls, and historical iteration views.

Submissions come from two sources. A **git repo URL** is the participant-facing path: the participant pastes the URL, optionally with a branch, tag, or commit, and the backend resolves it to an exact commit SHA and pins that (defaulting to the default-branch head). A **local folder** is a development-only source, gated off in normal deployments, so the whole pipeline can be exercised without GitHub. Resolving a git URL uses the host-agnostic git CLI for the actual pin and tree checkout. The GitHub REST API is an optional helper for GitHub reachability and private-repo authentication when the operator provides a token; non-GitHub public repos use the same non-interactive git reachability path as resolution.

**Validation never runs a game session** (see [submission.md](../docs/specs/submission.md)). It has two layers, each producing an owner-visible rejection reason. The whole pipeline (source resolution, the static check, the overlay build, and the sandboxed load check) is recorded as an ordered **per-stage validation log** so the owner can poll a submission and watch each stage start, pass, or fail, and read the exact reason on the stage that rejected rather than only a single terminal status:

- A **static check** in the TypeScript backend reads the fetched tree and runs no participant code: the manifest is present, is valid JSON, carries exactly the required fields with the right types and no unknown keys, names an entry-point module file that exists, targets a `template_version` the deployment has a base image for, and matches the open iteration's pinned `deps_version`. This mirrors the static half of the harness loader (`load_manifest` in [manifest.py](../harness/src/game_sandbox_harness/manifest.py)) and is fully exercisable in Docker-free unit tests against local fixtures. This is the first demonstrable slice of the stage.
- A **sandboxed load check** then confirms the agent loads: a new harness `validate` command runs `load_agent` (import the module, instantiate the class, confirm callable `reset`/`act`) inside the locked-down container with no environment stepping. Reuses the dynamic half of the same loader.

Build the "Submit agent" form on the environment page per [frontend.md](../docs/specs/frontend.md): paste repo URL (optionally a ref), verify reachability before accepting, surface rejection reasons, and record the submission under the resolved identity. In dev builds the form also offers a local-folder path when the backend capability says local submissions are enabled.

Implement the build pipeline from [execution.md](../docs/specs/execution.md): overlay the submitted code into its per-slot directory on the base image for the dependency-set version the iteration pins, and run the sandboxed load check against the built overlay. There is no per-submission dependency installation; dependencies come from the versioned template set (see [submission.md](../docs/specs/submission.md)). A submission that fails source resolution, static validation, the build, or the load check is stored and shown to the owner rather than run. Builds go through the Stage 3 execution driver. Stage 5 accepts a submission by writing the pending row and enqueuing the validate-and-build job, then returns the submission id and current pending status immediately; a bounded backend worker processes the queue outside the request path, updates the row to the terminal status while appending a per-stage validation log as each gate runs, and is polled by the form/profile through the normal read endpoint. Because each built submission leaves a cached overlay image, a Stage 4-style eviction sweep keeps overlay-image disk use bounded; an overlay is always rebuildable on demand, so eviction never loses anything but a rebuild. Caching and eviction are driver configuration (subplan 4).

Extend the session orchestrator so a session can name a submission for its non-human slot and run the corresponding image. Wire the watch submitted-agent flow for Flappy Bird (pick a submitted agent, run it in the single slot, stream to the renderer). Keep human Flappy Bird play as a human-controlled single-slot session through the Stage 3 path; choosing submitted opponents for human-capable slots appears when an environment actually exposes both human and agent slots, with the first full multi-agent version in Stage 8.

Build the agent profile page: submission history across iterations, recent replays, build/validation status, and placeholders for leaderboard placements (Stage 6) and the LLM debug view (Stage 7).

## Spec references

[submission.md](../docs/specs/submission.md) (sources, validation, rules), [frontend.md](../docs/specs/frontend.md) (form, agent profile, flows), [execution.md](../docs/specs/execution.md) (overlay build, sandboxed load check, images).

## Depends on

Stage 3 (orchestrator, driver, base image), Stage 4 (identity, environment page, flows).

## Build order

Each step is broken out into its own subplan under [stage-05/](stage-05/), plus a cross-cutting [testing, CI, and docs](stage-05/7-testing-ci-and-docs.md) companion.

1. **[Storage and the iteration seed](stage-05/1-storage-and-iteration-seed.md).** Add `iterations`, `submissions`, and submission-to-session attribution to the single Kysely schema, a migration, and the storage-interface methods; seed one open iteration per environment with the current `DEPS_VERSION`. Docker-free.
2. **[Source resolution](stage-05/2-source-resolution.md).** A `SubmissionSource` seam: the dev-gated local-folder source, a non-interactive git CLI source for default-branch, branch, tag, and explicit-commit pinning, and the GitHub API client for GitHub reachability and private-repo auth. Docker-free for local folders.
3. **[Static validator](stage-05/3-static-validator.md).** A pure TypeScript check over the fetched tree, mirroring `load_manifest` plus entry-point-file existence, known `template_version`, and iteration `deps_version` matching, returning a typed accept or a specific reason. Fully unit-testable against local fixtures with no Docker. First demonstrable slice.
4. **[Sandboxed load check and overlay build](stage-05/4-load-check-and-overlay-build.md).** The harness `validate` command and a `submission-overlay` image spec on the driver; the load check runs against the built overlay image under the no-network, read-only profile with a short timeout; and a driver-run eviction sweep that bounds overlay-image disk use while exempting the active `ready` images the watch picker launches.
5. **[Submission API and form](stage-05/5-submission-api-and-form.md).** The endpoints, bounded validation worker, a polled per-stage validation log, and `SubmitAgentForm.vue`, with each stage's progress and the rejecting stage's reason surfaced on the form.
6. **[Watch-run and agent profile](stage-05/6-watch-run-and-agent-profile.md).** The orchestrator names a submission for the agent slot, the watch picker, and the agent profile page.

## Done when

A signed-in participant submits the template repo by URL, the backend pins the default-branch head commit, validation accepts it, and a second submission replaces the first active submission for the current iteration while the history remains visible. Static validation rejects each malformed fixture with the correct, specific reason, proven by Docker-free unit tests. A local-folder submission of the worked example and the additional Flappy Bird examples passes static validation and the sandboxed load check, is built, and runs in a Flappy Bird watch session. A repo whose manifest names a class that does not exist is accepted statically but fails the sandboxed load check; polling the submission shows the static stage passing and the load stage failing with the captured error, and the same per-stage log is on the owner's profile instead of a session. Human-controlled Flappy Bird sessions still work through the Stage 3 path.

## Deferred choices

Submission processing is intentionally asynchronous in this stage. The HTTP route must not wait on git resolution, image build, or container load checks after the pending row has been created. A simple in-process worker with a durable pending row is enough for the first implementation; a separate process or external queue can replace it later without changing the validation contract or the form's status-read flow. Local-folder submissions still go through the overlay build and load check; letting them validate against a bind mount is an optimization deferred until Docker-gated tests show the build step is the bottleneck.

The validation log is modeled as a dedicated, append-only `submission_checks` table (one row per pipeline stage) rather than a JSON column on the submission, keeping the relational schema the single source of truth and giving the agent profile ordered, queryable history (subplan 1). It records structured stage outcomes plus the rejection reason or error text; streaming raw build/container output line-by-line is out of scope and can be layered onto the same table later without changing the poll contract.
