# The backend

The backend is the Node/TypeScript service outside the container boundary: it lists environments, starts and supervises live sessions, and bridges each session's container to the browser over WebSocket (see the [execution spec](../specs/execution.md) and the [frontend spec](../specs/frontend.md)). It never runs Python and never touches a game; the container is authoritative and the backend is a relay. This page covers the package itself — its layout, configuration, storage, and the identity stub. The session machinery (the execution driver, the transport, and the orchestrator) is its own page: [the execution boundary](execution.md).

## Package layout

`backend/` is the `@game-sandbox/backend` npm workspace, run from source through `tsx`. The modules under `src/` divide along their seams:

| Path | What it is |
| --- | --- |
| `main.ts` | Process entrypoint: load config, open storage, reconcile interrupted workflow runs, build the driver, orchestrator, and workflow runner, listen, handle signals. |
| `config.ts` | Environment-variable configuration parsed once into a typed `Config`. |
| `app.ts` | The Fastify assembly: the HTTP routes and the WebSocket endpoint; it also mounts the Stage 6 admin API, the public leaderboard reads, and the participant rating routes. |
| `identity.ts` | The stub user identity (until Stage 4 brings OAuth) plus the `isAllowlisted`/`isOperator` predicates. |
| `environments.ts` | Typed access to the generated environment metadata. |
| `storage/` | The Kysely schema, the `Storage` interface, the SQLite wiring, the schema bootstrap, and the `SeasonConfig` codec. |
| `driver/` | The execution-driver interface and the local Docker implementation. |
| `session/` | The orchestrator, the per-session relay, and the in-memory registry. |
| `admin/` | The operator-gated Stage 6 admin API (`/api/admin`): declare/configure seasons, the three lifecycle gates, trigger/cancel runs, status/list, and the WebSocket log stream. |
| `leaderboards/` | The public, released-only board and history reads, separate from the `/api/admin` prefix. |
| `ratings/` | The participant rating API: allowlisted post-session 1-5 rating writes and the agent author's per-season rating prompt, attributed to the resolved identity. |
| `workflow/` | The workflow-runner seam: the `WorkflowRunner` interface and its events, the startup reconcile, and the step-3 placeholder runner (the Docker runner lands in Stage 6.4). |
| `season-views.ts` | Wire-shape helpers that decode a season's/run's JSON columns (`config`, snapshots, `slots`) for the admin and public responses. |
| `recordings.ts` | Read (and delete) access to the recordings volume for the HTTP API. |
| `retention.ts` | The recording retention service: the eviction sweep, the merged listing, and pinning. |
| `submission/` | The submission pipeline: the source seam (`source/`), the static and load-check validators (`validate/`), the overlay-image build (`submission-image.ts`), the bounded validation worker, and the overlay-image eviction sweep. |
| `seasons-seed.ts` | Seeds one open season per environment at the current `DEPS_VERSION` on startup, the minimal stand-in the Stage 6 operator admin console and API build on. |
| `deps-version.ts` | The current dependency-set version plus the explicit registry of supported version-specific base-image definitions. Submission and season validation derive their accepted versions from this registry. |

The wire protocol the browser shares with the backend (the line-classification rule, the command envelopes, and the environment-metadata shape with its guard) lives in `@game-sandbox/schema` so there is one declaration, not a backend copy and a frontend copy that drift. Those modules are dependency-free and exposed as subpath exports (`@game-sandbox/schema/protocol`, `@game-sandbox/schema/environment`) so the browser bundle imports them without pulling in the package's Ajv-backed recording readers; the `session/` relay and `environments.ts` import them through the barrel.

## Running it locally

