# Stage 9.5: LLM Usage Surfaces

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 5.

## Outcome

Public replays and automated boards show successful official-call metadata. Submission owners and operators can inspect full official prompts and completions. Participants can rotate a development key and inspect their private season meter and successful-call ledger. Operators can inspect development usage for any participant in a season.

The hands-on check compares anonymous, submission-owner, participant, and operator views in the browser and through the raw APIs.

## Recording telemetry API

Add `GET /api/recordings/:id/llm`. The recording row supplies its durable `llm_scope_id` and `llm_session_id`. The backend opens `data/llm/<llm_scope_id>.sqlite` and returns successful rows matching `llm_session_id`, ordered by insertion ID. A missing association, scope file, or matching row returns 404.

Every returned row includes these public fields:

- Tick and slot.
- Model alias.
- Input, reasoning, and output token counts.
- Whether the token counts are estimated.
- End-to-end latency, including backend retries.

The response includes `request` and `completion` for a row only when the caller is an operator or owns the submission controlling that row's slot. Owner authorization requires both the recording header's player attribution and a surviving authoritative submission row owned by the authenticated user. Recorded attribution alone does not prove current ownership. In a multi-submission recording, an owner receives bodies for their own slots and metadata for the other slots.

Deleting a submission does not delete a retained recording or its referenced telemetry. After the authoritative submission row is gone, its former owner receives only public metadata for that slot because ownership can no longer be proven. Operators retain body access. The same rule applies when the recording header still contains the deleted submission ID or historical user attribution.

Identity comes from the authenticated session. Query parameters and request bodies never supply caller identity. Blind-season attribution continues to use the existing recording-view rules.

Recording retention claims an eviction in one application-database transaction that rechecks the recording's current pin, the owning session or workflow lifecycle, and latest-completed-run protection. An eligible claim removes the recording row and inserts `recording_cleanup_queue` work atomically, recording `llm_scope_id` only when the claim removed that scope's final association. Serialized sweeps retry queued recording-directory and telemetry deletion until both succeed, then acknowledge the work, so a crash or failed unlink cannot lose cleanup intent and mutable retention state cannot suppress the retry. Submission deletion does not participate in this decision: a surviving recording keeps its referenced telemetry even if one or more attributed submission rows have been deleted. A live scope normally has one recording. A run scope remains while any recording from that run survives. Cached SQLite handles close before unlinking a file, and a claim succeeds only after the teardown barrier for the live session or every session contributing to the run scope has blocked admission, aborted or drained active requests, and awaited reservation finalizers.

After the session teardown barrier resolves, live-session teardown may aggregate final usage and delete an empty scope file or a scope file whose session produced no recording. A terminal workflow run awaits the same barrier for every contributing session before final aggregation and may then delete its scope file when the run produced no retained recording. Files referenced by retained recordings follow the recording-deletion rules above.

A startup sweep runs after active session and workflow recovery. It removes official `data/llm/*.sqlite` files with no surviving recording row whose `llm_scope_id` names that file. It never descends into `data/llm/development/`, whose season ledgers follow their own retention. The recording endpoint has no dependency on development ledgers.

## Replay panel

`ReplayPage.vue` fetches recording telemetry alongside the recording. A new Model calls panel groups successful rows by tick and follows the replay transport position. Each compact row shows slot, model alias, input and output tokens, reasoning tokens in accessible detail text, latency, and a clear estimate label when `usage_estimated` is true.

`RunMetadata` shows whole-recording successful call count, token totals, model-call latency, and whether any included token total is estimated. The replay panel remains metadata-only for every viewer, including owners. Prompt inspection lives on the agent profile.

The panel renders no failure status because unsuccessful logical requests have no telemetry row.

## Submission-owner debug view

`AgentProfilePage.vue` lists recordings with successful LLM calls under each surviving submission history entry. Opening a recording shows that submission's calls grouped by tick, with expandable full request messages and completion bodies plus model, token, latency, and estimated-usage details. If the submission is later deleted, the former owner loses this body access even though the recording and its public telemetry metadata remain available through their normal surfaces.

Operators receive the same body fields wherever they inspect the recording, including after an attributed submission is deleted. A non-owner receives no prompt or completion bytes from the API. Server-side response filtering is the authorization boundary, and client-side display conditions control presentation only.

## Automated-board model usage

