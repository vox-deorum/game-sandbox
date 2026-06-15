# Stage 6.1: Iteration Config, Visibility, and Storage

Status: not started.

Part of [Stage 6](../stage-06-leaderboards.md). This is build-order step 1 and the data foundation the rest of the stage attaches to: it grows the minimal Stage 5 `iterations` record into full per-iteration configuration, adds the lifecycle and visibility axes, the run/board/rating tables, their migration and storage methods, and the operator-allowlist seam the admin API gates on. Entirely Docker-free.

## What Stage 5 already built

[Stage 5.1](../stage-05/1-storage-and-iteration-seed.md) created `iterations` (`id`, `env_id`, `deps_version`, `status` = `open`|`closed`, `created_at`) seeded one-per-environment at startup, plus `submissions`, `submission_checks`, and `session_submissions`. It deliberately kept the iteration columns small so this stage extends rather than rewrites. This step keeps the seed working (a seeded iteration is a `draft`, submissions `open`, with an empty default match design) and adds everything Stage 6 needs around it.

## Schema

All tables live in the single Kysely schema (`backend/src/storage/schema.ts`), the one source of truth from [stage-03/backend-skeleton-and-storage.md](../stage-03/backend-skeleton-and-storage.md); nothing declares tables or queries outside `storage/`. Add the string-literal unions and table interfaces, register them on the `Database` interface, and derive domain types (`Iteration = Selectable<IterationsTable>`, etc., with `Insertable`/`Updateable` where an operation needs them).

### `iterations` — extended

Keep the Stage 5 columns; rename and add for the two-axis lifecycle and the configuration. The submission window and the visibility are independent, so model them as two columns rather than overloading one `status`:

- `submission_status` (`open`|`closed`) — the Stage 5 `status` renamed for clarity; controls whether the submission form accepts agents. The migration renames the existing column.
- `visibility` (`draft`|`published`) — operator-only until published, then visible on the environment page and in history. Seeded iterations start `draft`.
- `label` (text, nullable) — an operator-facing name for the iteration ("Week 3", "Final round"); the admin console and history list show it.
- `deps_version` (unchanged) — the pinned template dependency-set version, defaulting to the latest template release at declaration (the current `DEPS_VERSION`), per [submission.md](../../docs/specs/submission.md).
- `config` (text, JSON) — the structured iteration configuration (below), stored as one validated JSON document rather than spread across columns, because it is a nested, evolving shape (match design, override blocks) that is read and written whole by the admin API and the workflow, never queried by field. A typed `IterationConfig` codec (parse + serialize, rejecting unknown keys) is the single gate; the column never holds unvalidated text.
- `created_at` (unchanged), `published_at` (nullable, stamped on first publish for history ordering).

Decision recorded here: `config` is a JSON document, not normalized into `match_configurations`/`overrides` tables. The match design is small (a handful of slot compositions), authored and read as a unit, and has no row-level query needs; a JSON column keeps the schema flat and lets the shape evolve (messaging/LLM overrides land inert now, activate in Stages 8/9) without a migration per field. The run results below _are_ normalized, because those are queried per-agent for the board.

`IterationConfig` shape (the typed codec, documented here so the admin API in step 3 and the scheduler in step 2 share one definition):

- `matches`: a list of match configurations. Each has `slots` (an ordered list of seat specs, each `builtin-naive` or `submission`), `seeds` (a list of integers passed to both env and agents), and `games` (the per-configuration game count the scheduler uses, see step 2). For Flappy Bird a single match with one `submission` slot is the norm; multi-slot compositions (`[naive, naive, naive, submission]`) are valid and forward-compatible with Stage 7 opponents.
- `overrides`: an optional block — `step_timeout_ms`, `episode_timeout_ms` (effective this stage, fall back to environment defaults from [environment.md](../../docs/specs/environment.md) when absent), and the parsed-but-inert `messaging` (length cap / disable) and `llm` (model allowlist, token/call/rate budgets) blocks the codec validates and stores so the format is stable before Stages 8/9 consume them.

### `iteration_runs` — one workflow execution

The automated workflow can run more than once per iteration (the re-run requirement), and each run replaces the iteration's board. Model the run explicitly so a re-run is a new run row and the board always points at the latest completed one:

`iteration_runs`: `id` (text, backend-generated), `iteration_id`, `status` (`RunStatus`: `pending`, `running`, `completed`, `failed`, `cancelled`), `started_at`, `ended_at` (null while running), `error` (nullable text for a run-level failure). The admin status view and log stream key off this row.

### `iteration_run_games` — one scheduled match

`iteration_run_games`: `id`, `run_id`, `match_index` (which `config.matches` entry produced it), `seed`, `slots` (JSON: the resolved seat assignment — which submission id / `builtin-naive` fills each seat), `status` (`GameStatus`: `pending`, `running`, `completed`, `failed`, `timed_out`), `recording_id` (nullable FK into the Stage 4 recordings, set when the run records; this is the per-row replay link the board exposes), `started_at`, `ended_at`, `error`. The workflow (step 4) writes these; the board (step 5) aggregates them.

### `game_results` — per-slot outcome of a game

