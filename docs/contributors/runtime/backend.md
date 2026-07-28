# Backend

The backend is the Node and TypeScript service that runs outside session containers. It serves the HTTP API and built frontend, handles authentication and authorization, stores relational data, supervises sessions and leaderboard workflows, and relays WebSocket traffic.

It never steps an environment or runs participant Python. The session container is authoritative for game state.

Read [the execution boundary](execution.md) for drivers and session transport, [the backend-facing specifications](../../specs/execution.md) for architectural rules, and [Testing](../testing/index.md) for the verification matrix.

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
| `src/app.ts` | Fastify application, HTTP routes, WebSocket endpoints, static frontend |
| `src/config.ts` | Parse environment variables into one typed `Config` |
| `src/identity.ts` | Resolve the authenticated session, derive status, and expose the guard trio (`requireUser`/`requireActive`/`requireAdmin`) |
| `src/auth/` | Better Auth wiring, GitHub account linking, public attribution reads |
| `src/environments.ts` | Load generated environment metadata |
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
| `src/recordings.ts` | Recording reads and deletion |
| `src/retention.ts` | Recording metadata, pinning, and eviction |
| `src/deps-version.ts` | Supported template dependency and base-image registry |

Shared protocol and environment types live in `@game-sandbox/schema`. Browser-safe subpath exports avoid pulling Node-only recording readers into the frontend bundle.

## Run and test

Run these commands from `backend/` unless noted:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start `tsx watch` |
| `npm run start` | Start once without watch mode |
| `npm run build:image` | Rebuild the current session base image |
| `npm test` | Run Docker-free unit tests |
| `npm run test:integration` | Run real-container integration tests |
| `npm run demo` | From the repository root, launch the app with populated e2e data; prints both the admin and an ordinary-member (`ada-lovelace`) sign-in |
| `npm run demo -- --rerun-e2e` | From the repository root, run the same demo after discarding and rebuilding the fixture |

Starting the backend requires Docker because it reaps managed containers during startup. Unit tests use an in-memory SQLite database and fake driver.

Tests mirror source domains under `test/`. Shared doubles and fixtures live under `test/support/` and `test/fixtures/`; Docker-gated tests live under `test/integration/`.

## Configuration

The required `.env.default` at the repository root defines all concrete runtime defaults. `config.ts` loads it once, applies an optional `.env` and parent-process overrides, then validates the complete environment without duplicating defaults in code. Each service receives either `Config` or the part it needs through its constructor. Feature modules must not read process environment variables directly. Dedicated parsers and Zod schemas validate environment variables, manifests, and season configuration.

See [Configuration](../setup/configuration.md) for the full environment-variable reference and deployment notes.

## LLM proxy

The backend exposes an OpenAI-compatible proxy when the deployment configures an upstream and at least one public model tier. It authenticates scoped development or official-session grants, enforces the configured policy, retries eligible upstream failures, and records each successful call before replying.

Official sessions reach the proxy only through their isolated relay network. The harness reads the internal timing endpoint around an agent hook so verified proxy time is excluded from the hook budget. Development keys and usage belong to an active participant in an open, LLM-enabled season.

