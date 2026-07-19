# Stage 9.5: LLM Surfacing APIs

Status: complete.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 5.

## Outcome

The backend serves successful official-call telemetry and authoritative budget costs for recordings, plus private development usage for participants and operators. Server-side response filtering is the authorization boundary: public callers receive metadata, submission owners and operators receive full official prompts and completions, and each participant reads only their own development meter and successful-call ledger. Telemetry-file retention follows the recording, session, and workflow lifecycle.

The hands-on check exercises the raw APIs as anonymous, submission-owner, participant, and operator callers and confirms each boundary.

## Recording telemetry API

Add `GET /api/recordings/:id/llm`. The recording row supplies its durable `llm_scope_id` and `llm_session_id`. The backend opens `data/llm/<llm_scope_id>.sqlite` and returns successful rows matching `llm_session_id`, ordered by insertion ID. The response is `{ calls, total_budget_cost_units }`, where `calls` is the row array and the total is the sum of its stored per-row budget costs.

An ordinary recording with no telemetry association returns `200` with an empty row list and `total_budget_cost_units: 0`. An associated scope with no successful row for that session returns the same successful empty payload. This covers LLM-enabled sessions whose model requests all failed or were rejected. A missing or unreadable associated scope file, an unsupported telemetry version, or a row without its required cost basis returns `500 telemetry_unavailable`. These states indicate broken retained data, not an empty recording.

Step 5 advances the official telemetry file's `PRAGMA user_version` and adds a positive finite `cost_weight` plus `budget_cost_units` to every newly committed row. The successful-call sink copies the weight from the authenticated grant that admitted the call and computes the cost as that weight multiplied by input plus total completion tokens. Reasoning tokens remain a reported subset of completion tokens and are not charged twice. This is the same frozen run price or live grant price that the meter charged, so replay data never uses mutable deployment or season configuration to reprice an old call. The migration leaves legacy rows that lack a durable price basis explicitly unsupported rather than assigning a current price. Because Stage 9 is still pre-production, contributors may recreate those local telemetry fixtures. Migration tests cover both the new version and rejection of an associated legacy file whose costs cannot be recovered authoritatively.

Every returned row includes these public fields:

- Tick and slot.
- Model alias.
- Input, reasoning, and output token counts.
- Whether the token counts are estimated.
- The stored cost weight and authoritative `budget_cost_units` charged for the call.

Latency remains in internal telemetry for reliability diagnostics but is not part of the recording response.

The response includes `request` and `completion` for a row only when the caller is an operator or owns the submission controlling that row's slot. Owner authorization requires both the recording header's player attribution and a surviving authoritative submission row owned by the authenticated user. Recorded attribution alone does not prove current ownership. In a multi-submission recording, an owner receives bodies for their own slots and metadata for the other slots.

Deleting a submission does not delete a retained recording or its referenced telemetry. After the authoritative submission row is gone, its former owner receives only public metadata for that slot because ownership can no longer be proven. Operators retain body access. The same rule applies when the recording header still contains the deleted submission ID or historical user attribution.

Identity comes from the authenticated session. Query parameters and request bodies never supply caller identity. Blind-season attribution continues to use the existing recording-view rules.

Unsuccessful logical requests have no telemetry row and therefore add no cost to the successful empty or populated response.

## Telemetry retention and cleanup

Recording retention claims an eviction in one application-database transaction that rechecks the recording's current pin, the owning session or workflow lifecycle, and latest-completed-run protection. An eligible claim removes the recording row and inserts `recording_cleanup_queue` work atomically, recording `llm_scope_id` only when the claim removed that scope's final association. Serialized sweeps retry queued recording-directory and telemetry deletion until both succeed, then acknowledge the work, so a crash or failed unlink cannot lose cleanup intent and mutable retention state cannot suppress the retry. Submission deletion does not participate in this decision: a surviving recording keeps its referenced telemetry even if one or more attributed submission rows have been deleted. A live scope normally has one recording. A run scope remains while any recording from that run survives. Cached SQLite handles close before unlinking a file, and a claim succeeds only after the teardown barrier for the live session or every session contributing to the run scope has blocked admission, aborted or drained active requests, and awaited reservation finalizers.

After the session teardown barrier resolves, live-session teardown may aggregate final usage and delete an empty scope file or a scope file whose session produced no recording. A terminal workflow run awaits the same barrier for every contributing session before final aggregation and may then delete its scope file when the run produced no retained recording. Files referenced by retained recordings follow the recording-deletion rules above.

A startup sweep runs after active session and workflow recovery. It removes official `data/llm/*.sqlite` files with no surviving recording row whose `llm_scope_id` names that file. It never descends into `data/llm/development/`, whose season ledgers follow their own retention. The recording endpoint has no dependency on development ledgers.

## Participant development API

Development discovery, key creation, and completion calls treat a season as eligible only while its submission window is open and LLM access is effective. Summary, call-history, and operator read routes remain identity-gated after a season closes, so past ledgers stay reachable from submission-history rows.

