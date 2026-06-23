# Backend

The backend is the Node and TypeScript service outside the session container. It serves the HTTP API and built frontend, resolves development identity, stores relational data, supervises sessions and leaderboard workflows, and relays WebSocket traffic.

It never steps an environment or runs participant Python. The session container is authoritative for game state.

Read [the execution boundary](execution.md) for drivers and session transport, [the backend-facing specifications](../specs/execution.md) for architectural rules, and [Testing](test.md) for the verification matrix.

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
| `src/identity.ts` | Resolve development identity and apply allowlists |
| `src/environments.ts` | Load generated environment metadata |
| `src/storage/` | Kysely schema, domain interface, SQLite implementation, migration |
| `src/driver/` | Execution-driver interface and Docker implementation |
| `src/session/` | Orchestrator, live relay, active-session registry |
| `src/submission/` | Source resolution, validation, image build, worker, eviction |
| `src/admin/` | Operator-only season and workflow API |
| `src/leaderboards/` | Public season and leaderboard reads |
| `src/ratings/` | Session ratings and author prompts |
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
| `npm run demo` | From the repo root, launch the app with populated e2e data (as the operator) |
| `npm run demo:user` | The same demo signed in as an ordinary member (`ada-lovelace`), no admin console |
| `npm run demo -- --rerun-e2e` | The same demo, forcing a fresh e2e run first (discards any existing fixture database) |

Starting a session requires Docker. Unit tests use an in-memory SQLite database and fake driver.

Tests mirror source domains under `test/`. Shared doubles and fixtures live under `test/support/` and `test/fixtures/`; Docker-gated tests live under `test/integration/`.

## Configuration

`config.ts` reads environment variables once. Services receive `Config`, or the slice they need, through construction. Do not read process environment variables from feature modules.

Zod validates environment variables, manifests, and season configuration.

### Server and session

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP and WebSocket port |
| `DATA_DIR` | `./data` | Root containing `sandbox.db` and recording directories |
| `SESSION_IDLE_TIMEOUT_MS` | `60000` | Lifetime with no attached socket, or no human command in human mode |
| `SESSION_MAX_DURATION_MS` | `600000` | Wall-clock backstop |
| `SESSION_ALLOWLIST` | `dev-user` | Comma-separated users allowed to start sessions; empty allows no one |
| `OPERATOR_ALLOWLIST` | `dev-user` | Comma-separated users allowed to use `/api/admin` |
| `SANDBOX_CPUS` | `1` | Session CPU quota |
| `SANDBOX_MEMORY_MB` | `512` | Session memory quota |
| `SANDBOX_SCRATCH_MB` | `256` | Writable scratch quota |

### Execution and frontend

| Variable | Default | Meaning |
| --- | --- | --- |
| `EXECUTION_DRIVER` | `docker` | Active driver |
| `DOCKER_IMAGE_TAG_PREFIX` | `game-sandbox` | Image prefix |
| `DOCKER_IMAGE_POLICY` | `reuse` | `reuse` an existing tag or `rebuild` before launch |
| `FRONTEND_DIST` | `frontend/dist` | Built frontend directory; static serving is disabled when absent |

### Recordings

| Variable | Default | Meaning |
| --- | --- | --- |
| `RECORDING_RETENTION_DAYS` | `30` | Age limit for unpinned recordings |
| `RECORDING_USER_QUOTA` | `100` | Per-user recording count; pinned recordings count but are not evicted |
| `RECORDING_SWEEP_INTERVAL_MS` | `3600000` | Periodic sweep interval; sweeps also run at startup and finalization |

### Submissions

| Variable | Default | Meaning |
| --- | --- | --- |
| `GITHUB_TOKEN` | unset | Optional private-repository and reachability token; never stored with a submission |
| `ALLOW_LOCAL_SUBMISSIONS` | `false` | Enable the trusted development-only local source |
| `SUBMISSION_GIT_TIMEOUT_MS` | `15000` | Git operation deadline |
| `SUBMISSION_BUILD_TIMEOUT_MS` | `120000` | Overlay build deadline |
| `SUBMISSION_LOAD_CHECK_TIMEOUT_MS` | `30000` | Sandboxed load-check deadline |
| `OVERLAY_IMAGE_BUDGET` | `50` | Maximum cached submission overlays; active ready images are protected and count |
| `OVERLAY_IMAGE_SWEEP_INTERVAL_MS` | `3600000` | Overlay sweep interval; sweeps also run at startup and after builds |

