# Stage 6.1: Iteration Config, Visibility, and Storage

Status: not started.

Part of [Stage 6](../stage-06-leaderboards.md). This is build-order step 1 and the data foundation the rest of the stage attaches to: it grows the minimal Stage 5 `iterations` record into full per-iteration configuration, adds the lifecycle and visibility axes, the run/game/result/placement/rating tables, their migration and storage methods, and the operator-allowlist seam the admin API gates on. Entirely Docker-free.

## What Stage 5 already built

[Stage 5.1](../stage-05/1-storage-and-iteration-seed.md) created `iterations` (`id`, `env_id`, `deps_version`, `status` = `open`|`closed`, `created_at`) seeded one-per-environment at startup, plus `submissions`, `submission_checks`, and `session_submissions`. It deliberately kept the iteration columns small so this stage extends rather than rewrites. This step keeps the seed working: an already-seeded Stage 5 iteration migrates to a `draft`, `open` iteration with an empty default match design so local submissions still work. New operator-declared iterations start `draft` and `closed`; opening one preserves the existing one-open-iteration-per-environment invariant.

## Schema

All tables live in the single Kysely schema (`backend/src/storage/schema.ts`), the one source of truth from [stage-03/backend-skeleton-and-storage.md](../stage-03/backend-skeleton-and-storage.md); nothing declares tables or queries outside `storage/`. Add the string-literal unions and table interfaces, register them on the `Database` interface, and derive domain types (`Iteration = Selectable<IterationsTable>`, etc., with `Insertable`/`Updateable` where an operation needs them).

### `iterations` - extended

Keep the Stage 5 columns; rename and add for the two-axis lifecycle and the configuration. The submission window and the visibility are independent, so model them as two columns rather than overloading one `status`:

- `submission_status` (`open`|`closed`): the Stage 5 `status` renamed for clarity; controls whether the submission form accepts agents. The migration renames the existing column, drops `iterations_open_unique`, and recreates it as a partial unique index on `(env_id) WHERE submission_status = 'open'` so only one iteration per environment can accept submissions at once.
- `visibility` (`draft`|`published`): operator-only until published, then visible on the environment page and in history. Seeded iterations start `draft`.
- `label` (text, nullable): an operator-facing name for the iteration ("Week 3", "Final round"); the admin console and history list show it.
- `deps_version` (unchanged): the pinned template dependency-set version, defaulting to the latest template release at declaration (the current `DEPS_VERSION`), per [submission.md](../../docs/specs/submission.md).
- `config` (text, JSON): the structured iteration configuration (below), stored as one validated JSON document rather than spread across columns, because it is a nested, evolving shape (match design, override blocks) that is read and written whole by the admin API and the workflow, never queried by field. A typed `IterationConfig` codec (parse + serialize, rejecting unknown keys) is the single gate; the column never holds unvalidated text.
- `created_at` (unchanged), `published_at` (nullable, stamped on first publish for history ordering).

Operator-created iterations are `draft` and `closed` by default. The only exception is the migrated Stage 5 seed row, which stays `open` for local continuity. Opening an iteration fails with a typed conflict if another iteration for the same environment is already open; closing that other iteration is explicit.

Decision recorded here: `config` is a JSON document, not normalized into `match_configurations`/`overrides` tables. The match design is small (a handful of slot compositions), authored and read as a unit, and has no row-level query needs; a JSON column keeps the schema flat and lets the shape evolve (messaging/LLM overrides land inert now, activate in Stages 8/9) without a migration per field. The run results below _are_ normalized, because those are queried per-agent for the board.

`IterationConfig` shape (the typed codec, documented here so the admin API in step 3 and the scheduler in step 2 share one definition):

- `matches`: a list of match configurations. Each has `slots` (an ordered list of seat specs, each `builtin-naive` or `submission`), `seeds` (a list of integers passed to both env and agents), and `games` (the per-configuration game count the scheduler uses, see step 2). For Flappy Bird a single match with one `submission` slot is the norm; multi-slot compositions (`[naive, naive, naive, submission]`) are valid and forward-compatible with Stage 7 opponents.
- `overrides`: an optional block with `step_timeout_ms`, `episode_timeout_ms` (effective this stage, fall back to environment defaults from [environment.md](../../docs/specs/environment.md) when absent), and the parsed-but-inert `messaging` (length cap / disable) and `llm` (model allowlist, token/call/rate budgets) blocks the codec validates and stores so the format is stable before Stages 8/9 consume them. The operator's iteration-wide rating prompt is **not** part of `config`. It is display-only human-feedback guidance read live at rating time, never from a run's `config_snapshot`, and the operator must be able to set or adjust it at any point in the iteration's life. Because `config` is frozen the moment a workflow run exists (step 3, for execution reproducibility), folding the prompt into `config` would wrongly lock it after the first run. So it is its own always-editable column:

