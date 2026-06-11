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
  storage/         the Kysely schema and derived domain types, the Storage interface, the SQLite wiring, migrations
  driver/          execution driver interface and the Docker implementation
  protocol/        envelope types and line classification
  session/         the orchestrator and session registry
  http/            HTTP routes and the WebSocket endpoint
```

## Configuration

`config.ts` reads environment variables into one typed, validated `Config` object with class-scale defaults: `PORT` (8080), `DATA_DIR` (default `./data`, holding `sandbox.db` and the `recordings/` root that doubles as the volume mounted into session containers), `SESSION_IDLE_TIMEOUT_MS` (default 60000) and `SESSION_MAX_DURATION_MS` (default 600000), which bound the idle and wall-clock windows in [orchestrator-and-http-api.md](orchestrator-and-http-api.md), the sandbox profile defaults (`SANDBOX_CPUS` at 1, `SANDBOX_MEMORY_MB` at 512, `SANDBOX_SCRATCH_MB` at 256), `EXECUTION_DRIVER` (only `docker` exists, and is the default), and the Docker driver options (`DOCKER_IMAGE_TAG_PREFIX` defaulting to `game-sandbox` and `DOCKER_IMAGE_POLICY` defaulting to `reuse`). No config files and no secrets manager; Stage 4 adds OAuth secrets when they exist. Every consumer receives `Config` (or a slice of it) as a constructor argument — module-level config reads are banned so tests can assemble whole backends with custom settings.

## Identity stub

`identity.ts` resolves a user id per request: the `x-sandbox-user` header when present, otherwise `dev-user`. It is one function, used by every route that attributes anything to a user, and the one-concurrent-session-per-user rule keys on its output. Stage 4 replaces the resolution with the GitHub OAuth session without touching callers; nothing else in the backend may invent its own notion of identity.

## Storage

The storage layer is a narrow domain-shaped interface backed by SQLite via better-sqlite3 plus Kysely, confirmed at stage start: Kysely provides typed query building over a single declared database schema and ships dialect adapters for other engines (PostgreSQL, MySQL) should SQLite ever be outgrown; better-sqlite3 provides the synchronous driver with prebuilt binaries for Node 22 on Windows and Linux.

There is exactly one schema: the Kysely table declarations are the backend's data schema, and every other stored-data type derives from them. The orchestrator, the HTTP layer, and tests pass around domain types produced from the table interfaces with Kysely's type-level helpers (`Selectable` and friends), so there is no hand-maintained parallel type set to drift out of sync. Engine portability comes from Kysely itself, not from a query-layer-neutral type layer: queries go through Kysely's dialect-agnostic API, and a different database backend is a different Kysely dialect wired in at construction. Concretely:

- `storage/schema.ts` — the single source of truth for stored data: the `SessionStatus`, `SessionMode`, and `TerminationReason` string-literal unions; the Kysely table interfaces (`SessionsTable`, whose `status` column is typed as `SessionStatus`, not `string`) and the `Database` interface mapping table names to them; and the derived domain types — `type Session = Selectable<SessionsTable>`, with `Insertable`/`Updateable` derivations where an operation needs them. Later stages add their tables, unions, and derived types (submissions, iterations, ratings) to this file.
- `storage/index.ts` — the `Storage` interface, speaking the derived domain types: `createSession` (taking a small domain-shaped `NewSessionInput` and inserting the row as `starting`), `markRunning`, `markEnded`, `findActiveSessionByUser`, `getSession`, `listSessions`, and `close` to release the database handle. Callers see a domain-shaped API, never SQL or query building; this interface is the seam the orchestrator and HTTP tests are written against.
- `storage/kysely.ts` — the one implementation of `Storage`, written against `Kysely<Database>` through the dialect-agnostic query API. Because the domain types are the row types, there is no row-mapping layer.
- `storage/sqlite.ts` — the SQLite wiring: constructs the better-sqlite3 dialect, opens the database in WAL mode, runs migrations, and hands the resulting `Kysely<Database>` instance to the implementation. Another engine later is a sibling wiring file constructing a different dialect (plus any dialect-specific migration details); the schema, the queries, and the interface do not change.

The same `noRestrictedImports` mechanism that confines dockerode to the Docker driver (see [execution-driver-and-image.md](execution-driver-and-image.md)) also denies `kysely` and `better-sqlite3` outside `backend/src/storage/`: the rest of the backend imports the derived domain types and the `Storage` interface from the storage module rather than declaring tables or building queries itself, and since the derivation helpers are type-level only, the exported domain types impose no runtime dependency on their consumers. Swapping SQLite for another engine is one new dialect-wiring file against the same schema, queries, and interface, which is the parent file's requirement. Tests run the real implementation on better-sqlite3 `:memory:`.

One table now, `sessions`: `id` (text, generated by the backend), `user_id`, `env_id`, `mode` (`human` or `scripted`), `status` (`starting`, `running`, `ended`), `termination_reason` (null until ended), `recording_id`, `created_at`, `ended_at`. Submissions, iterations, and ratings get their own tables in their own stages. Migrations are ordered TypeScript modules embedded in the package and run on startup through Kysely's `Migrator` — no migration CLI; deployment is "start the process". The `Migrator` and the `Migration`/`MigrationProvider` types come from Kysely 0.29's `kysely/migration` subpath, so `sqlite.ts` and the migration modules import from there rather than the package root.

## Generated environment metadata

The metadata registry lives in Python (`EnvironmentMeta.to_json()` on each registered entry, per [stage-02/environments-and-metadata.md](../stage-02/environments-and-metadata.md)), and the backend serves it without running Python: `scripts/generate.py` grows a step that calls `discover_environments()` and writes `backend/src/generated/environments.json`, an array of each entry's `to_json()` fields (which already include its id), sorted by id, with sorted keys, and byte-stable like every other generated artifact. The `generated-code-fresh` CI job grows this path, so the file cannot drift from the registry. `environments.ts` parses the file once at startup, validates the shape with a small hand-written guard (this is deliberately not part of the state schema), and exposes typed lookups; the HTTP layer serves it verbatim and the orchestrator reads pace interval, human-capable slots, and default timeouts from it.