Keep `ALLOW_LOCAL_SUBMISSIONS` disabled in real deployments. The gate, not path sanitization, is its security boundary.

## Static frontend

When `FRONTEND_DIST` exists, the backend serves it through `@fastify/static`.

- Root `npm start` builds `frontend/dist/` first.
- Non-API GET 404s return `index.html` for client-side routing.
- `/api` routes keep JSON 404 responses.
- Vite development and tests without a built bundle are unchanged.

## Storage

Relational data sits behind a domain-shaped `Storage` interface implemented with Kysely and better-sqlite3.

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

## Development identity and authorization

`identity.ts` resolves a user in this order:

1. `x-sandbox-user` request header.
2. `user` query parameter for WebSocket upgrades.
3. `dev-user`.

All attribution and authorization use that resolved value. OAuth can replace this function with cookie-backed identity without changing callers.

`SESSION_ALLOWLIST` controls session starts. Read-only routes and spectating remain open.

`OPERATOR_ALLOWLIST` controls the `/api/admin` plugin through one `onRequest` guard. Non-operators receive `403 not_operator`.

## Environment metadata

The canonical registry lives in Python. `scripts/generate.py` writes committed `src/generated/environments.json`, and the generated-code check prevents drift.

`environments.ts` parses the artifact once through the shared `EnvironmentMeta` guard. The API serves the metadata, and the orchestrator reads slot, pace, and timeout settings from the same object.

## Submission pipeline

```text
HTTP request → pending row → resolve → static → build → load → ready
```

The route returns after enqueueing. `submission/worker.ts` processes one submission at a time and records each stage before updating the rollup status.

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
| `manifest_missing`          | No root `manifest.json`               |
| `manifest_invalid_json`     | Invalid JSON or non-object            |
| `manifest_field_invalid`    | Missing or wrong-typed required field |
| `manifest_unknown_key`      | Extra manifest field                  |
| `entry_point_missing`       | Module file or package is absent      |
| `unknown_template_version`  | No registered base image              |
| `template_version_mismatch` | Version differs from the season       |

The Zod manifest schema and Python harness loader are kept in sync by contract tests.

### Worker recovery

For each stage, the worker:

1. Writes a running check.
2. Runs the stage.
3. Closes the check as passed or failed.
4. Updates the submission rollup.

Unexpected errors still close the active stage. Startup re-enqueues pending submissions, and the unique `(submission_id, stage)` key replaces prior attempts.

Overlay building and load checking are described in [Execution boundary](execution.md#submission-overlay-images).

## HTTP API

Routes live under `/api`. Request bodies use Fastify JSON-schema validation, and expected refusals use stable `code` values.

### Public and participant groups

| Prefix or route | Responsibility |
| --- | --- |
| `/api/environments` | Environment metadata |
| `/api/me` | Resolved user and capabilities |
| `/api/sessions` | Start, read, stop, and attach to sessions |
| `/api/recordings` | List, stream, pin, and unpin recordings |
| `/api/submissions` | Capabilities, reachability, submit, poll, history |
| `/api/environments/:envId/agents` | Agent profiles and placements |
| `/api/seasons` | Public season index |
| `/api/environments/:envId/leaderboards` | Current and historical released boards |
| `/api/sessions/:sessionId/ratings` | Read and write session ratings |
| `/api/seasons/:seasonId/agent-rating-prompt` | Author prompt |

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
- Streaming workflow logs over WebSocket.

Unreleased board data is available only through operator-gated routes. Public board endpoints enforce release at the route boundary.

## Ratings

The recording header's `players` map is the authority for which agents took part. The backend resolves submission ownership from storage and ignores human entries.

Rating writes validate the full batch before saving anything. They reject:

- Scores outside 1 to 5.
- Agents not in the session.
- The caller's own agent.
- Unfinished or unattributed sessions.
- A closed play window.

Rerating upserts the existing value. Closed play returns a read-only view with prior ratings and prompts.

## Workflow runner

Triggering a leaderboard run does not wait for Docker.

The trigger:

1. Freezes configuration, dependency version, and eligible roster.
2. Persists the balanced schedule and pending run.
3. Enqueues the run ID on `WorkflowRunner`.

`WorkflowRunner` exposes `enqueue`, `cancel`, and `subscribe` over a small event union. Startup reconciliation marks interrupted pending or running workflows failed rather than silently resuming a partial run.