- `rating_prompt` (text, nullable, length-capped): the operator's iteration-wide rating prompt shown to human raters for every agent in the iteration (see step 6 and [leaderboard.md](../../docs/specs/leaderboard.md)). Null/empty means no iteration prompt. Editable regardless of submission window, visibility, or whether runs exist, since it never affects workflow execution.

### `sessions` - iteration attribution

Add nullable `iteration_id` to the existing `sessions` table, back-filled to null for old rows. Stage 6 writes it for every new watch or play session by resolving the environment's current open iteration at session start, whether the session uses a submitted agent or only built-in agents. This is the iteration key ratings use later; old rows with null `iteration_id` cannot receive ratings because their competition boundary is unknown.

### Agent identity

Use one agent identity shape everywhere this stage stores or returns an agent: `AgentRef = { kind: 'submission', submission_id, user_id } | { kind: 'builtin-naive' }`. Tables that need filtering or grouping store it in concrete columns, not opaque JSON: `agent_kind` (`submission`|`builtin-naive`), `agent_submission_id` nullable, and `agent_user_id` nullable. For `builtin-naive`, both nullable columns are null. For a submitted agent, both are required. This exact shape is used by scheduled slots, `game_results`, `automated_placements`, ratings, board payloads, and rating payloads.

### `iteration_runs` - one workflow execution

The automated workflow can run more than once per iteration (the re-run requirement), and each run replaces the iteration's board. Model the run explicitly so a re-run is a new run row and the board always points at the latest completed one:

