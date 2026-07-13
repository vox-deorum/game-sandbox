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
- End-to-end latency, including backend retries.

The response includes `request` and `completion` for a row only when the caller is an operator or owns the submission controlling that row's slot. Ownership is resolved from the recording header's player attribution and authoritative submission ownership. In a multi-submission recording, an owner receives bodies for their own slots and metadata for the other slots.

Identity comes from the authenticated session. Query parameters and request bodies never supply caller identity. Blind-season attribution continues to use the existing recording-view rules.

Recording retention reads `llm_scope_id` before deleting a recording row. It deletes the scope file when no surviving recording row references that scope. A live scope normally has one recording. A run scope remains while any recording from that run survives. Cached SQLite handles close before unlinking a file.

Live-session teardown deletes an empty scope file or a scope file whose session produced no recording. A terminal workflow run deletes its scope file when the run produced no retained recording. Files referenced by retained recordings follow the recording-deletion rules above.

A startup sweep runs after active session and workflow recovery. It removes official `data/llm/*.sqlite` files with no surviving recording row whose `llm_scope_id` names that file. It never descends into `data/llm/development/`, whose season ledgers follow their own retention. The recording endpoint has no dependency on development ledgers.

## Replay panel

`ReplayPage.vue` fetches recording telemetry alongside the recording. A new Model calls panel groups successful rows by tick and follows the replay transport position. Each compact row shows slot, model alias, input and output tokens, reasoning tokens in accessible detail text, and latency.

`RunMetadata` shows whole-recording successful call count, token totals, and model-call latency. The replay panel remains metadata-only for every viewer, including owners. Prompt inspection lives on the agent profile.

The panel renders no failure status because unsuccessful logical requests have no telemetry row.

## Submission-owner debug view

`AgentProfilePage.vue` lists recordings with successful LLM calls under each submission history entry. Opening a recording shows that submission's calls grouped by tick, with expandable full request messages and completion bodies plus model, token, and latency details.

Operators receive the same body fields on every agent profile. A non-owner receives no prompt or completion bytes from the API. Server-side response filtering is the authorization boundary, and client-side display conditions control presentation only.

## Automated-board model usage

`AutomatedBoardRow` carries `llm_usage_by_model` from Step 4. `LeaderboardBoards.vue` adds a Model usage column beside agent compute. Each model alias shows successful call count, input, reasoning, and output tokens, and total model-call latency. Agents with no successful calls show the standard empty value.

The human-feedback board has no model-usage column. Model usage remains informational and does not affect rank.

## Participant development API

Add two active-user routes:

| Route | Response |
| --- | --- |
| `GET /api/seasons/:seasonId/llm-development` | Effective aliases and limits, successful usage totals, remaining call and token allowance, and whether a key exists |
| `GET /api/seasons/:seasonId/llm-development/calls?cursor=<id>&limit=<n>` | The authenticated participant's successful ledger rows in reverse chronological order |

The calls response includes full request and completion bodies because the development ledger is private to that participant and operators. Pagination has a bounded default and maximum. Another participant cannot select a user ID or retrieve the ledger.

Add operator routes under `/api/admin/seasons/:seasonId/llm-development` to list participant totals and page one participant's successful rows. Operator routes use the existing admin guard and accept an explicit target user only after authorization.

## Participant and operator UI

Add a Development LLM section to `MyProfilePage.vue` using existing cards, fields, buttons, dialogs, tables, and status components. It provides:

- A season selector for seasons with effective LLM access.
- Allowed model aliases and resolved development limits.
- Successful calls, token totals, and remaining allowance.
- A Create key or Rotate key action that calls the Step 2 endpoint.
- A one-time credential dialog showing `OPENAI_BASE_URL` and `OPENAI_API_KEY` with a warning that the secret cannot be retrieved again.
- A paginated ledger of successful calls with expandable full request and completion bodies.

The season-management view adds a Development usage panel for operators. It lists participant totals for the selected season and opens a participant's private ledger.

No new visual primitive or variant is required. If implementation introduces one, it must be added to `/styleguide` in the same change.

## Tests

Backend tests cover:

- Anonymous, non-owner, one-slot owner, multi-slot owner, and operator responses from the recording endpoint.
- SQLite row decoding, insertion ordering, null setup ticks, durable recording-association lookup, and 404 behavior.
- Telemetry lookup continuing after producing session or workflow rows are pruned.
- Deleting a live recording removing its scope file, deleting one run recording preserving the shared file, and deleting the last run recording removing it.
- Live and terminal workflow scopes with no recording being deleted at their lifecycle boundary.
- Startup orphan cleanup leaving season development ledgers untouched.
- Participant development summaries and pagination scoped from authenticated identity.
- Anonymous, pending, banned, and cross-participant development-ledger access rejection.
- Operator list and detail access.
- Development totals matching successful ledger rows and remaining independent from official execution-scope SQLite and board data.

Frontend unit tests cover:

- Replay filtering and metadata rendering for successful rows.
- Owner debug rendering when bodies exist and body absence for masked responses.
- Model-usage formatting for multiple aliases and empty usage.
- Development season selection, successful totals, remaining allowance, pagination, key creation and rotation, one-time secret handling, and API errors.
- Operator participant totals and ledger detail.

Playwright coverage in Step 6 ties the surfaces to the full backend.

## Done when

- Public replay responses expose only successful-call model, token, tick, slot, and latency metadata.
- Submission owners and operators can inspect full successful official prompts and completions, while every other caller receives no bodies.
- Automated boards report successful calls, tokens, and model-call latency by alias without changing rank.
- Participants can create or rotate a season key, see their remaining development allowance, and inspect only their own successful development rows.
- Operators can inspect every participant's development totals and rows for a season.
- Backend authorization tests, frontend unit tests, and accessibility checks pass.
