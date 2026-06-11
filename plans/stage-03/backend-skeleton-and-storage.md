# Stage 3: Backend Skeleton and Storage

Part of [Stage 3](../stage-03-backend-and-live-sessions.md). This file designs the `backend/` package itself: workspace membership and tooling, configuration, the stub identity layer, the storage layer behind an interface, and how the backend obtains environment metadata without ever running Python. The session-shaped pieces live in the other stage-03 documents.

## Package and tooling

`backend/` joins the npm workspace (added to the root `package.json` `workspaces` array) as `@game-sandbox/backend`, private, `type: module`, on the root's Node 22 engines pin. Tooling mirrors `schema/ts`: Biome through the root config, strict `tsc --noEmit` as the check, Vitest for tests. Runtime dependencies, all confirmed at stage start: `fastify` with `@fastify/websocket`, `dockerode` (importable only inside the Docker driver, enforced per [execution-driver-and-image.md](execution-driver-and-image.md)), `better-sqlite3` with `kysely`, and `@game-sandbox/schema` from the workspace for the generated state types and Ajv guards.

The backend runs from source through `tsx`: `npm run dev` is `tsx watch src/main.ts`, `npm run start` is `tsx src/main.ts`. A compiled `dist/` build is a deployment concern deferred until a real deployment exists; nothing in the layout prevents adding a `tsc` build later.

Module layout (the other stage-03 documents fill in `driver/`, `protocol/`, `session/`, and `http/`):

```
backend/src/
  main.ts          process entrypoint: load config, open storage, build app, listen, handle signals
  config.ts        environment-variable configuration with defaults
  app.ts           Fastify assembly: plugins, routes, dependency wiring
  identity.ts      stub user identity until Stage 4 OAuth
  environments.ts  typed access to the generated metadata JSON
  generated/
    environments.json   generated and committed, see below
  storage/         domain types, the Storage interface, the Kysely/SQLite implementation, migrations
  driver/          execution driver interface and the Docker implementation
  protocol/        envelope types and line classification
  session/         the orchestrator and session registry
  http/            HTTP routes and the WebSocket endpoint
```

## Configuration

`config.ts` reads environment variables into one typed, validated `Config` object with class-scale defaults: `PORT` (8080), `DATA_DIR` (default `./data`, holding `sandbox.db` and the `recordings/` root that doubles as the volume mounted into session containers), `SESSION_IDLE_TIMEOUT_MS` and `SESSION_MAX_DURATION_MS` (see [orchestrator-and-http-api.md](orchestrator-and-http-api.md)), the sandbox profile defaults (CPU, memory, scratch size), `EXECUTION_DRIVER` (only `docker` exists), and the Docker driver options (image tag prefix, image policy). No config files and no secrets manager; Stage 4 adds OAuth secrets when they exist. Every consumer receives `Config` (or a slice of it) as a constructor argument — module-level config reads are banned so tests can assemble whole backends with custom settings.

## Identity stub

`identity.ts` resolves a user id per request: the `x-sandbox-user` header when present, otherwise `dev-user`. It is one function, used by every route that attributes anything to a user, and the one-concurrent-session-per-user rule keys on its output. Stage 4 replaces the resolution with the GitHub OAuth session without touching callers; nothing else in the backend may invent its own notion of identity.

## Storage

The storage layer is a narrow domain-shaped interface backed by SQLite via better-sqlite3 plus Kysely, confirmed at stage start: Kysely provides typed query building over a declared database schema, better-sqlite3 provides the synchronous driver with prebuilt binaries for Node 22 on Windows and Linux.

The stored data types are the backend's data schema, and they must be reusable outside Kysely: the orchestrator, the HTTP layer, and tests all pass these types around, so they are defined as plain TypeScript with no Kysely (or other library) dependency, and Kysely is an implementation detail confined to the storage backend. Concretely, the layout splits along that line:

- `storage/types.ts` — the domain types: `Session`, and the `SessionStatus`, `SessionMode`, and `TerminationReason` unions. Plain interfaces and string-literal unions, importable from anywhere in the backend (and by Stage 4+ code) without pulling in a query builder. Later stages add their domain types (submissions, iterations, ratings) to this file alongside their tables.
- `storage/index.ts` — the `Storage` interface, speaking domain types exclusively: `createSession`, `markRunning`, `markEnded`, `findActiveSessionByUser`, `getSession`, `listSessions`. Callers never see Kysely, table types, or SQL.
- `storage/schema.ts` — the Kysely table interfaces, private to the implementation. Column types reference the domain unions (a `sessions` row's `status` column is typed as `SessionStatus`, not `string`) so the table shapes cannot drift from the domain types they store.
- `storage/sqlite.ts` — opens the database in WAL mode, runs migrations, implements the interface, and maps rows to domain types at this boundary and nowhere else.

The same `noRestrictedImports` mechanism that confines dockerode to the Docker driver (see [execution-driver-and-image.md](execution-driver-and-image.md)) also denies `kysely` and `better-sqlite3` outside `backend/src/storage/`, so the reuse rule is mechanically enforced, and swapping SQLite for another engine is one new implementation file against `types.ts` and `index.ts`, which is the parent file's requirement. Tests run the real implementation on better-sqlite3 `:memory:`.

One table now, `sessions`: `id` (text, generated by the backend), `user_id`, `env_id`, `mode` (`human` or `scripted`), `status` (`starting`, `running`, `ended`), `termination_reason` (null until ended), `recording_id`, `created_at`, `ended_at`. Submissions, iterations, and ratings get their own tables in their own stages. Migrations are ordered TypeScript modules embedded in the package and run on startup through Kysely's `Migrator` — no migration CLI; deployment is "start the process".

## Generated environment metadata

The metadata registry lives in Python (`EnvironmentMeta.to_json()` on each registered entry, per [stage-02/environments-and-metadata.md](../stage-02/environments-and-metadata.md)), and the backend serves it without running Python: `scripts/generate.py` grows a step that calls `discover_environments()` and writes `backend/src/generated/environments.json`, an array of each entry's id plus its `to_json()` fields, sorted by id and byte-stable like every other generated artifact. The `generated-code-fresh` CI job grows this path, so the file cannot drift from the registry. `environments.ts` parses the file once at startup, validates the shape with a small hand-written guard (this is deliberately not part of the state schema), and exposes typed lookups; the HTTP layer serves it verbatim and the orchestrator reads pace interval, human-capable slots, and default timeouts from it.
