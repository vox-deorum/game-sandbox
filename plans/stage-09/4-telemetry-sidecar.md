# Stage 9.4: The Telemetry Sidecar

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 4: the gateway's per-call telemetry becomes a durable, replayable artifact — the first real member of the sidecar registry Stage 1 declared and has carried as the `future-telemetry` placeholder ever since. Three parts: the versioned payload schema, the tick-attribution marker that turns "this key called the model" into "slot S called the model while computing tick T," and the finalize-time write that lands `llm.jsonl` beside `recording.jsonl`.

**Hands-on result:** run an LLM session, open the recording's directory, and read a schema-valid line per model call, keyed by tick and slot, with the failed calls right beside the successes.

## Why this is its own seam

- [recording.md](../../docs/specs/recording.md) draws the line deliberately: chat rides in per-step state, LLM telemetry is a sidecar. That makes this step a contract exercise — a new schema file, a registered sidecar name, a writer, readers that tolerate absence — which should land as one seam with its own fixtures, not smeared across the enforcement (step 5) and display (step 6) steps that consume it.
- It owns the stage's one genuinely subtle design problem, tick attribution, and pins the chosen mechanism with ordering tests before anything downstream depends on it.

## What to build

### The payload schema

`schema/llm-telemetry.schema.json`, JSON Lines like the recording itself — one object per model call:

```jsonc
{ "tick": 12,            // integer, or null for calls made during load/reset, before tick 0
  "slot": "player_1",
  "model": "gpt-4o-mini",
  "request":  { "messages": [{ "role": "user", "content": "…" }], "truncated": false },
  "response": { "content": "…", "truncated": false },
  "tokens": { "input": 812, "output": 64, "reasoning": 0 },
  "latency_ms": 1440,
  "status": "ok",          // or "error", with "error_code": "budget_exceeded" | …
  "ts": 1767000000000 }
```

- Token counts are the upstream's reported usage; a locally rejected call carries zeros, never a local estimate.
- Per the [state-schema](../../docs/contributors/state-schema.md) rules, the sidecar rides the recording header's `schema_version` — adding a sidecar kind is additive, not a second format, so there is no version bump.
- The file is wired into `SCHEMA_FILES` in `scripts/_paths.py` so `scripts/generate.py` packages it into the harness's `schema_data`, generates its TypeScript types, and emits a golden fixture.
- The sidecar name registry gets its first real entry, `llm-telemetry` at path `llm.jsonl`. The `future-telemetry` unknown-name fixture stays (renamed if needed) because the skip-unknown-sidecars rule still deserves its test.

### Header declaration

When the session config carries the `llm` block, the harness declares `{"name": "llm-telemetry", "path": "llm.jsonl"}` via the `sidecars` argument `build_header` has accepted since Stage 1. The header is written at recording creation while the file arrives at finalize, so a reader may see a declared-but-absent sidecar on an in-flight or crashed session; readers treat that as "no telemetry yet," the same tolerance they already extend to unknown names.

### Tick attribution: the marker

The gateway sees keys; only the harness knows ticks. The pinned mechanism:

- Before running the acting slot's hooks, the harness POSTs `/internal/tick` (the route step 1 reserved), authenticated with that slot's key, body `{"tick": N}` — and once per slot before `load`/`reset` with `{"phase": "setup"}`.
- The gateway keeps the marker **per authenticated grant**, not per session: a row is stamped with its own key's most recent marker, so no key can move another's attribution, and a lost marker mis-stamps only its own slot's rows — with that slot's previous tick or null, never another seat's. Rows before a grant's first marker are `tick: null`.

Why a marker and not a timestamp join, given every step already records `started_at`:

- Attribution by arrival order at a single process is exact under the same sequential-agents guarantee the keys rely on.
- It is immune to both clock hazards a join is not: `PausableClock` subtracts paused time, so recorded `started_at` drifts off wall time in any live session that pauses; and on Docker Desktop the container VM's clock can drift from the host's (where the gateway process stamps rows) after every sleep of the development machine.
- Its failure mode is self-consistent: the marker targets the same endpoint the model calls use, so if the marker cannot get through, neither can the calls it would have attributed.

Harness mechanics: stdlib `urllib` with a short fixed timeout, wrapped so a failure prints a stderr diagnostic and never raises — a telemetry hiccup must not crash a session — and guarded by the `llm` block's existence so disabled sessions run zero new statements (the byte-identical rule again). The synchronous wait for the marker's 204 is a few local-network milliseconds per stepped tick, invisible next to model calls measured in seconds.

### The finalize-time write

- `RecordingsStore` (`backend/src/recordings.ts`) grows `writeSidecar(id, path, lines)` and `streamSidecar(id, path)` beside its `recording.jsonl` handling; `delete()` already removes the whole per-recording directory, so retention, pinning, and eviction cover sidecars with no new rules.
- At the teardown points step 2 instrumented — `LiveSession.finalize` and the workflow runner's `runGame` after exit — the backend drains the session's telemetry buffer from the gateway and writes `llm.jsonl`; an empty file when no calls were made, since the header declared it and absence should mean "not finalized," not "no calls."
- The sidecar is the complete call log — step 1 never drops rows, only body text, so every call appears and `truncated` flags mark where bodies were withheld for size.
- Step 5 reuses the same drained rows for token aggregation, so the drain happens once.
- A backend crash mid-session loses the buffer — accepted and noted, since a backend crash already ends the session itself.

[recording.md](../../docs/specs/recording.md) gains the one-sentence nuance this step creates: setup-phase calls carry a null tick.

## Tests

Docker-free, both languages:

- The golden fixture round-trips: the Python validator accepts every fixture line and rejects a missing `slot`, a non-integer tick, and an unknown `status`; the generated TS types compile against it; `readRecording` still ignores sidecar files themselves.
- A recording header for an LLM session declares exactly the `llm-telemetry` sidecar; a non-LLM header declares none and is byte-identical to pre-stage fixtures; the unknown-name fixture still loads.
- Marker ordering against a fake gateway: rows land on their own grant's most recent marker; a two-agent episode interleaves with cross-key isolation, one slot's marker never re-stamping another's rows; a failed marker degrades only that slot's attribution (stale-or-null, pinned by the test) with stderr noise and never a crash; calls during `reset` are `null`-ticked.
- Finalize writes the sidecar in both launch paths (fake driver): rows match the drained buffer, an idle session writes an empty file, and a double finalize does not double-write.
- `streamSidecar` streams what `writeSidecar` wrote; `delete` removes it with the directory.

Docker-gated, in the `backend-integration` lane:

- A real session with the step 3 oracle produces an `llm.jsonl` whose every row validates, whose ticks correspond to the acting slot's recorded steps, and whose token counts match the gateway's counters.

## Done when

- An LLM-enabled session leaves two artifacts in its recording directory: the recording and a schema-valid `llm.jsonl` declared in the header, one line per model call — successes and failures — each carrying tick, slot, model, both bodies (truncation-flagged), the three token counts, and latency.
- Ticks are attributed by the marker, exact for paused sessions and drifted clocks alike.
- A disabled session's recording is byte-identical to today's.
- The schema is generated into both languages with a golden fixture, and the backend can stream the sidecar back out for the steps that follow.