The durable telemetry store retains public usage metadata and costs. Request and completion bodies are available only to an operator or the owner of the controlling submission. Product behavior, accounting guarantees, and error codes are defined in the [LLM specification](../../specs/llm.md). See [Configuration](../setup/configuration.md#llm-proxy) for deployment settings and the [LLM source](https://github.com/vox-deorum/game-sandbox/tree/main/backend/src/llm) for the implementation.

## Static frontend

When `FRONTEND_DIST` exists, the backend serves it through `@fastify/static`.

- Root `npm start` builds `frontend/dist/` first.
- Non-API GET 404s return `index.html` for client-side routing.
- `/api` routes keep JSON 404 responses.
- Vite development and tests without a built bundle are unchanged.

## Storage

The `Storage` interface organizes relational data by product domain. Kysely and better-sqlite3 provide its implementation.

Callers use methods such as `createSession`, `markEnded`, `createSubmission`, and `getHumanBoard`. They do not issue SQL.

| File or directory          | Role                              |
| -------------------------- | --------------------------------- |
| `storage/schema.ts`        | Database and row type declaration |
| `storage/migrations.ts`    | Current initial migration         |
| `storage/season-config.ts` | Strict season configuration codec |
| `storage/kysely/index.ts`  | `KyselyStorage` facade            |
| `storage/kysely/*.ts`      | Domain query modules              |

Migration history remains flat while there is no deployed data to preserve. Update `0001_initial_schema`, then recreate the local `sandbox.db`. In-memory tests always use the latest shape.

### Main table groups

| Group | Tables | Purpose |
| --- | --- | --- |
| Sessions and recordings | `sessions`, recording metadata | Session lifecycle, replay attribution, retention |
| Submissions | `submissions`, `submission_checks`, `session_submissions` | Pinned source, validation timeline, session attribution |
| Seasons and runs | `seasons`, `season_runs`, `season_run_games` | Public gates, frozen run snapshot, schedule |
| Results | `game_results`, `automated_placements` | Per-seat outcomes and published automated board |
| Feedback | `ratings`, `agent_rating_prompts` | Effective ratings and author guidance |

Important invariants are enforced in storage:

- One submission-open season per environment.
- One play-open season per environment.
- One active submission per user and season.
- One effective rating per user, agent, and season.
- Reruns preserve the latest completed board until a newer run completes.

Season configuration is one strict JSON document because it is authored and frozen as a unit. Run results are normalized because leaderboards aggregate them by agent.

## Recording retention

A recording directory stores JSONL. Its database row stores retention metadata.

The sweep runs at startup, on its interval, and after session finalization:

1. Protect recordings used by the latest completed leaderboard runs.
2. Delete unpinned recordings older than the retention window.
3. For each user over quota, delete oldest unpinned recordings until within quota.

Pinned recordings count toward quota but are never evicted. A user at the pinned cap receives `409 pinned_quota`.

Deletion tolerates a missing row or directory so an interrupted sweep can recover on its next pass.

## Identity and authorization

Identity comes from a Better Auth session cookie. `createRequestIdentity(auth)` in `identity.ts` resolves it and caches the result for the request, so a route that both checks access and personalizes its response performs only one session lookup.

`deriveStatus(role)` splits the Better Auth `role` on commas and maps it to `pending`, `normal`, or `admin`. Admin takes precedence over user, and user takes precedence over pending. An unknown, empty, or missing role becomes `pending`, so access fails closed.

Every route states its requirement against the guard trio:

- `requireUser`: Any signed-in user; returns `401 auth_required` for an anonymous request.
- `requireActive`: An active (`normal` or `admin`) user; returns `403 not_active` for a pending user.
- `requireAdmin`: An `admin` user; returns `403 not_operator` otherwise. The `/api/admin` plugin uses the same code through one `onRequest` guard backed by `status === 'admin'`.

Public reads stay open to anonymous visitors. Ban is a standalone Better Auth flag: banning revokes sessions and blocks sign-in, so a banned user never reaches the guards at all.

| Requirement | Applies to |
| --- | --- |
| Public (no guard) | Environment metadata, public config, public season and leaderboard reads |
| `requireUser` | Owner-scoped reads and pins |
| `requireActive` | Session start, submit, rate, and author-prompt writes |
| `requireAdmin` | `/api/admin/*`, unreleased seasons, and admin downloads |

`GET /api/me` returns `{ user: { id, name, email, image, github_username, status } | null }`. The GitHub username is nullable and is read-only to every client.

Cookies ride HTTP fetches, WebSocket upgrades, and native download navigations on the same origin, so no route needs a header or query-parameter fallback for identity.

### GitHub account linking

`auth/auth.ts` configures Better Auth for GitHub linking. GitHub requires a verified email. An implicit link uses the matching verified local email, while an authenticated user may explicitly link a different verified GitHub address.

Database constraints keep each GitHub identity and account email owned by one user. The account hooks maintain the server-owned `githubUsername` field on GitHub links and sign-ins, and unlinking clears it. See the [authentication source](https://github.com/vox-deorum/game-sandbox/tree/main/backend/src/auth) for the implementation details.

`auth/users.ts` resolves public attribution from the Better Auth-owned `user` table. `namesFor(ids)` remains the low-cost name-only batch read used across sessions, recordings, workflows, and leaderboards. `profilesFor(ids)` adds the optional GitHub username and is used only by the agent-profile response, so blind-rating and recording payloads never gain the handle.

## Environment metadata

The canonical registry lives in Python. `scripts/generate.py` writes committed `src/generated/environments.json`, and the generated-code check prevents drift.

`environments.ts` parses the artifact once through the shared `EnvironmentMeta` guard. The API serves the metadata, and the orchestrator reads layout, player, pace, and timeout settings from the same object.

## Submission pipeline

```text
HTTP request → pending row → resolve → static → build → load → ready
```

The route returns after enqueueing. `submission/worker.ts` processes one submission at a time and records each stage before updating the rollup status. The [submission specification](../../specs/submission.md) owns the product rules (flow, validation layers, size cap, snapshots); this section covers the backend implementation.

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

The size check is the first static check. It measures the checked-out tree through one shared filter (`submission/tree-filter.ts`) that excludes `.git` and build artifacts, and compares it to the effective cap defined by [maximum submission size](../../specs/submission.md#maximum-submission-size). The same filter drives the snapshot pack and the overlay build context, so all three agree on which bytes are "the submission".

The Zod manifest schema and Python harness loader are kept in sync by contract tests.

### Worker recovery

For each stage, the worker:

1. Writes a running check.
2. Runs the stage.
3. Closes the check as passed or failed.
4. Updates the submission rollup.

Unexpected errors still close the active stage. Startup re-enqueues pending submissions, and the unique `(submission_id, stage)` key replaces prior attempts.

Overlay building and load checking are described in [Execution boundary](execution.md#submission-overlay-images).

### Snapshots

Once a submission passes the size and static checks, the worker writes a compressed snapshot of its filtered source tree through `SubmissionSnapshotStore` (`submission/snapshot-store.ts`), one `<id>.tar.gz` per submission under `<DATA_DIR>/submissions`. It mirrors `RecordingsStore`: a flat per-id file, an atomic write (temp file then rename), plus `stream`, `exists`, `materialize`, and `delete`. The write is best-effort, so a failure logs and the submission still reaches `ready`.

When a cached overlay was evicted, `ensureSubmissionImage` materializes the tree from the snapshot (falling back to the source seam only for a pre-snapshot submission), and the shared filter plus a deterministic sort make the rebuild reproduce the original overlay. Operator download routes stream the same snapshots, and a forced `deps_version` change that deletes a season's submissions also reclaims them. [Snapshots and downloads](../../specs/submission.md#snapshots-and-downloads) states the product rules.

## HTTP API

Routes live under `/api`. Request bodies use Fastify JSON-schema validation, and expected refusals use stable `code` values.

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
| `/api/seasons` | Public season index |
| `/api/environments/:envId/leaderboards` | Current and historical released boards |
| `/api/sessions/:sessionId/ratings` | Read and write session ratings |
| `/api/seasons/:seasonId/agent-rating-prompt` | Author prompt |
| `/api/llm-development/seasons` and `/api/seasons/:seasonId/llm-development*` | Development-key eligibility, usage, call history, and key rotation |
| `/api/llm/v1/chat/completions` | OpenAI-compatible development completion endpoint |
| `/api/recordings/:id/llm` | Official recording LLM usage and authorized call bodies |

The server derives user identity. Request bodies never choose the submitter, recording owner, or rater.

### Operator API

All `/api/admin` routes pass one operator guard. They support:

- Declaring seasons.
- Replacing validated configuration.
- Setting the season rating prompt.
- Opening and closing submission and play windows.
- Releasing and unreleasing results.
- Triggering and cancelling runs.
- Reading private season, run, board, and game status.
- Listing a season's active submissions, and downloading one submission's source snapshot or a whole season as one `.tar.gz`.
- Streaming workflow logs over WebSocket.

Unreleased board data is available only through operator-gated routes. Public board endpoints enforce release at the route boundary.

## Ratings

The recording header's `players` map is the authority for which agents took part. The backend resolves submission ownership from storage and ignores human entries.

Rating writes validate the full batch before saving anything and reject any batch that breaks the [leaderboard specification's](../../specs/leaderboard.md) rating rules: score range, session membership, self-rating, unfinished or unattributed sessions, and a closed play window.

Rerating upserts the existing value. Closed play returns a read-only view with prior ratings and prompts.

## Workflow runner

Triggering a leaderboard run does not wait for Docker. Scheduling, forfeit, and release rules live in the [leaderboard specification](../../specs/leaderboard.md).

The trigger:

1. Freezes configuration, dependency version, and eligible roster.
2. Persists the balanced schedule and pending run.
3. Enqueues the run ID on `WorkflowRunner`.

`WorkflowRunner` exposes `enqueue`, `cancel`, and `subscribe` over a small event union. Startup reconciliation marks interrupted pending or running workflows failed rather than silently resuming a partial run.