`AutomatedBoardRow` carries `llm_usage_by_model` from Step 4. `LeaderboardBoards.vue` adds a Model usage column beside agent compute. Each model alias shows successful call count, input, reasoning, and output tokens, total model-call latency, and an estimate label when the aggregate includes estimated usage. Agents with no successful calls show the standard empty value.

The human-feedback board has no model-usage column. Model usage remains informational and does not affect rank.

## Participant development API

Add two active-user routes:

| Route | Response |
| --- | --- |
| `GET /api/seasons/:seasonId/llm-development` | Effective aliases and limits, successful usage totals, whether any token total is estimated, remaining call and token allowance, and whether a key exists |
| `GET /api/seasons/:seasonId/llm-development/calls?cursor=<id>&limit=<n>` | The authenticated participant's successful ledger rows, including `usage_estimated`, in reverse chronological order |

The calls response includes full request and completion bodies because the development ledger is private to that participant and operators. Pagination has a bounded default and maximum. Another participant cannot select a user ID or retrieve the ledger.

Add operator routes under `/api/admin/seasons/:seasonId/llm-development` to list participant totals and page one participant's successful rows. Operator routes use the existing admin guard and accept an explicit target user only after authorization.

## Participant and operator UI

Add a Development LLM section to `ProfilePage.vue` using existing cards, fields, buttons, dialogs, tables, and status components. It provides:

- A season selector for seasons with effective LLM access.
- Allowed model aliases and resolved development limits.
- Successful calls, token totals, remaining allowance, and clear labels on estimated row and summary usage.
- A Create key or Rotate key action that calls the Step 2 endpoint.
- A one-time credential dialog showing `OPENAI_BASE_URL` and `OPENAI_API_KEY` with a warning that the secret cannot be retrieved again.
- A paginated ledger of successful calls with expandable full request and completion bodies.

The season-management view adds a Development usage panel for operators. It lists participant totals for the selected season, identifies totals that include estimates, and opens a participant's private ledger with the same row-level estimate labels.

No new visual primitive or variant is required. If implementation introduces one, it must be added to `/styleguide` in the same change.

## Tests

Backend tests cover:

- Anonymous, non-owner, one-slot owner, multi-slot owner, and operator responses from the recording endpoint.
- Deleting an attributed submission preserving the recording and referenced telemetry file, masking request and completion bodies from the former owner, preserving public metadata, and retaining operator body access.
- SQLite row decoding, insertion ordering, null setup ticks, estimated-usage flags, durable recording-association lookup, and 404 behavior.
- Telemetry lookup continuing after producing session or workflow rows are pruned.
- Deleting a live recording removing its scope file, deleting one run recording preserving the shared file, and deleting the last run recording removing it only after the teardown barrier settles active requests and reservations.
- Live and terminal workflow scopes with no recording being deleted at their lifecycle boundary without a late telemetry write.
- Startup orphan cleanup leaving season development ledgers untouched.
- Participant development summaries and pagination scoped from authenticated identity.
- Anonymous, pending, banned, and cross-participant development-ledger access rejection.
- Operator list and detail access.
- Development totals and estimate indicators matching successful ledger rows and remaining independent from official execution-scope SQLite and board data.

Frontend unit tests cover:

- Replay filtering and metadata rendering for successful rows, including row and summary estimate labels.
- Owner debug rendering when bodies exist, body absence for masked responses, and estimate labels in both cases.
- Model-usage formatting for multiple aliases, aggregates containing estimates, and empty usage.
- Development season selection, successful totals, estimate labels, remaining allowance, pagination, key creation and rotation, one-time secret handling, and API errors.
- Operator participant totals, estimate labels, and ledger detail.

Playwright coverage in Step 6 ties the surfaces to the full backend.

## Done when

- Public replay responses expose only successful-call model, token, estimate, tick, slot, and latency metadata.
- Submission owners can inspect full successful official prompts and completions while an authoritative owned submission row survives. Operators retain access, while every other caller, including a former owner after submission deletion, receives no bodies.
- Automated boards report successful calls, tokens, estimate status, and model-call latency by alias without changing rank.
- Participants can create or rotate a season key, see their remaining development allowance, and inspect only their own successful development rows with estimates identified.
- Operators can inspect every participant's development totals and rows for a season with estimates identified.
- Backend authorization tests, frontend unit tests, and accessibility checks pass.