`npm run dev` runs `tsx watch src/main.ts`; `npm run start` runs it once. Both need a reachable Docker daemon, because starting a session launches a container — the backend builds the session base image on first use (see [the execution boundary](execution.md#the-session-base-image)). Because the default `reuse` policy then keeps that first build forever, rebuild the image explicitly after changing the Dockerfile or anything it bundles (the harness, an environment, the built-in agent) with `npm run build:image` (`build-image.ts`); it drives the driver's own build path and always rebuilds the `…:deps-v1` tag, where setting `DOCKER_IMAGE_POLICY=rebuild` instead rebuilds on the next session start. A compiled `dist/` build is deferred until a real deployment exists. The unit suite (`npm test`) runs everywhere with no Docker, against a fake driver and in-memory SQLite; the Docker-gated suite (`npm run test:integration`) launches real containers and is described under [testing](test.md).

The unit tests under `test/` mirror the `src/` layout above so a module and its coverage sit in the same place: `test/storage/` (the session/recording core, submissions, the leaderboard surface, the `SeasonConfig` codec), `test/submission/` (the worker, overlay eviction, the HTTP routes, the source seam, and `test/submission/validate/` for the static and load-check validators), `test/session/` (the orchestrator and the live-session relay), `test/driver/docker/` (the daemon-free overlay helpers), `test/admin/`, `test/leaderboards/`, and `test/ratings/` (the Stage 6 admin, public-board, and participant-rating route contracts), and `test/workflow/` (the runner seam's reconcile and placeholder). The seam-level modules keep their tests at the root (`app`, `config`, `environments`, `identity`, `recordings`, `retention`, `static`, `scheduler`). Shared test doubles live in `test/support/` (the `FakeDriver`, the `StubWorkflowRunner`, the config/environment/socket builders) and checked-in trees in `test/fixtures/`; the Docker-gated suite is its own Vitest project under `test/integration/` (see [testing](test.md)). Both `vitest.config.ts` and `vitest.integration.config.ts` select by the `test/**` glob, so adding a subdirectory needs no config change.

## Configuration

`config.ts` reads environment variables into one validated `Config` with class-scale defaults, and every consumer receives that object (or a slice of it) as a constructor argument — module-level config reads are banned, so a test can assemble a whole backend with custom settings. The parsing helpers wrap small [zod](https://zod.dev) schemas (`z.coerce.number`, `z.stringbool`, `z.enum`), the one validation library the backend standardizes on for parsing untrusted data — env vars here, the manifest contract in the static validator, and the season config document in storage. The variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | The HTTP/WebSocket listen port. |
| `DATA_DIR` | `./data` | Holds `sandbox.db` and the `recordings/` root that doubles as the volume mounted into containers. |
| `SESSION_IDLE_TIMEOUT_MS` | `60000` | How long a session with no attached socket (or, in human mode, no inbound command) lives before it is killed. |
| `SESSION_MAX_DURATION_MS` | `600000` | The wall-clock backstop against a hung container. |
| `SESSION_ALLOWLIST` | `dev-user` | Comma-separated user ids allowed to start live sessions, in either mode. Defaults to the dev user so a fresh checkout plays out of the box; an empty value allows no one. |
| `OPERATOR_ALLOWLIST` | `dev-user` | Comma-separated user ids that may reach the Stage 6 operator admin surface (declaring and configuring seasons, opening/closing the gates, triggering runs). Parsed exactly like `SESSION_ALLOWLIST` and defaulting to the dev user, so the console works out of the box; `isOperator` is the single predicate over it. |
| `RECORDING_RETENTION_DAYS` | `30` | An unpinned recording older than this window is swept (see [recording retention](#recording-retention)). |
| `RECORDING_USER_QUOTA` | `100` | Per-user recording cap; oldest-unpinned-first eviction brings a user back within it. Pinned recordings count toward it but are never evicted. |
| `RECORDING_SWEEP_INTERVAL_MS` | `3600000` | How often the eviction sweep runs on its own timer (it also runs at startup and after each session finalize). |
| `SANDBOX_CPUS` / `SANDBOX_MEMORY_MB` / `SANDBOX_SCRATCH_MB` | `1` / `512` / `256` | The sandbox quotas applied to every session. |
| `EXECUTION_DRIVER` | `docker` | The only driver in this stage. |
| `DOCKER_IMAGE_TAG_PREFIX` / `DOCKER_IMAGE_POLICY` | `game-sandbox` / `reuse` | The image tag prefix and whether an existing tag is reused or always rebuilt. |
| `FRONTEND_DIST` | `frontend/dist` | The built frontend bundle the backend serves at the root (see below). Defaults to the repo's `frontend/dist`; serving is wired only when the directory exists. |
| `GITHUB_TOKEN` | _unset_ | Optional token for GitHub reachability checks and private-repo clone/fetch. The one secret in this stage; it is never written to a submission row or logged, and public repos need none. |
| `ALLOW_LOCAL_SUBMISSIONS` | `false` | Whether the dev-only local-folder submission source is constructed and offered. The gate, not path-sanitization, is the security boundary, so it must stay off in real deployments. |
| `SUBMISSION_GIT_TIMEOUT_MS` | `15000` | Wall-clock ceiling on each `git` invocation, so an unreachable repo fails fast instead of hanging the worker. |
| `SUBMISSION_BUILD_TIMEOUT_MS` | `120000` | Wall-clock ceiling on one overlay build (a `docker` option), so a hung build cannot stall the validation worker. |
| `SUBMISSION_LOAD_CHECK_TIMEOUT_MS` | `30000` | Wall-clock ceiling on one sandboxed load check; import-and-construct is near-instant, so a hang is itself a failure. |
| `OVERLAY_IMAGE_BUDGET` | `50` | Max overlay images the eviction sweep keeps. Active-`ready` images are always kept and count toward the budget; the rest trim newest-kept, oldest-first. |
| `OVERLAY_IMAGE_SWEEP_INTERVAL_MS` | `3600000` | How often the overlay-image sweep runs on its own timer (it also runs at startup and after each overlay build). |

There are no config files and no secrets manager; the lone secret is the optional `GITHUB_TOKEN`. OAuth secrets arrive only when OAuth lands (deferred future work), so there are none yet.

## Serving the frontend

In production the backend serves the built frontend from the same origin through `@fastify/static`, so the whole stack is one process and one command: `npm start` at the repo root builds `frontend/dist/` and launches the backend serving it. Files are served at the root, and a not-found handler returns `index.html` for any non-`/api` GET, which is the SPA fallback that lets a hard refresh on a client-side route (`/environments/:id`, `/sessions/:id`, `/replays/:id`) load; everything under `/api` keeps its JSON `404`. The wiring is conditional on the bundle existing (`config.frontendDir`), so the dev server (where Vite serves the app and proxies `/api` here) and the test suites (no bundle) are untouched.

## Storage

The relational data sits behind a narrow, domain-shaped `Storage` interface over SQLite (better-sqlite3 + Kysely). There is exactly one schema declaration, `storage/schema.ts`: the Kysely table interfaces are the schema, and every stored-data type — `Session`, the `SessionStatus` / `SessionMode` / `TerminationReason` unions — derives from them with Kysely's type-level helpers, so there is no hand-maintained parallel type set to drift. Callers see the derived domain types and the interface methods (`createSession`, `markRunning`, `markEnded`, `findActiveSessionByUser`, `getSession`, `listSessions`), never SQL.

That one implementation lives under `storage/kysely/`, not in a single file: `kysely/index.ts` is a thin `KyselyStorage` facade that holds the `Kysely<Database>` handle and delegates each interface method to a free function in the matching per-domain module — `sessions.ts`, `recordings.ts`, `seasons.ts`, `submissions.ts`, `runs.ts`, `boards.ts`, `ratings.ts`, and `retention.ts`, with the cross-cutting query helpers in `shared.ts`. The query logic lives in those modules; the facade is the table of contents binding the flat `Storage` contract to them, so a method and its test sit next to the rest of their domain rather than in one thousand-line file. Because the domain types are the row types, there is no row-mapping layer — the per-domain queries return `Session` and friends directly.

Engine portability comes from Kysely itself, not a second type layer: queries go through its dialect-agnostic API, and swapping SQLite for another engine is one new wiring file constructing a different dialect against the same schema, queries, and interface. The same Biome import-isolation rule that confines Docker to the driver confines `kysely` and `better-sqlite3` to `storage/`, so the rest of the backend imports the domain types and the interface, not the database engine. There is no versioned migration history — this is a dev codebase with no deployed data to preserve, so the schema is built fresh from one authoritative bootstrap, `storage/create-schema.ts`, run on startup (and idempotent on reopen via `IF NOT EXISTS`); deployment is "start the process". It creates every table in its final shape directly: `sessions`; the `recordings` retention table, whose `Recording` row carries `user_id`, `env_id`, `created_at`, and `pinned`; the submission tables (below); and the Stage 6 leaderboard tables (below). The storage interface grows `createRecording`, `listRecordings`, `getRecording`, `setRecordingPinned`, `countPinnedByUser`, and `deleteRecording` alongside the session methods.

### The submission tables

The four Stage 5 tables, all in the one schema declaration:

- **`seasons`** — one competition per environment. A partial unique index keeps at most one submission-open season per environment, so the seed lookup is unambiguous. `seasons-seed.ts` ensures one such row per environment at startup — a play-open, submission-open, unreleased season with an empty match design; Stage 6 adds the operator admin console and API on top.
- **`submissions`** — the pinned repository, the resolved identity, and the season. A row carries `season_id`, a denormalized `env_id`, the `user_id` (the Stage 4 identity seam, a GitHub handle once OAuth lands), the `source_kind` (`git` | `local`), the source coordinates (`repo_url`, `commit_sha`, `local_path`, `ref` — all nullable, populated per kind and after pinning), a rollup `status` (`pending` | `static_failed` | `build_failed` | `load_failed` | `ready`), the owner-visible terminal `reason`, `created_at`, and `superseded_at`. A partial unique index on `(season_id, user_id) where superseded_at is null` enforces **one active submission per participant per season** at the storage layer: resubmitting stamps `superseded_at` on the prior active row and inserts a new one in a single transaction, so history is preserved and a concurrent resubmit that loses the race raises `SubmissionConflictError` rather than creating a second active row.
- **`submission_checks`** — the append-only per-stage validation log, one row per pipeline `stage` (`resolve` | `static` | `build` | `load`) with a `status` (`running` | `passed` | `failed` | `skipped`), a nullable owner-facing `detail` (the typed rejection reason or captured error text), `started_at`, and `ended_at`. A unique index on `(submission_id, stage)` makes a re-enqueue overwrite a stage's row rather than append a duplicate, so the log stays one row per stage across recovery. This dedicated table — rather than a JSON column on the submission — keeps the relational schema the single source of truth and gives the agent profile ordered, queryable history.
- **`session_submissions`** — submission-to-session attribution: `(session_id, slot_id)` is the composite key, with the `submission_id` it ran and `created_at`. It is what lets the agent profile join a submission to its watch/replay recordings.

The storage interface grows the matching methods: `ensureOpenSeason`/`getOpenSubmissionSeason`/`getSeason` (the Stage 5 `getOpenSeason` is renamed `getOpenSubmissionSeason` now that "open" is ambiguous across the submission and play windows); `createSubmission` (which performs the supersede-and-insert and throws `SubmissionConflictError` on the unique-index race), `getSubmission`, `findActiveSubmission`, `listPendingSubmissions`, `listSubmissionsByUser`, `listActiveSubmissionsBySeason`, `listActiveReadySubmissionIds`, and `updateSubmissionPin`/`updateSubmissionStatus`; `startSubmissionCheck`/`finishSubmissionCheck`/`listSubmissionChecks` for the log; and `recordSessionSubmission`/`listRecordingsBySubmission` for the attribution join.

### The leaderboard tables

The Stage 6.1 tables are the data foundation the rest of Stage 6 attaches to: the full `seasons` row and the run/result/rating tables, all still in the one schema declaration. They are Docker-free and are proven by the storage suite on in-memory SQLite.

The submission window, public-play window, and release status are three **independent** gates on `seasons` — a user can reach a season when any one is in effect, and each gates a different surface — so they are separate columns, not one overloaded `status`:

- `submission_status` (`open` | `closed`) controls whether the submission form accepts agents; its partial unique index (`env_id where submission_status = 'open'`) keeps the one-open-submission invariant.
- `play_status` (`open` | `closed`) controls whether allowlisted users may start public watch/play sessions and write ratings; its own partial unique index keeps one play-open season per environment as the default target. Play is independent of release — the operator can open play on an `unreleased` season.
- `release_status` (`unreleased` | `released`) controls whether the boards and history are visible outside the operator console; `released_at` is stamped on first release for history ordering.
- `label` (operator-facing name), `rating_prompt` (the operator's season-wide rater guidance, always editable), and `config` (below) round out the row. The pinned `deps_version` lives **inside `config`** rather than as its own column, so a run's frozen snapshot is the single record of what governed it.

`config` is one validated JSON document, not normalized into per-field columns — the match design is small, authored and read as a unit, and evolves (the inert messaging/LLM override blocks land now and activate in Stages 8/9). The typed `SeasonConfig` codec in `storage/season-config.ts` is the single gate: a zod `strictObject` (`deps_version`, a list of `matches` each with `slots`/`seeds`/`games`, and optional `overrides`) that rejects unknown keys, empty slots, empty seeds, and non-positive game counts, with `encode`/`decode` helpers the column reads and writes through. The run results below _are_ normalized, because the board queries them per agent.

Every place this stage stores or returns an agent uses one identity shape, `AgentRef = { kind: 'submission', submission_id, user_id } | { kind: 'builtin-naive' }`, flattened into concrete `agent_kind` / `agent_submission_id` / `agent_user_id` columns (both ids null for Naive) so tables filter and group without opaque JSON. The new tables:

- **`season_runs`** — one automated workflow execution. The workflow can re-run, so a run is modeled explicitly and the board points at the latest completed one. A run freezes the validated `config_snapshot` (incl. deps) and the eligible-submission roster at trigger time, so editing the season or resubmitting afterward cannot change what it executes.
- **`season_run_games`** — one scheduled match (the pure scheduler writes these before the runner starts), carrying its deterministic `game_index`, `seed`, resolved `slots`, status, and the `recording_id` the board deep-links.
- **`game_results`** — one per-seat outcome per game (normalized so the board aggregates per agent without averaging per-game means), with `episode_score`, `agent_compute_ms_total`, `acted_tick_count`, and a `failed` flag.
- **`automated_placements`** — the per-agent placement snapshot profiles and history read, rewritten when a completed run supersedes the prior one; unique per submitted agent, with a partial index covering the single null-submission Naive row.
- **`ratings`** — one effective 1-5 human rating per user per agent per season (re-rating upserts); a unique index enforces it, a partial index covers the Naive row, and a rating of one's own submitted agent is rejected before any write. `sessions` also gains a nullable `season_id` (the competition key ratings attach to; old null rows cannot be rated).
- **`agent_rating_prompts`** — the agent author's own rating prompt, keyed per author per season so it survives resubmission, separate from the pinned submission artifact.

The storage interface grows the full Stage 6.1 surface against these: the gate setters (`setSubmissionStatus`/`setPlayStatus` return typed open-conflicts; `setReleaseStatus` stamps once), `createSeason`/`updateSeasonConfig` (the forced-edit path deletes runs, and a forced deps change deletes submissions), `listSeasons`/`getReleasedSeason`/`getPublicPlaySeason`, the run/game/result writers, `getLatestCompletedRun` (what the board reads, so a failed re-run never blanks a good board) alongside `getRun`/`getLatestRun`/`listRunsByStatus` (the last two backing the admin status view and the startup reconcile), `replaceAutomatedPlacements`, the rating upsert/aggregate (with `getHumanBoard` applying the three-rating ranking rule the public and admin board reads serve), both rating-prompt setters, `listSessionSubmissions` (the rating route's header-read fallback), and `listProtectedLeaderboardRecordingIds`, which exempts each season's latest-completed-run recordings from the retention sweep.

## Recording retention

`retention.ts` owns the recording lifecycle the [recording spec](../specs/recording.md) describes. The directory on the volume is the recording itself; the `recordings` row is its retention metadata. A row is written by the session finalize routine — every end path converges there, so each produced recording gets exactly one row (the insert is idempotent on the id). A directory with no row is foreign debris: listed header-only, never evicted.

The eviction sweep runs at startup, on `RECORDING_SWEEP_INTERVAL_MS`, and after each session finalize (the only moment the data grows). It applies the policy in two passes over the rows: delete unpinned recordings older than `RECORDING_RETENTION_DAYS`, then for each user over `RECORDING_USER_QUOTA` delete oldest-unpinned-first until back within it. Pinned recordings are exempt from both passes but count against the quota; deletion removes the directory and then the row, and either half missing is tolerated, so a crash mid-deletion leaves only ignorable debris the next pass cleans. Because pinned recordings count against the quota but never evict, a pin is refused (`409`, `code: "pinned_quota"`) once the user is at their pinned cap, keeping the quota a hard storage bound.

## The identity stub

`identity.ts` resolves a user id per request and is the one place the backend decides who a request belongs to: the `x-sandbox-user` header when present, otherwise the `user` query parameter, otherwise `dev-user`. The query-parameter source exists because a browser cannot set a header on a WebSocket upgrade, so the socket client carries the identity there; it is the same identity, decided in the same function. The one-concurrent-session-per-user rule, the allowlist gate, and every route that attributes anything to a user key on its output. GitHub OAuth (deferred Stage 4 work) replaces the resolution with the session cookie, which the browser sends on both fetch and upgrade automatically, without touching callers; nothing else in the backend may invent its own notion of identity.

`isAllowlisted(userId, allowlist)` lives alongside it: the operator-configured `SESSION_ALLOWLIST` gates starting a live session in either mode, since a watch run also consumes a container. Everything read-only (listing environments and sessions, fetching recordings, spectating an existing session's socket) stays open. The frontend learns membership from `GET /api/me` and hides the start entry points, but the backend check is the enforcement.

`isOperator(userId, operatorAllowlist)` is the second predicate over the same seam: built on `isAllowlisted` against `OPERATOR_ALLOWLIST` (not a new build-mode special case), it is the single authorization check the Stage 6 admin API enforces — one `onRequest` guard on the `/api/admin` plugin runs it before any handler, reading the identity from the header on a normal request and the `user` query parameter on the WebSocket log-stream upgrade. A non-operator gets `403 not_operator`. The dev mock user is in the default list, so the operator console works out of the box; a real deployment lists its operator handles, checked against the resolved GitHub identity once OAuth lands. It adds the operator predicate over the existing identity resolution without changing it.

## Environment metadata

The environment registry lives in Python, and the backend serves it without running Python by reading a generated, committed artifact: `scripts/generate.py` writes `src/generated/environments.json` from `discover_environments()`, the `generated-code-fresh` CI job keeps it in step with the registry, and `environments.ts` parses it once at startup behind a small shape guard. The `EnvironmentMeta` shape and that guard now live in `@game-sandbox/schema` so the browser validates the same `GET /api/environments` response from the same declaration; the `EnvironmentRegistry` and the JSON loading stay in `environments.ts`. The HTTP layer serves the list verbatim, and the orchestrator reads pace interval, human-capable slots, and default timeouts from it.

## The submission pipeline

A submission is fetched, pinned, statically checked, built into an overlay image, and load-checked — and **never runs a game session** to validate (see the [submission spec](../specs/submission.md)). The HTTP route does none of that work inline: it writes the pending row and enqueues a job, returning immediately. `submission/` owns the rest, and the overlay build and the sandboxed load check have their own authority in [the execution boundary](execution.md#from-submission-to-overlay-image).

### The source seam

`submission/source/` is a `SubmissionSource` with three methods: `verifyReachable` (a cheap pre-accept check that never throws), `resolve` (input → pinning facts and a commit), and `fetchTree` (a read-only checkout behind a `TreeHandle` whose `dispose` is idempotent and never deletes a developer's folder). Two sources sit behind it, chosen by `source_kind`:

- The **git source** drives the host-agnostic `git` CLI for the actual pin and checkout: a default-branch head when no ref is given (`ls-remote --symref HEAD`), a named branch or tag (preferring the peeled annotated tag), or an explicit 40-hex commit pinned as-is and verified at fetch. Every invocation runs non-interactively (`GIT_TERMINAL_PROMPT=0`, no askpass) under `SUBMISSION_GIT_TIMEOUT_MS`, and stderr is classified into the closed `SourceFailureKind` set — `unreachable`, `auth_required`, `ref_not_found`, `timeout`, `invalid_input` — never echoing a tokenized URL. A `GITHUB_TOKEN` enables a cheaper GitHub REST reachability probe and basic-auth clone for private github.com repos; non-GitHub public repos use the same non-interactive git path.
- The **local-folder source** is development-only, gated by `ALLOW_LOCAL_SUBMISSIONS`. With the gate off a local input is refused (`local_disabled`) before the filesystem is touched; with it on the folder is trusted input with no path constraints, and `fetchTree` hands back the folder directly with a no-op `dispose`. The gate, not sanitization, is the boundary.

The `git` client is the one place `simple-git` may be imported: a single Biome override re-permits it under `backend/src/submission/source/**` (raw `child_process` stays banned even there — drive git through `simple-git`, not the CLI), and the broad backend block excludes that folder so every file still matches exactly one override. The GitHub client uses the global `fetch`, confined to the same folder by location, and CI proves no other backend source imports `child_process`.

### The static validator

`submission/validate/static.ts` reads the fetched tree and **runs no participant code**. It mirrors the static half of the harness loader (`load_manifest` in [manifest.py](https://github.com/vox-deorum/game-sandbox/blob/main/harness/src/game_sandbox_harness/manifest.py)) and short-circuits on the first failure, returning a typed accept or one specific `StaticReason`:

| Reason code | Triggered when |
| --- | --- |
| `manifest_missing` | no `manifest.json` at the tree root (or it symlinks outside the tree) |
| `manifest_invalid_json` | the manifest is not valid JSON, or not a JSON object |
| `manifest_field_invalid` | a required field (`entry_point`, `class_name`, `template_version`) is missing or the wrong type (`template_version` must be an integer, not a bool or float) |
| `manifest_unknown_key` | the manifest carries a key outside the three required ones |
| `entry_point_missing` | the entry-point module names no `<module>.py` or `<module>/__init__.py` inside the tree |
| `unknown_template_version` | the deployment has no base image for that `template_version` |
| `template_version_mismatch` | the `template_version` does not match the open season's pinned `deps_version` |

The manifest contract is expressed as a zod `strictObject` and a parse failure is mapped back to the closed `StaticReason` set above, so the owner-visible codes are unchanged by the validation-library switch. The required-field list is kept in lockstep with `manifest.py`; the `generated-code-fresh` / contract check keeps the two halves of the loader from drifting (see [testing](test.md)). This is the first demonstrable slice of the stage and is fully exercised Docker-free against the fixtures under `backend/test/fixtures/validate/`.

### The validation worker

`submission/worker.ts` is a bounded, in-process `ValidationWorker` with a durable pending row, so the HTTP route never waits. It processes one submission at a time through four ordered stages — **`resolve` → `static` → `build` → `load`** — writing a `running` `submission_checks` row as each stage starts and closing it `passed` or `failed`, then a rollup onto the submission `status` (`resolve`/`static` failure → `static_failed`, build → `build_failed`, load → `load_failed`, all four passing → `ready`). The per-stage row is always written before the rollup, so a poller never sees `ready` without its checks. The `TreeHandle` is disposed in a `finally`, and an unexpected throw still closes the running stage and writes a rollup, so no stage is left permanently `running`. On startup `start()` re-enqueues every active `pending` row, and because each check is keyed `(submission_id, stage)`, a re-run overwrites the prior attempt rather than appending. A successful build fires an `onOverlayBuilt` hook that triggers the overlay-image eviction sweep.

## The HTTP API

Fastify routes under `/api`, with request bodies validated by Fastify's JSON-schema support:

- `GET /api/environments` — the generated metadata list, verbatim.
- `GET /api/me` — `{user_id, allowlisted}` for the resolved user: the frontend's single source for who-am-I and what-may-I-do, and the obvious place the OAuth replacement lands.
- `POST /api/sessions` — `{env_id, mode, seed?, human_slot_timeout_ms?}` → `201` with the session id and its WebSocket path; `400` for an unknown environment or an invalid mode; `403` with `code: "not_allowlisted"` for a user not on the allowlist; `409` with `code: "already_active"` and `active_session_id` when the user already has an active session (the body the rejoin path reads). The error body always carries the stable `code`; the start route checks request shape (400), then the allowlist (403), then the one-per-user rule (409).
- `GET /api/sessions/:id` — the session row: status, reason, recording id.
- `DELETE /api/sessions/:id` — owner-only graceful stop.
- `GET /api/sessions/:id/ws` — the WebSocket attach point for a live session (see [the WebSocket protocol](execution.md#the-websocket-protocol)).
- `GET /api/recordings` — the merged listing: each readable recording's header plus its retention metadata (`user_id`, `created_at`, `pinned`), newest first, optionally narrowed to one environment with `?env=`. `GET /api/recordings/:id` streams a recording's JSONL unchanged.
- `POST /api/recordings/:id/pin` and `DELETE /api/recordings/:id/pin` — owner-only set/clear of the pin flag (`204`); `403` for a non-owner, `404` for an unknown recording, `409` with `code: "pinned_quota"` when the user is at their pinned cap.

The submission routes (Stage 5) follow the same typed-`code` convention:

- `GET /api/submissions/capabilities` — `{local_submissions}`, the dev-gate flag the form mirrors so the local-folder field is driven by both `import.meta.env.DEV` and the backend, never the build alone.
- `POST /api/submissions/reachability` — `{repo_url?, ref?, local_path?}` → `200` with the `{reachable, failure?, detail?}` verdict (it never throws on an unreachable repo); `400` `code: "invalid_source"` when neither a `repo_url` nor a `local_path` is given, `403` `code: "local_disabled"` for a local source while the gate is off. The form calls it before it will enable submit.
- `POST /api/submissions` — `{env_id, repo_url?, ref?, local_path?}` → `202` with `{id, status}`: it resolves the open season, writes the pending row under the **resolved identity** (the submitter is never read from the body), enqueues the validate-and-build job, and returns. `400` `code: "invalid_source"`, `403` `code: "local_disabled"`, `409` `code: "no_open_season"` when the environment has no open season, and `409` `code: "resubmit_conflict"` when a concurrent resubmit won the active slot (retryable).
- `GET /api/submissions` — the current user's submissions including superseded history, newest first, optionally one environment with `?env=`.
- `GET /api/submissions/:id` — one submission joined with its ordered per-stage validation log (`{...submission, checks}`), so a poll is a single request; `404` for an unknown id. This is the payload the form and profile read.
- `GET /api/environments/:envId/submissions` — the active submissions in the environment's play-open season, optionally narrowed by `?status=` (the watch picker reads the `ready` set); an empty array when there is no play-open season.
- `GET /api/environments/:envId/agents/:ownerId` — the agent profile: `{env_id, owner_id, submissions}`, where each submission carries its `checks` log and recent `replays` (recording ids, newest first). Open and read-only; owner-only affordances gate on the client comparing `owner_id` to its identity. Keyed by environment and owner so a future Hearts agent stays separate from the same user's Flappy Bird agent.

### The Stage 6 admin API

The operator admin routes (`admin/routes.ts`) are the stable contract the admin console and any headless client drive. They are an encapsulated Fastify plugin under `/api/admin`, behind one `onRequest` `isOperator` guard (above) — the single authorization choke point for the whole prefix, returning `403 not_operator` before any handler. The public reads below are deliberately **not** under this prefix, so unreleased boards cannot leak through a public endpoint. The lifecycle actions are path segments (`…/submissions/open`, `…/runs/:runId/cancel`) rather than a mid-segment colon, which Fastify's router would parse as a path parameter; the destructive-edit `force` flag rides as `?force=true`, since the config codec rejects unknown keys.

- `POST /api/admin/environments/:envId/seasons`: declare an `unreleased`, submission-`closed`, play-`closed` season with a default config carrying the current `deps_version`; `400 invalid_season_declaration` for a malformed optional body, `404` for an unknown environment.
- `PUT /api/admin/seasons/:id/config` — replace the whole `SeasonConfig` (body = the config document); `400 invalid_config` with a specific `reason` for a malformed config or a slot count outside the environment's min/max; `409 season_has_runs` / `409 season_has_submissions` unless `?force=true` clears the invalidated runs (and, on a `deps_version` change, submissions) first.
- `PUT /api/admin/seasons/:id/rating-prompt`: set or clear the operator's season-wide rating prompt; always editable, never gated by the config rules; `400 invalid_rating_prompt` for a malformed body and `400 rating_prompt_too_long` for an overlong prompt.
- `POST /api/admin/seasons/:id/submissions/open` | `…/submissions/close` — flip `submission_status`; opening returns `409 open_season_exists` under the one-open invariant.
- `POST /api/admin/seasons/:id/play/open` | `…/play/close` — flip `play_status` (allowed on an `unreleased` season); opening returns `409 open_play_season_exists`.
- `POST /api/admin/seasons/:id/release` | `…/unrelease` — flip `release_status`, stamping `released_at` once.
- `POST /api/admin/seasons/:id/runs` — trigger/re-run: snapshot config/deps/roster, build and persist the schedule, enqueue the run on the runner seam, and return `{id, status}` without blocking on Docker; `409 empty_schedule` for an empty resolved schedule, `409 run_in_progress` when a run is already `pending`/`running`.
- `POST /api/admin/seasons/:id/runs/:runId/cancel` — request a cooperative cancel through the runner; `409 run_not_in_progress` for a terminal run, `404` when the run is not the season's.
- `GET /api/admin/seasons/:id` — the full admin view `{season, latest_run, board}` (decoded config, the latest run with its per-game statuses, and the `automated`/`human` board aggregates even while unreleased); `GET /api/admin/environments/:envId/seasons` lists all seasons including unreleased ones.
- `GET /api/admin/seasons/:id/runs/:runId/logs/ws` — the WebSocket log stream, reusing the session-streaming transport; it subscribes to the runner and relays live `log`/`game_status`/`terminal` events, closing on the terminal (and sending an immediate terminal for an already-finished run).

### The public leaderboard reads

Separate, ungated, and released-only at the route boundary (`leaderboards/routes.ts`):

- `GET /api/environments/:envId/seasons` — released seasons, newest first, for history links.
- `GET /api/environments/:envId/leaderboards` — the current released season and both boards, plus the separate `submission_season_id` and `play_season_id` targets (reported even when unreleased); an empty current-board payload when nothing is released. The `human` board is the ranked aggregate (`getHumanBoard`): agents with at least three ratings carry a 1-based `rank`, the rest follow `rank: null`.
- `GET /api/environments/:envId/seasons/:seasonId/leaderboards` — both boards for a specific released season; `404` for an unreleased or unknown one.
- `GET /api/environments/:envId/agents/:ownerId/placements`: the owner's released-season automated placements (Naive-free submitted-agent rows only).

### The rating API

Participant ratings and the agent author's rating prompt (`ratings/routes.ts`) are plain routes attributed to the **resolved identity** (never a body-supplied user), so they sit outside the operator `/api/admin` prefix. Rating writes also enforce the public-session allowlist. The authoritative source of which agents a session involved is the finished recording's `players` header: this module is the one place that header attribution is mapped to the stage's `AgentRef`. An `agent` entry with a `submission_id` becomes a `submission` ref whose owner is resolved **server-side** from the submission row, an `agent` entry without one becomes `builtin-naive`, and `human` entries are skipped. If the header cannot be read, it falls back to the session's `session_submissions` links. After deduplication, a pure Naive-only recording returns no rateable agents; Naive remains rateable in a mixed session containing a submitted agent.

- `POST /api/sessions/:sessionId/ratings` — body `{ratings: [{agent, score}]}`, where `agent` is the wire `AgentRef` (`{kind:"submission", submission_id}` or `{kind:"builtin-naive"}`, carrying no `user_id`). A caller outside the session allowlist receives `403 not_allowlisted`. The whole payload is validated before any write, so a mixed valid/invalid request saves nothing: `400 invalid_score` (a score outside 1-5), `400 agent_not_in_session`, `400 own_agent` (the caller's own submitted agent, owner resolved server-side). Each accepted score is an upsert (re-rating overwrites), and the route returns the same view the read does. The session gates reject in order: `409 session_not_rateable` (null-season session), `409 session_not_finished` (the session has not ended or has no recording on the volume), `409 play_closed` (the season's play window is closed).
- `GET /api/sessions/:sessionId/ratings` — `{session_id, season_id, read_only, season_prompt, agents:[{agent, is_own, author_prompt, your_rating}]}`: per rateable agent the caller's existing rating (pre-fills re-rating) plus the two applicable prompts — the season's operator prompt and the agent author's prompt (resolved by the involved submission's owner, so it survives resubmission; null for Naive). The caller's own submitted agent comes back `is_own` with no rating control implied. Closed play returns the data with `read_only: true` rather than a conflict; a null-season or unfinished session returns the same conflicts as the write.
- `PUT /api/seasons/:seasonId/agent-rating-prompt` — the agent author sets or clears (`prompt: null`/`""`) their own per-season prompt, keyed by the caller's identity; `409 no_agent_in_season` when the caller has no submission there, `400 author_prompt_too_long` for an overlong prompt, `404` for an unknown season. `GET …/agent-rating-prompt` reads the caller's own prompt back (`{season_id, prompt}`) to populate the editor on their agent profile.

### Background execution and the runner seam

Triggering a run never blocks the request on Docker, the same posture as the Stage 5 submit route. The trigger snapshots config/deps and the ready-submission roster, persists the resolved schedule with a `pending` run row (`createRunWithSchedule`), and enqueues the run id on a `WorkflowRunner` (`workflow/runner.ts`) — an interface of `enqueue`/`cancel`/`subscribe` over a small `RunEvent` union. Stage 6.3 ships a `createPlaceholderRunner` (it accepts the enqueue and leaves the run `pending`, marks a cancel `cancelled`, and emits no events) so the whole surface works end to end now; Stage 6.4 swaps in the Docker-backed runner behind the same interface without touching the routes. On startup `reconcileInterruptedRuns` fails any run a process death left non-terminal (`running`/`pending`) — a partial leaderboard run is never silently resumed.
