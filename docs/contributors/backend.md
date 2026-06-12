# The backend

The backend is the Node/TypeScript service outside the container boundary: it lists environments, starts and supervises live sessions, and bridges each session's container to the browser over WebSocket (see the [execution spec](../specs/execution.md) and the [frontend spec](../specs/frontend.md)). It never runs Python and never touches a game; the container is authoritative and the backend is a relay. This page covers the package itself — its layout, configuration, storage, and the identity stub. The session machinery (the execution driver, the transport, and the orchestrator) is its own page: [the execution boundary](execution.md).

## Package layout

`backend/` is the `@game-sandbox/backend` npm workspace, run from source through `tsx`. The modules under `src/` divide along their seams:

| Path | What it is |
| --- | --- |
| `main.ts` | Process entrypoint: load config, open storage, build the driver and orchestrator, listen, handle signals. |
| `config.ts` | Environment-variable configuration parsed once into a typed `Config`. |
| `app.ts` | The Fastify assembly: the HTTP routes and the WebSocket endpoint. |
| `identity.ts` | The stub user identity, until Stage 4 brings OAuth. |
| `environments.ts` | Typed access to the generated environment metadata. |
| `storage/` | The Kysely schema, the `Storage` interface, the SQLite wiring, and migrations. |
| `driver/` | The execution-driver interface and the local Docker implementation. |
| `protocol/` | The line-classification rule and the command envelopes. |
| `session/` | The orchestrator, the per-session relay, and the in-memory registry. |
| `recordings.ts` | Read access to the recordings volume for the HTTP API. |

## Running it locally

`npm run dev` runs `tsx watch src/main.ts`; `npm run start` runs it once. Both need a reachable Docker daemon, because starting a session launches a container — the backend builds the session base image on first use (see [the execution boundary](execution.md#the-session-base-image)). A compiled `dist/` build is deferred until a real deployment exists. The unit suite (`npm test`) runs everywhere with no Docker, against a fake driver and in-memory SQLite; the Docker-gated suite (`npm run test:integration`) launches real containers and is described under [testing](test.md).

## Configuration

`config.ts` reads environment variables into one validated `Config` with class-scale defaults, and every consumer receives that object (or a slice of it) as a constructor argument — module-level config reads are banned, so a test can assemble a whole backend with custom settings. The variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | The HTTP/WebSocket listen port. |
| `DATA_DIR` | `./data` | Holds `sandbox.db` and the `recordings/` root that doubles as the volume mounted into containers. |
| `SESSION_IDLE_TIMEOUT_MS` | `60000` | How long a session with no attached socket (or, in human mode, no inbound command) lives before it is killed. |
| `SESSION_MAX_DURATION_MS` | `600000` | The wall-clock backstop against a hung container. |
| `SANDBOX_CPUS` / `SANDBOX_MEMORY_MB` / `SANDBOX_SCRATCH_MB` | `1` / `512` / `256` | The sandbox quotas applied to every session. |
| `EXECUTION_DRIVER` | `docker` | The only driver in this stage. |
| `DOCKER_IMAGE_TAG_PREFIX` / `DOCKER_IMAGE_POLICY` | `game-sandbox` / `reuse` | The image tag prefix and whether an existing tag is reused or always rebuilt. |

There are no config files and no secrets manager; OAuth secrets arrive in Stage 4 when they exist.

## Storage

The relational data sits behind a narrow, domain-shaped `Storage` interface over SQLite (better-sqlite3 + Kysely). There is exactly one schema declaration, `storage/schema.ts`: the Kysely table interfaces are the schema, and every stored-data type — `Session`, the `SessionStatus` / `SessionMode` / `TerminationReason` unions — derives from them with Kysely's type-level helpers, so there is no hand-maintained parallel type set to drift. Callers see the derived domain types and the interface methods (`createSession`, `markRunning`, `markEnded`, `findActiveSessionByUser`, `getSession`, `listSessions`), never SQL.

Engine portability comes from Kysely itself, not a second type layer: queries go through its dialect-agnostic API, and swapping SQLite for another engine is one new wiring file constructing a different dialect against the same schema, queries, and interface. The same Biome import-isolation rule that confines Docker to the driver confines `kysely` and `better-sqlite3` to `storage/`, so the rest of the backend imports the domain types and the interface, not the database engine. Migrations are ordered TypeScript modules run on startup through Kysely's `Migrator` — there is no migration CLI; deployment is "start the process". This stage has one table, `sessions`; later stages add submissions, iterations, and ratings to the same file.

## The identity stub

`identity.ts` resolves a user id per request — the `x-sandbox-user` header when present, otherwise `dev-user` — and is the one place the backend decides who a request belongs to. The one-concurrent-session-per-user rule and every route that attributes anything to a user key on its output. Stage 4 replaces the resolution with the GitHub OAuth session without touching callers; nothing else in the backend may invent its own notion of identity.

## Environment metadata

The environment registry lives in Python, and the backend serves it without running Python by reading a generated, committed artifact: `scripts/generate.py` writes `src/generated/environments.json` from `discover_environments()`, the `generated-code-fresh` CI job keeps it in step with the registry, and `environments.ts` parses it once at startup behind a small shape guard. The HTTP layer serves the list verbatim, and the orchestrator reads pace interval, human-capable slots, and default timeouts from it.

## The HTTP API

Fastify routes under `/api`, with request bodies validated by Fastify's JSON-schema support:

- `GET /api/environments` — the generated metadata list, verbatim.
- `POST /api/sessions` — `{env_id, mode, seed?, human_slot_timeout_ms?}` → `201` with the session id and its WebSocket path; `409` when the user already has an active session; `400` for an unknown environment or an invalid mode.
- `GET /api/sessions/:id` — the session row: status, reason, recording id.
- `DELETE /api/sessions/:id` — owner-only graceful stop.
- `GET /api/sessions/:id/ws` — the WebSocket attach point for a live session (see [the WebSocket protocol](execution.md#the-websocket-protocol)).
- `GET /api/recordings` and `GET /api/recordings/:id` — list recording ids with their headers, and stream a recording's JSONL.