`iteration_runs`: `id` (text, backend-generated), `iteration_id`, `requested_by` (operator identity), `config_snapshot` (validated `IterationConfig` JSON copied from the iteration when the run is created), `deps_version_snapshot` (the iteration's dependency-set version at run creation), `status` (`RunStatus`: `pending`, `running`, `completed`, `failed`, `cancelled`), `started_at`, `ended_at` (null while running), `error` (nullable text for a run-level failure). The admin status view and log stream key off this row. The runner and scheduler read the snapshots, not the mutable `iterations` row, so editing an iteration after a run starts cannot change what `match_index` or the run's dependency version means.

### `iteration_run_games` - one scheduled match

`iteration_run_games`: `id`, `run_id`, `match_index` (which `config_snapshot.matches` entry produced it), `game_index` (the deterministic schedule index within the run), `seed`, `slots` (JSON array of resolved `AgentRef` values, one per seat), `status` (`GameStatus`: `pending`, `running`, `completed`, `failed`, `timed_out`, `cancelled`), `recording_id` (nullable FK into the Stage 4 recordings, set when the run records; this is the per-row replay link the board exposes), `started_at`, `ended_at`, `error`. The workflow (step 4) writes these; the board (step 5) aggregates them. `game_index` is also the tie-breaker for representative replay selection.

### `game_results` - per-slot outcome of a game

Normalized so the board can aggregate per agent: `game_results`: `id`, `game_id` (FK `iteration_run_games`), `slot_index`, `agent_kind`, `agent_submission_id`, `agent_user_id`, `episode_score` (the normalized higher-is-better leaderboard score from the recording), `mean_agent_compute_ms` (average per acted tick of `decision_ms + learn_ms` now, with future `chat_ms` and LLM wait included when those hooks land), `failed` (boolean: the agent crashed or timed out but a score row exists), and `failure_reason` (nullable text). One row per participating seat per game when a result can be attributed to a specific agent. An infrastructure failure, such as a container that never starts or an unreadable recording, marks the game failed but does not invent a `game_results` row.

### `automated_placements`

Persist only the per-agent placement snapshot needed by profiles and history, not full board rows. `automated_placements`: `iteration_id`, `env_id`, `run_id`, `rank`, `agent_kind`, `agent_submission_id`, `agent_user_id`, `mean_score`, `mean_agent_compute_ms`, `failure_count`, `recording_id`, `created_at`. Submitted-agent rows are unique on `(iteration_id, agent_kind, agent_submission_id)`. Because the Naive row has a null `agent_submission_id`, add a second partial unique index on `(iteration_id, agent_kind) WHERE agent_kind = 'builtin-naive'`. Placement rows are rewritten when a new completed run supersedes the prior completed run.

### `ratings`

`ratings`: `id`, `iteration_id`, `env_id` (denormalized for lookups), `rater_user_id` (the resolved identity from the Stage 4 seam), `agent_kind`, `agent_submission_id`, `agent_user_id`, `score` (integer 1-5), `created_at`, `updated_at`. A unique index on `(iteration_id, rater_user_id, agent_kind, agent_submission_id)` enforces one effective rating per user per agent per iteration; because SQLite treats nulls as distinct, add a second partial unique index on `(iteration_id, rater_user_id, agent_kind) WHERE agent_kind = 'builtin-naive'` for the Naive row. Re-rating is an upsert that overwrites `score`/`updated_at`. Ratings of the user's own submitted agent (`agent_kind = 'submission'` and `rater_user_id == agent_user_id`) are rejected at the storage/route layer and never inserted. The Naive baseline has no owner and is rateable.

### `agent_rating_prompts`

The author-set rating prompt is the second of the two prompts a rater sees (the first is the operator's `iterations.rating_prompt`). It is the agent author's own statement of what to evaluate, settable and editable after submission, so it is **not** part of the pinned, validated submission artifact and does not live on the `submissions` row. Store it in its own table keyed per agent-author per iteration so it survives resubmission within the iteration (a participant has one agent per iteration; the prompt is about that agent, not a specific commit):

`agent_rating_prompts`: `iteration_id`, `env_id` (denormalized), `user_id` (the author's resolved identity), `prompt` (text, length-capped), `updated_at`. Unique on `(iteration_id, user_id)`. Only submitted agents have authors, so the Naive baseline never has a row here; when rating Naive, only the iteration prompt applies. The rating read (step 6) resolves a submitted agent's author prompt by `(iteration_id, submission.user_id)`, independent of which `agent_submission_id` ratings key on, so a resubmission does not drop the author's prompt.

## Migration

One new ordered TypeScript migration module under the storage package, run on startup through Kysely's `Migrator` exactly as the earlier stages established (no migration CLI; deployment is "start the process"). It: renames `iterations.status` to `submission_status`; drops and recreates the open-iteration partial unique index on `(env_id) WHERE submission_status = 'open'`; adds `visibility`, `label`, `config`, `rating_prompt`, and `published_at` to `iterations` (with `visibility` defaulting `draft`, `config` defaulting an empty-matches document for already-seeded rows, `rating_prompt` null); adds nullable `iteration_id` to `sessions`; creates `iteration_runs`, `iteration_run_games`, `game_results`, `automated_placements`, `ratings`, and `agent_rating_prompts`; and adds the hot-read indexes: `iteration_runs(iteration_id)`, `iteration_run_games(run_id, game_index)`, `game_results(game_id)`, `game_results(agent_kind, agent_submission_id)`, `automated_placements(agent_kind, agent_submission_id, env_id)`, `ratings(iteration_id, agent_kind, agent_submission_id)`, the unique `agent_rating_prompts(iteration_id, user_id)`, plus the placement and rating unique indexes described above. It is additive over the Stage 3/4/5 migrations and rewrites no existing rows beyond back-filling the new nullable/defaulted columns.

Recording retention is handled by an explicit storage query rather than by overloading `recordings.user_id`. Add `listProtectedLeaderboardRecordingIds()` (or an equivalent internal retention helper) that returns recording ids referenced by the latest completed run of every viewable iteration (`published` or operator-visible `draft`). The retention sweep exempts that set from the live-session age and quota passes; workflow recordings from superseded runs are outside the set and can be reclaimed.

## Storage interface

Extend the `Storage` interface (`storage/index.ts`) and its Kysely implementation (`storage/kysely.ts`) with domain-shaped methods, never exposing SQL:

- Iterations and sessions: `getIteration(id)` (already added in Stage 5.5), `getOpenIteration(envId)` / `ensureOpenIteration` (Stage 5, unchanged seed primitives except the renamed column), `createIteration(input)` (admin declare: a new `draft`, `closed` iteration with config and `deps_version` defaulted to the current release), `updateIterationConfig(id, config)`, `updateIterationDepsVersion(id, depsVersion)`, `setSubmissionStatus(id, open|closed)` (returns a typed `open_iteration_exists` conflict when opening would violate the one-open invariant), `setVisibility(id, draft|published)` (stamps `published_at` on first publish), `listIterations(envId, { includeDrafts })` (history, newest first; public reads pass `includeDrafts: false`, admin reads pass `true`), `getPublishedIteration(envId)` / `getCurrentIteration(envId)`, and `setSessionIteration(sessionId, iterationId)` or a `createSession` input extension that writes the nullable `iteration_id`.
- Runs and games: `createRun(iterationId, requestedBy)` snapshots the iteration config and deps version into the run row; `setRunStatus(id, status, error?)`, `getLatestRun(iterationId)` and `getLatestCompletedRun(iterationId)`, `createRunGame(...)`, `setRunGameStatus(...)`, `attachRunGameRecording(gameId, recordingId)`, `recordGameResult(...)`, `listRunGames(runId)`, and `listGameResultsByRun(runId)`.
- Placements and boards: `replaceAutomatedPlacements(iterationId, runId, rows)`, `listPlacementsByAgent(agentRef, envId?)`, and `getAutomatedBoard(iterationId)` as a service/storage helper over latest-completed-run results.
- Ratings: `upsertRating(input)` (accepts `AgentRef`, enforces own-agent exclusion for submissions, and uses the unique indexes as an upsert), `getRating(iterationId, raterUserId, agentRef)`, and `listRatingsByIteration(iterationId)` / `aggregateRatingsByAgent(iterationId)` for the human board.
- Rating prompts: `setIterationRatingPrompt(iterationId, prompt)` (the operator's iteration prompt, editable anytime, independent of the `config` immutability rule); `upsertAgentRatingPrompt(iterationId, userId, prompt)` (the author's set/edit, keyed by `(iteration_id, user_id)`), `getAgentRatingPrompt(iterationId, userId)`, and `listAgentRatingPromptsByIteration(iterationId)` so the rating read in step 6 can attach each submitted agent's author prompt. The iteration prompt comes back on `getIteration` as the `rating_prompt` column.
- Retention: `listProtectedLeaderboardRecordingIds()` returns current-run leaderboard recording ids for viewable iterations so the Stage 4 retention sweep can exempt them.

## Operator allowlist seam

The admin API (step 3) gates on operator identity. Add a small `isOperator(identity)` helper alongside the existing identity seam (`backend/src/identity.ts`) backed by deployment config (`backend/src/config.ts`): an `OPERATOR_ALLOWLIST` of handles. In local dev the mock user id is treated as an operator (an empty allowlist in a dev build resolves to "the mock user is operator", so the console works out of the box); in a real deployment the allowlist is the configured operator handles checked against the resolved GitHub identity once OAuth lands. This is the single authorization predicate every admin route and the admin-only iteration reads consult; it does not change the Stage 4 identity resolution itself, only adds the operator predicate over it.

## Tests

Vitest against the real Kysely implementation on better-sqlite3 `:memory:`, no Docker:

- The migration renames `status` to `submission_status`, recreates the one-open partial unique index on the renamed column, adds the new iteration/session columns with defaults, creates the six new tables and the indexes; a second `Migrator` run is a no-op; an already-seeded Stage 5 iteration survives as a `draft` with `submission_status: open` and an empty match design.
- `createIteration` writes a `draft`, `closed` iteration with the current `deps_version` and a validated config; `updateIterationConfig` round-trips the `IterationConfig` codec and rejects an unknown key / malformed match design.
- `setSubmissionStatus` and `setVisibility` flip the axes independently; opening an iteration while another environment iteration is open returns `open_iteration_exists`; `setVisibility('published')` stamps `published_at` once and leaves it stable on a re-publish; `getPublishedIteration` ignores drafts and `listIterations({ includeDrafts: false })` hides them while the admin variant shows them.
- `createSession` or `setSessionIteration` records a nullable `iteration_id`; new sessions attach to the current open iteration, while old null rows cannot be rated.
- `createRun` snapshots config/deps/requested_by; `createRunGame` stores deterministic `game_index` and resolved `AgentRef` slots; `recordGameResult` round-trips the concrete agent columns and `mean_agent_compute_ms`; `getLatestCompletedRun` returns the most recent `completed` run and ignores a later `running`/`failed` one, which is what the board reads so a failed re-run does not blank a good board.
- `attachRunGameRecording` links a game to a Stage 4 recording so the board row can deep-link a replay.
- `replaceAutomatedPlacements` rewrites placement rows for a completed re-run and supports both submitted agents and the Naive baseline.
- `upsertRating` inserts a 1-5 rating for a submitted agent or the Naive baseline, a second rating by the same user for the same agent overwrites rather than duplicating, a rating of the user's own submitted agent is rejected, Naive is rateable, and `aggregateRatingsByAgent` returns mean and count per agent ref.
- `setIterationRatingPrompt` sets and clears the operator's `rating_prompt` and remains editable after a run exists (unlike `updateIterationConfig`); `upsertAgentRatingPrompt` inserts then overwrites an author's prompt keyed by `(iteration_id, user_id)`, survives a simulated resubmission (a new `agent_submission_id` for the same user still resolves the same prompt), and `listAgentRatingPromptsByIteration` returns one prompt per author.
- `listProtectedLeaderboardRecordingIds` exempts only current-run recordings for viewable iterations and excludes superseded-run recordings.
- `isOperator` resolves the dev mock user as operator and honors a configured allowlist.

## Done when

The backend boots against an existing Stage 5 database, runs the new migration without losing the seeded iteration, and exposes the extended storage surface. The storage suite proves the config codec, the one-open submission invariant, the two-axis lifecycle, run snapshots, session iteration attribution, latest-completed-run selection, placement rewrites, rating upsert/own-agent/Naive rules, both rating prompts (the operator's stays editable after a run, the author's survives resubmission), leaderboard-recording retention protection, and the operator predicate on `:memory:`. No route, Docker, harness, or frontend work is required for this slice; it is the seam steps 2-7 are written against.
