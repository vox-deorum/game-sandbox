# Backend

The backend is the Node and TypeScript service that runs outside session containers. It serves the HTTP API and built frontend, handles authentication and authorization, stores relational data, supervises sessions and leaderboard workflows, and relays WebSocket traffic.

It never steps an environment or runs participant Python. The session container is authoritative for game state.

Read [the execution boundary](execution.md) for drivers and session transport, [the backend-facing specifications](../../specs/execution.md) for architectural rules, and [Testing](../testing/index.md) for the verification matrix.

## Run and test

Run these commands from `backend/` unless noted:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start `tsx watch` |
| `npm run start` | Start once without watch mode |
| `npm run build:image` | Build the current session base image if its inputs changed; `npm run build:image -- --force` rebuilds unconditionally (in PowerShell use `npm.cmd`, whose wrapper otherwise strips the `--`) |
| `npm test` | Run Docker-free unit tests |
| `npm run test:integration` | Run real-container integration tests |
| `npm run demo` | From the repository root, launch the app with the populated e2e fixture and print sign-ins for the admin and an ordinary member (`ada-lovelace`) |
| `npm run demo -- --rerun-e2e` | From the repository root, run the same demo after rebuilding the fixture without the slow E2E arcs |

Starting the backend requires Docker because it reaps managed containers during startup. Unit tests use an in-memory SQLite database and fake driver.

Tests under `test/` mirror the source domains. Shared doubles and fixtures live under `test/support/` and `test/fixtures/`. Docker-gated tests live under `test/integration/`.

## Request flow

```text
Browser
  ├─ HTTP → Fastify routes → storage / services
  └─ WebSocket → session relay → execution driver → container
```

## Package map

`backend/` is the private `@game-sandbox/backend` npm workspace. It runs from TypeScript source through `tsx`.

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | Load configuration, open storage, reconcile work, assemble services, listen, handle signals |
| `src/app.ts` | Fastify composition root: register routes and plugins, then install the static frontend fallback |
| `src/<domain>/routes.ts` | Register one domain's HTTP routes through a `register<Domain>Routes(app, deps)` function |
| `src/config/config.ts` | Parse environment variables into one typed `Config` |
| `src/auth/` | Better Auth wiring, GitHub account linking, public attribution reads |
| `src/auth/identity.ts` | Resolve the authenticated Better Auth session, derive status, and expose the guard trio (`requireUser`/`requireActive`/`requireAdmin`) |
| `src/environments/registry.ts` | Load generated environment metadata |
| `src/environments/generated/environments.json` | Generated public environment metadata |
| `src/storage/` | Kysely schema, domain interface, SQLite implementation, migration |
| `src/driver/` | Execution-driver interface and Docker implementation |
| `src/session/` | Orchestrator, live relay, active-session registry |
| `src/submission/` | Source resolution, validation, image build, worker, snapshots, eviction |
| `src/admin/` | Operator-only season and workflow API |
| `src/leaderboards/` | Public season and leaderboard reads |
| `src/ratings/` | Session ratings and author prompts |
| `src/llm/` | OpenAI-compatible proxy, scoped grants, admission, retries, token estimation, and scope availability |
| `src/storage/llm/` | Execution-scoped successful-call telemetry and development ledgers |
| `src/workflow/` | Workflow runner interface, events, and recovery |
| `src/recordings/store.ts` | Recording reads and deletion |
| `src/recordings/retention.ts` | Recording metadata, pinning, and eviction |
| `src/build/deps-version.ts` | Supported template dependency and base-image registry |

Shared protocol and environment types live in `@game-sandbox/schema`. Browser-safe subpath exports avoid pulling Node-only recording readers into the frontend bundle.

## Configuration

The required `.env.default` at the repository root defines all concrete runtime defaults. `config/config.ts` loads it once, applies an optional `.env` and parent-process overrides, and validates the complete environment without duplicating defaults in code. A launcher that must not see a machine-local `.env` (the browser e2e suite, which boots its own backend) sets `LOAD_LOCAL_ENV=false` in the process environment, skipping that file so a deployment's `.env` left in the tree cannot leak in. Each service receives `Config` or the part it needs through its constructor. Feature modules must not read process environment variables directly. Dedicated parsers and Zod schemas validate environment variables, manifests, and season configuration.

