# Stage 5.5: Submission API and Form

Status: done.

Implementation summary:

- **Validation worker** ([backend/src/submission/worker.ts](../../backend/src/submission/worker.ts)): a bounded (concurrency-1) in-process queue that drives a pending submission through the four ordered, logged stages — `resolve` (source resolve + pin + checkout), `static`, `build` (overlay image), `load` (sandboxed load check). Each transition writes the per-stage check before the rollup; a structured stage failure stops the pipeline and writes the matching terminal status (`static_failed`/`build_failed`/`load_failed`); a `finally` disposes the fetched tree on every path and the crash wrapper closes a thrown stage's `running` check and writes its rollup so nothing is left permanently `running`. `start()` re-enqueues active `pending` rows; the `(submission_id, stage)` upsert makes a re-enqueue a clean fresh run. `whenIdle()` is the test/shutdown sync point. Reads the iteration's pinned `deps_version` via the new `Storage.getIteration(id)`.
- **HTTP routes** ([backend/src/app.ts](../../backend/src/app.ts)): `GET /api/submissions/capabilities`, `POST /api/submissions/reachability` (local refused 403 when the gate is off), `POST /api/submissions` (202 + enqueue, never inline; `409 no_open_iteration`; `409 resubmit_conflict`; identity from the seam, never the body), `GET /api/submissions/:id` (joined with its ordered checks), `GET /api/submissions` (the user's history), `GET /api/environments/:envId/submissions` (active by open iteration + status). Wired in [main.ts](../../backend/src/main.ts) with the source seam, the worker (overlay-eviction sweep as its `onOverlayBuilt` hook), and startup re-enqueue.
- **`SubmitAgentForm.vue`** ([frontend/src/components/SubmitAgentForm.vue](../../frontend/src/components/SubmitAgentForm.vue)), slotted into the environment page: verify-reachability-before-submit (re-typing disarms the verdict), submit under the signed-in identity, then a polled four-stage timeline that advances in-progress→passed/failed, a failed-stage detail banner, the pinned commit on accept, and a bounded-wait "still processing" non-terminal notice. The dev-only local-folder field renders only on `import.meta.env.DEV` plus the backend capability. New typed client wrappers in [client.ts](../../frontend/src/api/client.ts).
- **Tests:** backend `validation-worker.test.ts` (8) and `submission-api.test.ts` (12) — full backend suite 196 pass; frontend `submit-agent-form.test.ts` (9) plus the updated `environment.test.ts` mock — full frontend suite 89 pass. Both `npm run check` gates clean. The build/load leg reuses the step-4 Docker-gated coverage.

Notes:

- The submit/reachability routes refuse a local source with `403 local_disabled` at the route, before the source seam, when `ALLOW_LOCAL_SUBMISSIONS` is off.
- A new `Storage.getIteration(id)` was added (index.ts + kysely.ts) so the worker reads the submission's own iteration's `deps_version` rather than coupling to the global default — forward-compatible with Stage 6 closing iterations.

Part of [Stage 5](../stage-05-submissions.md). This is build-order step 5: the HTTP endpoints, the bounded background validator, status polling, and `SubmitAgentForm.vue` on the environment page, with rejection reasons surfaced where the owner can see them. It wires together steps 1-4 behind the signed-in identity and the open iteration.

## Endpoints

New routes in the backend HTTP layer (see [stage-03/orchestrator-and-http-api.md](../stage-03/orchestrator-and-http-api.md)) attribute everything to the resolved user identity from the Stage 4 seam. In the current app that is the mock user id; when OAuth replaces the seam it becomes the GitHub handle required by [frontend.md](../../docs/specs/frontend.md) and [submission.md](../../docs/specs/submission.md). No endpoint accepts a submitter field from the client.

- **Capabilities** - returns whether local submissions are enabled, so the dev-only form field is driven by backend capability as well as the frontend dev build.
- **Reachability pre-check** - given a repo URL and optional ref, calls the source's `verifyReachable` (step 2) and returns reachable / not-reachable so the form can verify _before_ accepting, the explicit [frontend.md](../../docs/specs/frontend.md) requirement. No row is written.
- **Submit** - given a source for an environment (a git URL plus optional ref, or, when `ALLOW_LOCAL_SUBMISSIONS` is on, a local path), the route resolves the open iteration (step 1), creates the pending submission row, enqueues the validate-and-build job, and returns `202 Accepted` with the submission id and current `pending` status. Resubmission supersedes the prior active submission when the pending row is created, so even a failed resubmission is the active submission until the owner submits again. The route does not perform git resolution, static validation, image build, or load check inline after the row is written.

  Two refusal cases are handled explicitly rather than crashing or inventing data. If `getOpenIteration` returns nothing for the environment — impossible right after the startup seed, but reachable once Stage 6 can close an iteration without opening the next — the route refuses with a typed `409 no_open_iteration` and writes no row, rather than `null`-dereferencing or inventing an iteration; the form surfaces it as "submissions are closed for this environment." The concurrent-resubmit conflict the storage transaction can raise (step 1's `createSubmission`) surfaces here as a retryable `409` as well, not a 500.

- **Submission read/list** - three reads. Fetch a single submission's status, reason, **and its per-stage validation log** (`listSubmissionChecks` from step 1: the ordered `resolve`/`static`/`build`/`load` checks with their `running`/`passed`/`failed` state and detail). List the current user's submissions. And list active environment submissions filtered by open iteration and status. The single-submission read returns the submission joined with its checks in one payload, so a poll is one request. The form uses the individual read result (status plus log), the watch picker uses active `ready` environment submissions, and the agent profile (step 6) uses the user/history listing plus each submission's log.

The local-source option is refused at the route when the dev gate is off, before any resolution, matching step 2's gating.

## Validation worker

The backend owns a small bounded worker queue for pending submissions. The default concurrency is one validation job, configurable later if local Docker capacity proves it can handle more. A job runs the same pipeline described in steps 2-4 as four ordered, logged stages: source resolution and pinning (`resolve`), static validation (`static`), overlay build (`build`), and sandboxed load check (`load`).

For each stage the worker calls `startSubmissionCheck` (marking it `running`) before the stage runs, and `finishSubmissionCheck` (`passed`, or `failed` with the typed reason or captured error as `detail`) after, so a poll between those two writes shows the stage in progress. On a stage failure the worker stops the pipeline and writes the matching terminal rollup via `updateSubmissionStatus`: `static_failed` for a `resolve` or `static` failure, `build_failed`, or `load_failed`. Stages after the failure are simply never started, and the form renders them as not-run. A run that passes all four stages ends with `updateSubmissionStatus(... 'ready')`. The rollup status and the log are written together for each transition, so a poller never sees `ready` without a complete passing log, nor a terminal failure without the failed stage recorded.

Every job must reach a terminal state and own its resources, even on an unexpected throw. The worker wraps each job so that:

- it disposes the step-2 fetched-tree handle in a `finally` — the single cleanup point the source seam delegates to it — so a build or load-check that throws mid-pipeline cannot leak the temp worktree;
- an exception escaping a stage is caught, the currently-`running` check is closed with `finishSubmissionCheck(... 'failed', <error>)`, and the matching terminal rollup is written, so a crashed stage can never be left permanently `running` with no rollup.

The only path that legitimately leaves checks open is a hard process death, which the startup re-enqueue below repairs by overwriting them. There is no separate reaper for stuck `running` rows, because every in-process failure mode resolves through this `finally`.

The worker must not let stale work publish over a newer active submission. Before each terminal update, it confirms the row still exists and records the outcome on that row only. The active-submission rule still comes from `superseded_at`, so a superseded job can finish for profile history but never appears in the normal watch picker. On backend startup, active `pending` rows are enqueued again so a restart does not strand a submission forever. Because `startSubmissionCheck` is keyed on `(submission_id, stage)`, a re-enqueued submission overwrites its earlier `running` checks rather than appending duplicates, so the log a restart produces reads as a clean fresh run. This first queue is in-process and database-backed; moving it to a separate process later should preserve the same storage transitions, log writes, and read endpoint.

## `SubmitAgentForm.vue`

The "Submit agent" form on the environment page for the currently open iteration, per [frontend.md](../../docs/specs/frontend.md) and built on the Stage 4.5 primitives (`UiField`/`UiInput`, `UiButton`, `UiCard`, the status/badge primitives) so it inherits the design system rather than introducing new styles:

- Paste the repository URL, optionally a branch/tag/commit to target. The form calls the reachability pre-check and only enables submit once the repo and ref verify reachable, surfacing an unreachable repo/ref inline.
- On submit, the submission is recorded under the signed-in identity (no name field, identity comes from the session).
- While the submit request is creating the pending row, the form shows a loading state and prevents duplicate submits for the same input.
- After the route returns, the form polls the submission read endpoint until the row reaches `ready`, `static_failed`, `build_failed`, or `load_failed`. Each poll returns the per-stage validation log, which the form renders as an ordered checklist/timeline of the four stages (`resolve`, `static`, `build`, `load`), each shown as not-yet-run, in-progress, passed, or failed. The owner watches stages flip from in-progress to passed and sees exactly which stage is currently running, without blocking the rest of the page. Polling backs off to a steady interval rather than hammering. Because a wedged worker or a downed Docker daemon can legitimately leave a submission `pending` indefinitely under single-job concurrency, after a bounded wait with no stage advancing the form shows a non-terminal "still processing, this is taking longer than usual — your submission is saved and will keep validating" state instead of spinning forever or implying failure. The submission row is durable, so the owner can close the page and re-open the profile (step 6) to see the eventual outcome. The form never invents a `*_failed` state the worker did not write.
- The result state shows acceptance — and the pinned commit once `resolve` records it — or, on a failure, the failed stage highlighted in the timeline with that stage's `detail`, the specific typed reason or captured error from whichever layer rejected, rendered as an owner-facing message. The typed reasons and errors from steps 2-4 become each stage's detail, and the same log appears on the owner's agent profile (step 6).
- In **dev builds only** the form additionally offers a local-folder path input, shown exactly when the backend reports the dev gate is on (the same `import.meta.env.DEV` + backend-capability pattern Stage 4.5 used for the styleguide route). Production builds neither render nor ship the local-path affordance.

## Tests

- **Backend (Vitest, FakeDriver / `:memory:`, no Docker for the non-build paths):**
  - the capabilities route reflects config;
  - the reachability route returns the source's verdict without writing a row;
  - submit under identity A cannot be attributed to identity B;
  - submit creates a pending row and returns without running the pipeline inline;
  - the worker turns an unreachable repo into a `static_failed` row with no commit and a `resolve` check `failed`, while no `static` check exists;
  - a static-failing fixture becomes `static_failed` with a `resolve` check `passed` and the `static` check `failed` carrying the reason;
  - the single-submission read returns the submission joined with its ordered checks;
  - resubmission supersedes, and the active-submission lookup returns the new row;
  - a submit when the environment has no open iteration returns `409 no_open_iteration` and writes no row;
  - startup re-enqueues active pending rows without duplicating their checks;
  - a stage whose work throws (a stubbed source/build/load that raises) still closes the `running` check as `failed` and writes the matching terminal rollup, so no submission is left permanently `running`, and the fetched-tree handle's `dispose()` is called on both the success and the throw path;
  - the local route is 4xx when the gate is off.

  The build/load-check leg reuses the step-4 Docker-gated coverage.

- **Frontend (Vitest, jsdom, mocked fetch):**
  - the submit button stays disabled until reachability verifies;
  - the loading state prevents duplicate submit;
  - the form enters a polling state after a pending response;
  - the stage timeline renders the log, showing an in-progress stage mid-poll and the earlier stages passed;
  - a failed terminal poll highlights the failed stage and renders its detail;
  - a submission that stays `pending` past the bounded wait flips the form to the non-terminal "still processing" state rather than a failure or an infinite spinner;
  - the local-path field is absent unless dev plus gate-on;
  - submission posts under the mocked identity.

  Follows the Stage 4 frontend-unit pattern (no canvas, no network).

## Done when

A signed-in participant pastes the template repo URL, the form verifies reachability, the backend accepts a pending submission without waiting for the pipeline, the worker pins the default-branch head, validation accepts, and a second submission replaces the first for the current iteration. This matches the participant-facing half of the stage's "Done when". As the worker runs, polling the read endpoint returns the per-stage validation log, and the form shows each stage advance from in-progress to passed; on a rejection the failed stage and its detail render on the form. Every rejection reason from steps 2-4 reaches the form through the polled log and is stored on the checks for the profile. The accepted, `ready` submission is what step 6 makes runnable in a watch session.
