# Stage 5.7: Testing, CI Wiring, and Docs

Status: not started.

Part of [Stage 5](../stage-05-submissions.md). This is the cross-cutting companion to build-order steps 1-6, matching the convention every prior stage follows (see [stage-04/testing-ci-and-docs.md](../stage-04/testing-ci-and-docs.md)). It collects where the stage's exit criteria become executable, what new CI jobs gate them, and which docs change. Most of the testing detail lives in each step's own file; this file is the wiring and the seams that no single step owns.

## Test layering

The stage splits cleanly along the Docker line, the same split Stage 4 used:

- **Docker-free unit (Vitest, `:memory:` / FakeDriver):** the storage supersede-and-seed rules plus `session_submissions` attribution, the `submission_checks` log transitions, and pending-row recovery read (step 1), the local-folder source and stubbed git resolution (step 2), the **entire static validator against fixtures** (step 3, the first demonstrable slice and the bulk of the "Done when" provable with no Docker), the reachability and submit routes' non-build paths, the validation worker's queue and per-stage log writes, and the form's polled stage-timeline behavior (step 5), the overlay-image eviction policy over a fake driver (step 4 — the budget, oldest-first, active-`ready` exemption, and debris tolerance, with the real `removeImage` left to the Docker gate), and the orchestrator/profile reads (step 6). These run on the existing workspace-wide `test:ts` with no new infrastructure.
- **Harness (Python):** the `validate` command's load-check outcomes (step 4), run by the harness's own suite alongside the existing session tests.
- **Docker-gated integration + e2e:** the overlay build and the real sandboxed load check (step 4), and the end-to-end submit, build, watch journey plus the `load_failed`-on-profile and human-play-still-works variations (step 6). Gated behind the Docker daemon exactly like `backend-integration` and the Stage 4 `frontend-e2e`.

## Fixtures

A checked-in fixture set is the backbone of the stage's provability and is shared across steps 3, 4, and 6: a valid worked-example repo, the extra Flappy Bird example agents, and a family of intentionally malformed repos. The static cases cover missing manifest, bad JSON, each bad field, unknown key, missing entry point, unknown `template_version`, and iteration `template_version` mismatch. The dynamic cases cover a manifest naming a non-existent class, a module that fails on import, a constructor that raises, and a class missing a hook. Living in one place keeps the static-validator unit tests, the harness `validate` tests, and the e2e journey citing the same inputs.

## CI wiring

- The Docker-free suites ride the existing `check:ts` and `test:ts` workspace jobs with no YAML change, picking up the new backend submission modules and the frontend form/profile components. CI applies the two coordinated Biome edits [2-source-resolution.md](2-source-resolution.md) describes (the `submission/source/` override block plus the broad-block exclusion, preserving "exactly one override per file") and proves no other backend source imports `child_process`; a _package_ HTTP client, if chosen over global `fetch`, is confined the same way per that file.
- The harness `validate` tests ride the existing harness test job.
- The Docker-gated build/load-check and the submission e2e extend the existing gated jobs (`backend-integration` and `frontend-e2e` in `scripts/ci.py` / `ci.yml`), needing the session base image and the Docker daemon, runnable directly the same way. Decide per implementation whether these are new gated jobs or additions to the existing ones; record the choice here.
- If the manifest contract changes, the `generated-code-fresh` / lockstep check between the TS static validator and [manifest.py](../../harness/src/game_sandbox_harness/manifest.py) must stay green. The two halves of the loader contract cannot drift.

## Docs

Contributor docs under `docs/contributors/`:

- `docs/contributors/backend.md` - the `iterations`, `submissions`, `session_submissions`, and `submission_checks` tables and the seed, the pending-submission worker and the per-stage validation log it writes, the `SubmissionSource` seam and its config (`GITHUB_TOKEN`, `ALLOW_LOCAL_SUBMISSIONS`, `SUBMISSION_GIT_TIMEOUT_MS`, `DEPS_VERSION`), the static-validator reasons, and the submission/reachability/status endpoints including the validation-log payload.
- `docs/contributors/execution.md` - the overlay build path, the `submission-overlay` image spec, the load check under the sandbox profile, the driver options that bound and cache it (the caching default and the build/load-check timeouts that keep a hung build from stalling the worker), and the overlay-image eviction sweep with its config (`OVERLAY_IMAGE_BUDGET`, `OVERLAY_IMAGE_SWEEP_INTERVAL_MS`), its active-`ready` exemption, and the two driver-interface additions it needs (overlay-image enumeration and best-effort `removeImage`).
- The harness contributor docs - the `validate` subcommand and its structured result.
- `docs/contributors/frontend.md` - `SubmitAgentForm.vue` and its polled per-stage validation timeline, the dev-only local-path gate, the agent profile page (including the stored validation log), and the watch picker.
- `docs/contributors/test.md` - the new gated coverage and how to run it.

Participant-facing docs: this is the first stage that changes anything participant-facing since the template repos shipped, so the student-facing submission instructions (how to paste a repo URL, what gets validated and why a submission might be rejected) are written or updated here, pointing at the manifest/packaging contract.

## Parent-plan upkeep

Per [the plan README](../README.md), this stage's files and the specs must not drift from what gets built: confirm or correct the proposed defaults (caching policy, validation-worker processing, config names) in the relevant step files as implementation confirms them, flip the [Stage 5](../stage-05-submissions.md) status line when work begins and ends, and keep the static-validator/`manifest.py` contract changes in the same change set on both sides.

One existing doc comment needs reconciling in the same change set: [backend/src/deps-version.ts](../../backend/src/deps-version.ts) currently says "Stage 5 resolves a session's version per submission **from its manifest**." Stage 5 as planned resolves the version from the **iteration's pinned `deps_version`** and only _validates_ that the submission's manifest `template_version` matches it (steps 3–4); the overlay build and the watch run both take the version from the iteration, not the manifest directly. Update that comment when step 4 lands so code and plan agree on where the version comes from.

## Done when

Every exit criterion in [Stage 5](../stage-05-submissions.md) maps to a green test at the right layer: the static-rejection matrix and the supersede rule prove out Docker-free; the build, load check, watch run, and `load_failed`-on-profile prove out under the Docker gate; the harness `validate` outcomes prove out in Python. CI runs them in the right jobs, and the docs describe the system that was actually built.
