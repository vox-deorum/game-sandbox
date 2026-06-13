# Stage 5.1: Storage and the Iteration Seed

Status: not started.

Part of [Stage 5](../stage-05-submissions.md). This is build-order step 1 and the data foundation the rest of the stage attaches to: the `iterations`, `submissions`, and `submission_checks` tables, the submission-to-session attribution needed for agent replay history, their migration, the `Storage` methods that speak them, and the seed that gives every environment one open iteration so a submission has an identity boundary and a pinned dependency-set version. Entirely Docker-free.

## Schema

These tables go into the single Kysely schema (`backend/src/storage/schema.ts`), the one source of truth established in [stage-03/backend-skeleton-and-storage.md](../stage-03/backend-skeleton-and-storage.md); nothing declares tables or queries outside `storage/`. Add the string-literal unions and table interfaces here, register them on the `Database` interface, and derive the domain types (`Iteration = Selectable<IterationsTable>`, `Submission = Selectable<SubmissionsTable>`, with `Insertable`/`Updateable` where an operation needs them).

`iterations`: `id` (text, backend-generated), `env_id`, `deps_version` (the template dependency-set version the iteration pins, see [submission.md](../../docs/specs/submission.md) on versioned sets), `status` (`open` or `closed`; only `open` is exercised this stage, Stage 6 adds close controls and history), `created_at`. The minimal record per [stage-05 scope](../stage-05-submissions.md): this stage seeds an iteration so submissions can attach; Stage 6 replaces the placeholder workflow with the operator CLI and full configuration. Keep the column set small enough that Stage 6 extends rather than rewrites it.

`submissions`: `id` (text, backend-generated), `iteration_id`, `env_id` (denormalized for lookups, derivable from the iteration), `user_id` (the resolved identity from the Stage 4 seam, GitHub username once OAuth replaces the mock identity), `source_kind` (`git` or `local`), `repo_url` (null for local-folder sources, never tokenized), `commit_sha` (the pinned exact SHA for git after resolution; null for local and for git rows that fail before pinning), `local_path` (null for git), `ref` (the branch/tag/commit the participant supplied, null when they gave none and we took the default-branch head), `status` (`SubmissionStatus`: `pending`, `static_failed`, `load_failed`, `build_failed`, `ready`), `reason` (null until a layer rejects; the specific owner-visible message), `created_at`, `superseded_at` (null for the active row). The API creates the row as `pending` before source resolution so an unreachable repo or non-resolving ref is still stored as a `static_failed` submission; the source resolver fills `commit_sha` when git pinning succeeds, and the build pipeline updates `status` and `reason`.

`session_submissions`: `session_id`, `submission_id`, `slot_id`, `created_at`, keyed by `(session_id, slot_id)` (one submission per slot per session; no surrogate `id` since the slot within a session is the natural key). Stage 5 writes one row per submitted-agent watch session (`player_0` for Flappy Bird), giving the agent profile a reliable way to list recent recordings through the existing `sessions.recording_id`. Stage 8 can extend the same table to one row per submitted slot in multi-agent sessions, so this is not a single-agent-only dead end.

`submission_checks`: the ordered per-stage validation log the form polls and the profile shows. `id` (text, backend-generated), `submission_id`, `stage` (`SubmissionStage`: `resolve`, `static`, `build`, `load` — the pipeline gates in run order), `status` (`CheckStatus`: `running`, `passed`, `failed`, `skipped`), `detail` (text, null until there is an owner-facing message: the typed rejection reason or the captured build/Python error text on failure), `started_at`, `ended_at` (null while a stage is still `running`). The worker writes one row per stage it reaches: `running` when the stage starts, then the outcome when it finishes; stages after a failure are never reached and are simply absent, which the form renders as not-yet-run. A unique `(submission_id, stage)` index keeps a stage to a single row even when startup re-enqueues a `pending` submission. Crucially the log does **not** replace or change the submission's own `status`/`reason`: those stay the terminal rollup the watch picker and active-submission rule filter on (`resolve`/`static` failures roll up to `static_failed`, `build` to `build_failed`, `load` to `load_failed`), while the checks are the granular "where did it go wrong" view layered on top. A submission that fails `resolve` therefore has a rollup `status` of `static_failed` but a log that distinguishes the unreachable-repo stage from the static-manifest stage.