Normalized so the board can aggregate per agent: `game_results`: `id`, `game_id` (FK `iteration_run_games`), `slot_index`, `agent_ref` (JSON or two columns: `kind` = `builtin-naive`|`submission` plus `submission_id`/`user_id` for submissions, `null` for Naive — the identity the board groups by), `episode_score` (the normalized higher-is-better leaderboard score from the recording), `mean_decision_ms` (aggregated per-agent `decision_ms` for this game), `failed` (boolean: the agent crashed or timed out, recorded as that agent's result per the scope). One row per participating seat per game.

### `ratings`

`ratings`: `id`, `iteration_id`, `env_id` (denormalized for lookups), `rater_user_id` (the resolved identity from the Stage 4 seam), `agent_submission_id` (the rated agent's active submission in this iteration; ratings target a submission so the human board groups the same way the automated board does), `agent_owner_id` (denormalized so the own-agent exclusion is a column compare, not a join), `score` (integer 1–5), `created_at`, `updated_at`. A unique index on `(iteration_id, rater_user_id, agent_submission_id)` enforces one effective rating per user per agent per iteration; re-rating is an upsert that overwrites `score`/`updated_at`. Ratings of the user's own agent (`rater_user_id == agent_owner_id`) are rejected at the storage/route layer and never inserted.

## Migration

One new ordered TypeScript migration module under the storage package, run on startup through Kysely's `Migrator` exactly as the earlier stages established (no migration CLI; deployment is "start the process"). It: renames `iterations.status` to `submission_status`; adds `visibility`, `label`, `config`, `published_at` to `iterations` (with `visibility` defaulting `draft`, `config` defaulting an empty-matches document for already-seeded rows); creates `iteration_runs`, `iteration_run_games`, `game_results`, and `ratings`; and adds the indexes the hot reads need: `iteration_runs(iteration_id)`, `iteration_run_games(run_id)`, `game_results(game_id)`, `game_results(agent_submission_id)` for per-agent board aggregation, `ratings(iteration_id, agent_submission_id)` for the human board, and the unique `ratings(iteration_id, rater_user_id, agent_submission_id)`. It is additive over the Stage 3/4/5 migrations and rewrites no existing rows beyond back-filling the new iteration columns with defaults.

## Storage interface

Extend the `Storage` interface (`storage/index.ts`) and its Kysely implementation (`storage/kysely.ts`) with domain-shaped methods, never exposing SQL:

- Iterations: `getIteration(id)` (already added in Stage 5.5), `getOpenIteration(envId)` / `ensureOpenIteration` (Stage 5, unchanged seed primitives — the seed now writes a `draft` iteration with an empty match design), `createIteration(input)` (the admin declare in step 3: a new `draft` iteration with config and `deps_version` defaulted to the current release), `updateIterationConfig(id, config)`, `setSubmissionStatus(id, open|closed)`, `setVisibility(id, draft|published)` (stamps `published_at` on first publish), `listIterations(envId, { includeDrafts })` (history, newest first; the public reads pass `includeDrafts: false`, the admin reads pass `true`), and `getPublishedIteration(envId)` / `getCurrentIteration(envId)` (the iteration the public Leaderboards view shows).
- Runs and games: `createRun(iterationId)`, `setRunStatus(id, status, error?)`, `getLatestRun(iterationId)` and `getLatestCompletedRun(iterationId)` (the board reads the latest completed), `createRunGame(...)`, `setRunGameStatus(...)`, `attachRunGameRecording(gameId, recordingId)`, `recordGameResult(...)`, `listRunGames(runId)`, and `listGameResultsByRun(runId)` (the board aggregation input).
- Ratings: `upsertRating(input)` (enforces own-agent exclusion and the unique constraint as an upsert), `getRating(iterationId, raterUserId, agentSubmissionId)`, and `listRatingsByIteration(iterationId)` / `aggregateRatingsByAgent(iterationId)` for the human board.

## Operator allowlist seam

The admin API (step 3) gates on operator identity. Add a small `isOperator(identity)` helper alongside the existing identity seam (`backend/src/identity.ts`) backed by deployment config (`backend/src/config.ts`): an `OPERATOR_ALLOWLIST` of handles. In local dev the mock user id is treated as an operator (an empty allowlist in a dev build resolves to "the mock user is operator", so the console works out of the box); in a real deployment the allowlist is the configured operator handles checked against the resolved GitHub identity once OAuth lands. This is the single authorization predicate every admin route and the admin-only iteration reads consult; it does not change the Stage 4 identity resolution itself, only adds the operator predicate over it.

## Tests

Vitest against the real Kysely implementation on better-sqlite3 `:memory:`, no Docker:

- The migration renames `status`→`submission_status`, adds the new iteration columns with defaults, creates the four new tables and the indexes; a second `Migrator` run is a no-op; an already-seeded Stage 5 iteration survives the migration as a `draft` with `submission_status: open` and an empty match design.
- `createIteration` writes a `draft` iteration with the current `deps_version` and a validated config; `updateIterationConfig` round-trips the `IterationConfig` codec and rejects an unknown key / malformed match design.
- `setSubmissionStatus` and `setVisibility` flip the axes independently; `setVisibility('published')` stamps `published_at` once and leaves it stable on a re-publish; `getPublishedIteration` ignores drafts and `listIterations({ includeDrafts: false })` hides them while the admin variant shows them.
- `createRun`/`createRunGame`/`recordGameResult` round-trip; `getLatestCompletedRun` returns the most recent `completed` run and ignores a later `running`/`failed` one, which is what the board reads so a failed re-run does not blank a good board.
- `attachRunGameRecording` links a game to a Stage 4 recording so the board row can deep-link a replay.
- `upsertRating` inserts a 1–5 rating, a second rating by the same user for the same agent overwrites rather than duplicating, a rating of the user's own agent is rejected, and `aggregateRatingsByAgent` returns mean and count per agent.
- `isOperator` resolves the dev mock user as operator and honors a configured allowlist.

## Done when

The backend boots against an existing Stage 5 database, runs the new migration without losing the seeded iteration, and exposes the extended storage surface. The storage suite proves the config codec, the two-axis lifecycle, latest-completed-run selection, the rating upsert/own-agent rules, and the operator predicate on `:memory:`. No route, Docker, harness, or frontend work is required for this slice; it is the seam steps 2–7 are written against. </content>
