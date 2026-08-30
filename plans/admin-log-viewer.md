# Admin Current-Process Log Viewer

Status: complete.

## Goal

Give admins a small, safe view into what the current backend process is doing. The view should help diagnose a live deployment without turning participant containers or the host's console into an application data source.

## Mechanism

- **Global entry point**: add an admin-only **Logs** item to the global navigation and a Logs page in the frontend.
- **Structured contract**: all application producers write through one process-level logger, without constructor-level logger callbacks. Retained entries use levels `info`, `warn`, and `error`; sources are `main`, `http`, `llm`, `auth`, `retention`, `overlay-eviction`, `session`, `workflow`, `leaderboard`, and `submission`. The level and source vocabulary is defined once in the shared schema package (`@game-sandbox/schema/logs`), so the buffer, the admin route's validation, and the frontend client cannot drift apart. Each entry carries a sequence, ISO timestamp, level, source, and message. Request failures that are the client's fault (4xx, such as a malformed JSON body) record as warnings, so unauthenticated request spam cannot fill the error view or evict server-fault history.
- **Bounded process buffer**: count serialized entry bytes against a 4 MiB budget. There is no count limit. Evict the oldest entries as needed, and lose all retained entries on restart. Messages continue to stderr for external collection, but stderr is not durable.
- **Scope**: capture application logger messages from the current Node process only. Do not include participant container diagnostics or direct console paths that bypass the application logger.
- **Polling**: fetch a full retained snapshot on boot and poll safely using the process boot identifier and sequence cursor. A boot change replaces the local snapshot, and a truncated cursor displays a history-gap notice. The client can clear its displayed snapshot without changing server retention.
- **HTTP boundary**: serve the admin route behind the existing admin guard, with `cache-control: no-store`. Support level, source, and message filters while preserving the full retained snapshot contract.

The page keeps the distinction between process diagnostics and workflow logs visible:

```text
Global admin navigation
  Users
  Logs

+------------------------------------------------------------------------------+
| Backend Logs (214 shown from 628 retained, 1.2 MiB)                          |
| Current backend process. History resets when the process restarts.           |
|                                                                              |
| [ All ] [ Info ] [ Warnings ] [ Errors ]    Source: [ All sources v ]        |
| Search: [ placements               ]   [ Pause live updates ] [ Clear ]       |
|                                                                              |
| +----------+-------+------------+------------------------------------------+ |
| | Time     | Level | Source     | Message                                  | |
| +----------+-------+------------+------------------------------------------+ |
| | 14:02:11 | info  | main       | backend listening on 0.0.0.0:8000        | |
| | 14:02:15 | warn  | auth       | using published development credentials  | |
| | 14:03:40 | error | leaderboard| run r_81: persisting placements failed   | |
| +----------+-------+------------+------------------------------------------+ |
+------------------------------------------------------------------------------+
```

The takeaway is that an admin can filter and clear the locally displayed current-process snapshot, while the server remains bounded, restart-scoped, and separate from participant diagnostics.

## Limitations

- Logs are best effort and disappear when the backend restarts.
- The 4 MiB budget applies to serialized retained entries, not to a fixed number of rows.
- The page does not show participant container stderr/stdout or arbitrary direct console output.
- Standard error may be collected by the deployment host or container runtime, but it is not an application-managed durable log.

## Files

- AGENTS.md
- docs/specs/frontend.md, docs/specs/identity.md, docs/specs/deployment.md
- frontend/src/pages/AdminLogsPage.vue, frontend/src/components/admin/BackendLogTable.vue, frontend/src/api/client.ts
- frontend/src/main.ts, frontend/src/components/AppSidebar.vue
- backend/src/logging/log-buffer.ts, backend/src/admin/log-routes.ts, backend/src/admin/routes.ts, backend/src/app.ts, backend/src/main.ts
- schema/ts/src/logs.ts, the shared level and source vocabulary
- backend and frontend tests for the buffer, admin route, polling, clear behavior, navigation, and access guard
