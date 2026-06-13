# Stage 4: Replay and Retention

Status: complete.

Part of [Stage 4](../stage-04-frontend-core.md). This file records the replay viewer per [recording.md](../specs/recording.md), load by URL, play, pause, step, scrub, through the same renderer as live play, and the backend retention policy from the same spec: the deployment-configured window, the per-user quota, oldest-unpinned-first eviction, and pinning. The post-session feedback prompt appears here as a stub that only offers pinning; ratings storage lands in Stage 6.

## The replay viewer

`/replays/:id` is the shareable URL. The page fetches the recording's JSONL from `GET /api/recordings/:id`, parses it, and holds the states in memory; recordings are small by design, so there is no streaming or windowing. A version the frontend does not understand becomes a friendly "this replay needs a newer viewer" message, which is exactly the breakage the header version exists to catch. The renderer comes from the registry via the header's `environment` and the metadata's `renderer` key, mounted with no `sendAction` and no controlled slots — draw-only by construction.

Implementation note: the parse is done by a small dependency-free browser parser (`frontend/src/replay/parse.ts`), not the schema package's `readRecording`. The schema barrel constructs Ajv and reads schema files with `node:fs` at import time and so cannot run in the bundle (the same constraint that put the protocol and environment helpers on dependency-free subpaths — see [frontend-infrastructure.md](frontend-infrastructure.md)). The browser parser mirrors `readRecording`'s behavior (header first, one state per line, every line's `schema_version` matching the header's, a truncated trailing line ending the readable prefix) with structural casts against the shared types, since the backend is authoritative and already shaped the lines; the one runtime check it keeps is the version gate, reading the supported version from a new dependency-free `@game-sandbox/schema/version` subpath so there is still one declaration. A `vite build` confirms the bundle pulls in neither Ajv nor `node:fs`.

The transport is a plain client-side controller over the state array, and the contract's purity rule makes every operation the same call: render state _i_.

- **Play / pause.** Play advances on the environment's `pace_interval_ms` when set, reproducing the live feel; an unpaced environment plays at a fixed default cadence, since turn timings in the recording reflect agent think time, not viewing pace. Pause just stops the timer — there is no session to signal.
- **Step.** One state forward or back.
- **Scrub.** A slider over the state index, labeled with tick numbers; dragging renders the state under the thumb directly.
- **Deep link.** `?t=⟨tick⟩` seeks on load, so a moment inside a replay is linkable, not just the replay.

The environment page's recent-replays list comes from `GET /api/recordings` filtered to the environment (a `?env=` query parameter on the listing, matching against the retention rows below), newest first, each linking into the viewer and showing pin state for the owner's own recordings.

## Retention metadata

Stage 3 lists recordings straight off the volume with no notion of owner or age, which retention needs. A `recordings` table joins the Kysely schema (migration 2): `id` (text, the recording id), `user_id`, `env_id`, `created_at`, `pinned` (0/1, default 0). The row is the recording's retention metadata; the directory on the volume remains the recording itself. Rows are written by the orchestrator's finalize routine — every end path already converges there, so every session-produced recording gets exactly one row — and the migration backfills rows from the existing `sessions` table (which carries `recording_id`, `user_id`, `env_id`, `created_at`) so pre-Stage-4 recordings join the policy instead of becoming invisible exceptions. A directory with no row after backfill is foreign debris (a half-written crash artifact or hand-copied data): listed header-only, never evicted, an operator concern.

`GET /api/recordings` merges the volume listing with the rows, so each entry carries the header plus `user_id`, `created_at`, and `pinned`; `GET /api/recordings/:id` is unchanged.

## Eviction

Configuration joins `config.ts`: `RECORDING_RETENTION_DAYS` (default 30, the spec's window), `RECORDING_USER_QUOTA` (default 100 recordings per user), and `RECORDING_SWEEP_INTERVAL_MS` (default one hour). The sweep runs at startup, on the interval, and after each session finalize (the only moment the data grows), and applies the spec's policy in two passes over the rows: delete unpinned recordings older than the window, then for each user over quota delete oldest-unpinned-first until within it. Pinned recordings are exempt from both passes but count against the quota, per [recording.md](../specs/recording.md). Deletion removes the recording directory and then the row; the listing tolerates either half missing, so a crash mid-deletion leaves only ignorable debris that the next sweep or listing pass cleans.

Because pinned recordings count against the quota but are never evicted, unbounded pinning could make the quota meaningless. The guard: a pin request is refused (409, `pinned_quota`) when the user's pinned count has reached the quota — the quota stays a hard bound on storage per user, and the refusal is the user's signal to unpin something old.

## Pinning and the feedback stub

`POST /api/recordings/:id/pin` and `DELETE /api/recordings/:id/pin` set and clear the flag, owner-only (the row's `user_id` against the request identity). The end-of-session card on the live page (see [live-session-control.md](live-session-control.md)) shows the post-session feedback prompt in its Stage 4 stub form: a pin toggle and nothing else, sitting where the Stage 6 rating control will join it, per [frontend.md](../specs/frontend.md). The replay viewer shows the same pin toggle when the viewer owns the recording, so pinning is reachable after the session page is gone — the spec's "pin at the end of a session" plus a second chance.