Add three active-user routes:

| Route | Response |
| --- | --- |
| `GET /api/llm-development/seasons` | Eligible seasons only, each with its label, environment, aliases and resolved cost weights, token budget and rate limit, weighted units used, informational successful-call count, and whether a key exists |
| `GET /api/seasons/:seasonId/llm-development` | Effective aliases with resolved cost weights, resolved limits, successful usage totals, whether any token total is estimated, remaining budget-unit allowance, and whether a key exists |
| `GET /api/seasons/:seasonId/llm-development/calls?cursor=<id>&limit=<n>` | The authenticated participant's successful ledger rows, including token counts, `usage_estimated`, and budget cost units derived under the selected season's current resolved weights, in reverse chronological order |

Discovery returns a direct array. The participant summary is an object carrying `season_id`, `models`, `cost_weights`, `limits`, `usage_by_model`, `successful_calls`, `usage_estimated`, `budget_cost_units_used`, `budget_cost_units_remaining`, and `key_exists`. History returns `{ calls, next_cursor }`; `next_cursor` is the final returned insertion ID when another page exists and `null` on the last page. Limits are integers from 1 through 100, with 25 as the default.

At most one eligible season exists per environment because only one season's submission window can be open. My Agents can therefore render its current row meter from the discovery response without another summary request. Discovery resolves configuration without creating or rotating a key.

Development usage follows the current season policy, so each call row's `budget_cost_units` uses the same current resolved weight as the summary. The calls response includes the stored estimate flag and full request and completion bodies because the ledger is private to that participant and operators. It serves closed seasons, omits internally stored latency, and uses bounded cursor pagination. Another participant cannot select a user ID or retrieve the ledger.

`GET /api/admin/seasons/:seasonId/llm-development` returns a direct array of participant totals. `GET /api/admin/seasons/:seasonId/llm-development/users/:userId/calls?cursor=<id>&limit=<n>` returns the same `{ calls, next_cursor }` envelope as participant history for the selected user. Totals include `user_id`, informational `successful_calls`, `usage_estimated`, `budget_cost_units_used`, and `budget_cost_units_remaining`. Detail rows expose the same token, estimate, current-policy budget-cost, request, and completion fields as participant history and remain readable after the season closes. Both routes use the existing admin guard, and the explicit target user is accepted only after authorization.

## Tests

Backend tests cover:

- Anonymous, non-owner, one-slot owner, multi-slot owner, and operator responses from the recording endpoint.
- Deleting an attributed submission preserving the recording and referenced telemetry file, masking request and completion bodies from the former owner, preserving public metadata, and retaining operator body access.
- SQLite row decoding, insertion ordering, null setup ticks, estimated-usage flags, stored cost weights, exact per-row and whole-recording budget cost units, and durable recording-association lookup.
- Successful empty payloads for recordings without a telemetry association and associated sessions with no successful rows, plus `telemetry_unavailable` for missing, unreadable, unsupported, or incomplete associated telemetry.
- Official telemetry `user_version` handling, new writes copying the grant-resolved price, and legacy rows without an authoritative price basis never being repriced from current configuration.
- Telemetry lookup continuing after producing session or workflow rows are pruned.
- Deleting a live recording removing its scope file, deleting one run recording preserving the shared file, and deleting the last run recording removing it only after the teardown barrier settles active requests and reservations.
- Live and terminal workflow scopes with no recording being deleted at their lifecycle boundary without a late telemetry write.
- Startup orphan cleanup leaving season development ledgers untouched.
- Eligibility-filtered development-season discovery, summaries with resolved cost weights, and pagination scoped from authenticated identity without key creation or rotation.
- Participant and operator summary and call-history reads remaining available after submissions close.
- Anonymous, pending, banned, and cross-participant development-ledger access rejection.
- Operator list and detail access.
- Development calls used, weighted budget totals, and estimate flags matching successful ledger rows and remaining independent from official execution-scope SQLite and board data.

The Docker integration coverage in Step 7 exercises these routes against the full stack.

## Done when

- Public recording telemetry responses expose only successful-call model, token, estimate, tick, slot, stored cost weight, and authoritative budget cost units, plus the whole-recording total. They do not expose latency.
- Ordinary and zero-success recordings return a successful empty telemetry payload, while broken associated telemetry returns `telemetry_unavailable`.
- Request and completion bodies reach only operators and owners with a surviving authoritative submission row. Every other caller, including a former owner after submission deletion, receives no bodies.
- Recording deletion, session and workflow teardown, and the startup sweep remove telemetry files exactly when no surviving recording references them, and development ledgers are never touched.
- Participants can discover only submission-open, LLM-enabled seasons and read only their own development summary and successful rows. Closed-season ledgers remain readable. Discovery includes resolved cost weights, limits, usage, and key state without rotating a key. Operators can read every participant's totals and rows for a season.
- Backend authorization and retention tests pass.