See [Configuration](../setup/configuration.md) for the full environment-variable reference and deployment notes.

## LLM proxy

The backend exposes an OpenAI-compatible proxy when the deployment configures an upstream and at least one public model tier. It authenticates scoped development or official-session grants, enforces the configured policy, retries eligible upstream failures, and records each successful call before replying.

Official sessions reach the proxy only through their isolated relay network. The harness reads the internal timing endpoint around an agent hook so verified proxy time is excluded from the hook budget. Development keys and usage belong to an active participant in an open, LLM-enabled season.

The preflight prevents two concurrent requests from double-spending the same budget, and every failure mode favors undercounting usage over overcharging. The durable telemetry store retains public usage metadata and costs. Each official scope and development ledger performs a transactional write/readback preflight before every provider admission, including when reusing an existing handle.

Request and completion bodies are available only to an operator or the owner of the controlling submission. Product behavior, accounting guarantees, and error codes are defined in the [LLM specification](../../specs/llm.md). See [Configuration](../setup/configuration.md#llm-proxy) for deployment settings and the [LLM source](https://github.com/vox-deorum/game-sandbox/tree/main/backend/src/llm) for the implementation.

### Failure handling

| Failure point | Result |
| --- | --- |
| Pre-upstream failure | Rejects the current request; the next request retries |
| Durable-record failure after provider success | Only that accounting scope is unavailable until the backend restarts |
| Completion-normalization or usage-resolution failure | Releases reservations, leaves the scope available, and logs the unaccounted provider spend |

## Static frontend

When `FRONTEND_DIST` exists, the backend serves it through `@fastify/static`.

- Root `npm start` builds `frontend/dist/` first.
- Non-API GET 404s return `index.html` for client-side routing.
- `/api` routes keep JSON 404 responses.
- When `GOOGLE_ANALYTICS_ID` is configured, the served `index.html` includes the gtag.js loader; the snippet is injected once at startup, so enabling analytics needs no frontend rebuild.
- Vite development and tests without a built bundle are unchanged.

## Storage

The `Storage` interface organizes relational data by product domain. Kysely and better-sqlite3 provide its implementation. [Data folders](../data/folders.md) describes the local runtime layout.

Callers use methods such as `createSession`, `markEnded`, `createSubmission`, and `getHumanBoard`. They do not issue SQL.

| File or directory          | Role                              |
| -------------------------- | --------------------------------- |
| `storage/schema.ts`        | Database and row type declaration |
| `storage/migrations.ts`    | Current initial migration         |
| `storage/season-config.ts` | Strict season configuration codec |
| `storage/kysely/index.ts`  | `KyselyStorage` facade            |
| `storage/kysely/*.ts`      | Domain query modules              |

Migration history remains flat while there is no deployed data to preserve. For a schema change, update `storage/schema.ts`, `0001_initial_schema` in `storage/migrations.ts`, and affected `storage/kysely/` modules, then recreate local `sandbox.db` and run related tests. In-memory tests use the latest shape.

### Main table groups

| Group | Tables | Purpose |
| --- | --- | --- |
| Sessions and recordings | `sessions`, recording metadata | Session lifecycle, replay attribution, retention |
| Submissions | `submissions`, `submission_checks`, `session_submissions` | Pinned source, validation timeline, session attribution |
| Seasons and runs | `seasons`, `season_runs`, `season_run_games` | Public gates, frozen run snapshot, schedule |
| Results | `game_results`, `automated_placements` | Per-seat outcomes and published automated board |
| Feedback | `ratings`, `agent_rating_prompts` | Effective ratings with their required written comment, and author guidance |

Important invariants are enforced in storage:

- One submission-open season per environment.
- One play-open season per environment.
- One active submission per user and season.
- One effective rating per user, agent, and season.
- Every rating carries a required written comment, trimmed and capped at 1,000 Unicode code points.
- Reruns preserve the latest completed board until a newer run completes.

Season configuration is one strict JSON document because it is authored and frozen as a unit. Run results are normalized because leaderboards aggregate them by agent.

## Recording retention

A recording directory holds the JSONL. Its database row stores retention metadata.

The sweep runs at startup, on its interval, after session finalization, and after workflow-run completion:

1. Protect recordings used by the latest completed leaderboard runs and exclude them from the age and quota passes.
2. Delete unpinned recordings older than the retention window.
3. For each user over quota, delete oldest unpinned recordings until within quota.

Among the remaining live-session recordings, pinned recordings count toward quota but are never evicted. A user at the pinned cap receives `409 pinned_quota`.

Deletion tolerates a missing row or directory so an interrupted sweep can recover on its next pass.

## Identity and authorization

See [the identity specification](../../specs/identity.md) for the product rules this section implements.

Identity comes from a Better Auth session cookie. `createRequestIdentity(auth)` in `auth/identity.ts` resolves it and caches the result for the request, so a route that both checks access and personalizes its response performs only one session lookup.

`deriveStatus(role)` splits the Better Auth `role` on commas and maps it to `pending`, `normal`, or `admin`. Admin takes precedence over user, and user takes precedence over pending. An unknown, empty, or missing role becomes `pending`, so access fails closed.

Every route states its requirement against the guard trio:

- `requireUser`: Any signed-in user; returns `401 auth_required` for an anonymous request.
- `requireActive`: An active (`normal` or `admin`) user; returns `403 not_active` for a pending user.
- `requireAdmin`: An `admin` user; returns `403 not_operator` otherwise. The `/api/admin` plugin uses the same code through one `onRequest` guard backed by `status === 'admin'`.

Public reads stay open to anonymous visitors.

| Requirement | Applies to |
| --- | --- |
| Public (no guard) | Environment metadata, public config, public season and leaderboard reads |
| `requireUser` | Owner-scoped reads and pins |
| `requireActive` | Session start, submit, rate, and author-prompt writes |
| `requireAdmin` | `/api/admin/*`, unreleased seasons, and admin downloads |

`GET /api/me` returns `{ user: { id, name, email, image, github_username, status } | null }`. The GitHub username is nullable and is read-only to every client.

Cookies ride HTTP fetches, WebSocket upgrades, and native download navigations on the same origin, so no route needs a header or query-parameter fallback for identity.

### GitHub account linking

`auth/auth.ts` configures Better Auth for GitHub linking.

Database constraints keep each GitHub identity and account email owned by one user. The account hooks maintain the server-owned `githubUsername` field on GitHub links and sign-ins, and a database trigger clears it on unlink. See the [authentication source](https://github.com/vox-deorum/game-sandbox/tree/main/backend/src/auth) for implementation details.

`auth/users.ts` resolves public attribution from the Better Auth-owned `user` table. `namesFor(ids)` is the low-cost name-only batch read used across sessions, recordings, workflows, and leaderboards. `profilesFor(ids)` adds the optional GitHub username and is used only by the agent-profile response, so blind-rating and recording payloads never gain the handle.

## Environment metadata

The canonical registry lives in Python. `scripts/generate.py` writes committed `src/environments/generated/environments.json`, and the generated-code check prevents drift.

`environments/registry.ts` parses the generated metadata file once through the shared `EnvironmentMeta` guard. The API serves the metadata, and the orchestrator reads layout, player, pace, and timeout settings from the same object.

## Season seeding

At startup the backend runs `src/seasons/seed.ts`, which defines what a fresh deployment starts with. It ensures one submission- and play-open, unreleased "Playground" season per registered environment at the current dependency-set version. An environment whose metadata declares presets then also receives one hidden template season per preset, each submission-closed, play-closed, and unreleased, with the preset title as its label, the preset's parameter and (when flagged) LLM overrides folded into its config, and a description naming the settings it stands up. The Playground season gets a description naming the opening settings when a preset describes those defaults.

The seed writes a `template_source` provenance marker onto the rows it creates (`'playground'`, or a namespaced `template:<preset name>` for a template) and leaves operator-declared seasons unmarked. It is idempotent across restarts, and it stays off operator work: template creates happen only while an environment shows no operator configuration (an unmarked season, match design on any season, a released season, any runs or submissions, or overrides on the Playground row), and a present template is re-labelled or re-configured only while it is still exactly what the seed wrote (both gates closed, unreleased, and still carrying the seed-written description). Once a template goes live (a gate opens) or an operator owns its description, the seed leaves the row alone even when the preset's title or values change. The template arc is "planted" once complete; after that a missing template means an operator deleted it and stays gone. A deployment update clears the planted marker (the `templates_planted` flag in `season_seed_flags`), so the next release's arc is planted and a preset added in a later release reaches the deployment. An interrupted first batch is completed on the next boot, and a re-labelled or value-changed preset reaches a still-seed-owned template instead of duplicating it. On a fresh install the templates are inserted newest-first so the listing reads Playground, then the arc in declaration order. The Playground description lands on the row carrying the `'playground'` marker, never on whatever season is merely submission-open.

## Submission pipeline

```text
HTTP request → pending row → resolve → static → build → load → ready
```

The route returns after enqueueing. `submission/worker.ts` processes one submission at a time and records each stage before updating the rollup status. The [submission specification](../../specs/submission.md) owns the product rules (flow, validation layers, size cap, snapshots).

### Sources

`SubmissionSource` provides:

- `verifyReachable`
- `resolve`
- `fetchTree`

The Git source accepts a default-branch head, branch, tag, or 40-character commit. It runs non-interactively under a timeout and maps failures to stable reason codes.

The local-folder source is trusted development input and is available only when explicitly enabled. Its handle never deletes the developer's folder.

Git implementation details stay under `submission/source/`. Raw `child_process` use remains banned.

### Static validation

Static validation runs no participant code. It checks:

| Code                        | Condition                             |
| --------------------------- | ------------------------------------- |
| (size)                      | Source tree exceeds the size cap      |
| `manifest_missing`          | No root `manifest.json`               |
| `manifest_invalid_json`     | Invalid JSON or non-object            |
| `manifest_field_invalid`    | Missing or wrong-typed required field |
| `manifest_unknown_key`      | Extra manifest field                  |
| `entry_point_missing`       | Module file or package is absent      |
| `unknown_template_version`  | No registered base image              |
| `template_version_mismatch` | Version differs from the season       |

The size check runs first. It measures the checked-out tree through one shared filter (`submission/tree-filter.ts`) that excludes `.git` and build artifacts, then compares the result with the effective cap defined by [maximum submission size](../../specs/submission.md#maximum-submission-size). The same filter drives the snapshot pack and overlay image build context, so all three agree on which bytes are "the submission".

The Zod manifest schema and Python harness loader are kept in sync by contract tests.

### Worker recovery

For each stage, the worker:

1. Writes a running check.
2. Runs the stage.
3. Closes the check as passed or failed.
4. Updates the submission rollup.

Unexpected errors still close the active stage. Startup re-enqueues pending submissions, and the unique `(submission_id, stage)` key replaces prior attempts.

Overlay image building and load checking are described in [Execution boundary](execution.md#submission-overlay-images).

### Snapshots

Once a submission passes the size and static checks, the worker uses `SubmissionSnapshotStore` (`submission/snapshot-store.ts`) to write a compressed snapshot of its filtered source tree. Each submission has one `<id>.tar.gz` under `<DATA_DIR>/submissions`. The store mirrors `RecordingsStore`: a flat per-id file, an atomic write (temp file then rename), and `stream`, `exists`, `materialize`, and `delete`. A failed snapshot write fails the static stage and prevents `ready`. The worker attempts to remove any stale archive, but logs and continues if deletion fails.

When a cached overlay image has been evicted, `ensureSubmissionImage` materializes the tree from the snapshot (falling back to the source seam only for a pre-snapshot submission). The shared filter plus a deterministic sort make the rebuild reproduce the original overlay image. Operator download routes stream the same snapshots. A forced `deps_version` change that deletes a season's submissions also reclaims them. [Snapshots and downloads](../../specs/submission.md#snapshots-and-downloads) states the product rules.

## HTTP API

Routes live under `/api`. Request bodies use Fastify JSON-schema validation, and expected refusals carry stable `code` values.

### Selected public and participant endpoints

| Prefix or route | Responsibility |
| --- | --- |
| `/api/environments` | Environment metadata |
| `/api/config` | Public deployment branding (the site name) |
| `/api/me` | Resolved user and capabilities |
| `/api/sessions` | Start, read, stop, and attach to sessions |
| `/api/recordings` | List, stream, pin, and unpin recordings |
| `/api/submissions` | Capabilities, reachability, submit, poll, history |
| `/api/environments/:envId/agents` | Agent profiles and placements |
| `/api/environments/:envId/agents/:ownerId/feedback` | Agent owner's anonymous peer feedback |
| `/api/seasons` | Public season index |
| `/api/environments/:envId/leaderboards` | Current and historical released boards |
| `/api/sessions/:sessionId/ratings` | Read and write session ratings |
| `/api/seasons/:seasonId/agent-rating-prompt` | Author prompt |
| `/api/admin/seasons/:id/ratings` | Season peer ratings grouped by agent and rater |
| `/api/llm-development/seasons` and `/api/seasons/:seasonId/llm-development*` | Development-key eligibility, usage, call history, and key rotation |
| `/api/llm/v1/chat/completions` | OpenAI-compatible development completion endpoint |
| `/api/recordings/:id/llm` | Official recording LLM usage and authorized call bodies |

The server derives user identity. Request bodies never choose the submitter, recording owner, or rater.

### Operator API

All `/api/admin` routes pass one operator guard. They support:

- Declaring seasons.
- Replacing validated configuration.
- Setting the season rating prompt.
- Reading a season's peer ratings (written comments) grouped by agent and by rater.
- Opening and closing submission and play windows.
- Releasing and unreleasing results.
- Triggering and cancelling runs.
- Reading private season, run, board, and match status.
- Listing a season's active submissions, and downloading one submission's source snapshot or a whole season as one `.tar.gz`.
- Streaming workflow logs over WebSocket.

Unreleased board data is available only through operator-gated routes. Public board endpoints enforce release at the route boundary.

## Ratings

The recording header's `players` map is the authority for which agents took part. The backend resolves submission ownership from storage and ignores human entries.

Rating writes validate the full batch before saving anything and reject any batch that breaks the [leaderboard specification's](../../specs/leaderboard.md) rating rules: score range, session membership, self-rating, unfinished or unattributed sessions, and a closed play window. Each rating also carries a required written comment, validated with the shared `codePointLength` helper: it is trimmed, blank-after-trim is refused (`empty_feedback`), and a comment over 1,000 code points is refused (`feedback_too_long`).

Rerating upserts both the score and the comment. The rating read returns the caller's prior score and comment so the panel prefills, and closed play returns a read-only view with prior ratings and prompts.

Two read surfaces expose the comments beyond the rater's own prior comment on the rating read. `GET /api/environments/:envId/agents/:ownerId/feedback` serves an agent owner the comments their agent received, anonymized so no rater identity leaves the server and gated to the owner and to released seasons. `GET /api/admin/seasons/:id/ratings` serves an operator the whole season's comments grouped by rated agent and by rater, with rater names and zero-count participants included.

## Workflow runner

A workflow run is an automated batch of matches scheduled between submitted agents when an operator triggers a season's leaderboard update.

Triggering a leaderboard run returns without waiting for Docker. Scheduling, forfeit, and release rules live in the [leaderboard specification](../../specs/leaderboard.md).

The trigger:

1. Freezes configuration, dependency version, and eligible roster.
2. Persists the balanced schedule and pending run.
3. Enqueues the run ID on `WorkflowRunner`.

`WorkflowRunner` exposes `enqueue`, `cancel`, and `subscribe` over a small event union. Startup reconciliation marks interrupted pending or running workflows failed rather than silently resuming a partial run.