The one-active-submission-per-participant-per-iteration rule from [submission.md](../../docs/specs/submission.md) is enforced at the storage layer, not by a route: a partial unique index (or SQLite's equivalent) on `(iteration_id, user_id)` where `superseded_at IS NULL`. Decision recorded here: resubmission replaces by marking the prior row superseded and inserting a new one, so the owner's profile (step 6) can still show submission history across the iteration rather than losing the old commit. The active-submission lookup filters on `superseded_at IS NULL` regardless of status, so a failed resubmission is still the participant's active submission until they submit again.

## Migration

One new ordered TypeScript migration module under the storage package, run on startup through Kysely's `Migrator` exactly as Stage 3 established (no migration CLI; deployment is "start the process"). It creates the new tables (`iterations`, `submissions`, `session_submissions`, `submission_checks`), the active-submission index, the unique `(submission_id, stage)` index on `submission_checks`, and foreign-key indexes for iteration, submission-check, and profile lookups. It is additive over the Stage 3 and Stage 4 migrations and does not rewrite existing rows.

## Storage interface

Extend the `Storage` interface (`storage/index.ts`) and its Kysely implementation (`storage/kysely.ts`) with the domain-shaped methods the later steps call, never exposing SQL or query building:

- `getOpenIteration(envId)` - the current open iteration for an environment, the identity boundary every submission needs.
- `ensureOpenIteration(envId, depsVersion)` - the seed primitive (below), idempotent.
- `createSubmission(input)` - takes a domain-shaped `NewSubmissionInput`, supersedes any active submission by the same user in the same iteration, and inserts the new row as `pending`. The input records the requested source; `commit_sha` may still be null.
- `updateSubmissionPin(id, commitSha)` - records the resolved git commit after source resolution succeeds.
- `updateSubmissionStatus(id, status, reason?)` - the terminal rollup transition the validator and build pipeline drive. Passing a success status clears any prior reason.
- `startSubmissionCheck(submissionId, stage)` and `finishSubmissionCheck(submissionId, stage, status, detail?)` - the per-stage log transitions the worker drives: `start` upserts a `running` check for the stage (keyed by the unique `(submission_id, stage)` index so a re-enqueue overwrites rather than duplicates), `finish` stamps `ended_at` and the `passed`/`failed`/`skipped` outcome with its detail. These are written alongside the rollup `updateSubmissionStatus` as each gate runs.
- `recordSessionSubmission(sessionId, submissionId, slotId)` - records which submitted agent ran in which session slot, so recordings can be shown on the agent profile.
- `getSubmission(id)`, `findActiveSubmission(iterationId, userId)`, `listPendingSubmissions()`, `listSubmissionsByUser(userId, envId?)` (history, **including superseded** rows, so the profile shows every commit and the supersede test can assert both rows survive), `listActiveSubmissionsByIteration(iterationId, status?)` (active rows only, `superseded_at IS NULL`, for the watch picker), `listSubmissionChecks(submissionId)` (the validation log ordered by stage sequence, for the read endpoint and profile), and `listRecordingsBySubmission(submissionId, limit)` - the reads the API, the validation worker, startup pending-row recovery, watch picker, and the agent profile (step 6) need.

## Seed

On startup the backend seeds one open iteration per registered environment using the current `DEPS_VERSION` from `backend/src/deps-version.ts`, with the generated environment registry from [stage-03/backend-skeleton-and-storage.md](../stage-03/backend-skeleton-and-storage.md) supplying the env ids. The seed calls `ensureOpenIteration` for each env and is idempotent: a restart against an existing database is a no-op, and an environment already carrying an open iteration is left untouched. This is the deliberately minimal stand-in the parent plan calls out: enough identity and dependency-set version for submissions to attach to, nothing of Stage 6's configuration.

## Tests

Vitest against the real Kysely implementation on better-sqlite3 `:memory:`, no Docker:

- The migration creates the new tables and indexes; a second `Migrator` run is a no-op.
- The seed creates exactly one open iteration per environment and is idempotent across a simulated restart.
- `createSubmission` inserts a `pending` row; a second submission by the same user in the same iteration stamps `superseded_at` on the first, `findActiveSubmission` returns only the new one, and `listSubmissionsByUser` still returns both (history preserved — this is the same superseded-inclusive read the agent profile in step 6 uses).
- A second submission by a _different_ user in the same iteration does not supersede the first, because the uniqueness is per participant.
- `updateSubmissionPin` records the resolved commit for git submissions and leaves local submissions commitless.
- `updateSubmissionStatus` moves a row from `pending` to `static_failed`, `load_failed`, `build_failed`, or `ready` and records or clears the reason.
- `startSubmissionCheck` inserts a `running` check and `finishSubmissionCheck` stamps it `passed`/`failed`/`skipped` with detail; a second `start` for the same `(submission_id, stage)` overwrites rather than duplicating (the re-enqueue-on-restart case). `listSubmissionChecks` returns a submission's checks in pipeline-stage order (`resolve`, `static`, `build`, `load`), so a polled read shows exactly which stages ran, which is `running`, and which failed with its detail.
- `listPendingSubmissions` returns active pending rows newest-first so the validation worker can re-enqueue them on startup without resurrecting superseded work.
- `listActiveSubmissionsByIteration` filters out superseded history and can narrow by status, which is what the watch picker uses for `ready` submissions.
- `recordSessionSubmission` links a session to a submission and slot; `listRecordingsBySubmission` returns the session's recording ids newest-first and ignores sessions that never produced a recording.

## Done when

The backend boots against an empty database, runs the new migration, and seeds one open iteration per environment at the current `DEPS_VERSION`; the storage suite proves the supersede-on-resubmit rule and the seed's idempotency on `:memory:`. No route, form, Docker, or harness work is required for this slice. It is the storage seam the next five steps are written against.
