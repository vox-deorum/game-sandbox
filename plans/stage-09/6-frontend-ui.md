# Stage 9.6: LLM Usage UI

Status: not started.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 6. Replay and development surfaces read the APIs from [step 5](5-frontend-api.md). Automated-board data comes from [step 4](4-usage-aggregation.md), and development-key creation and rotation come from [step 2](2-enablement-keys-and-network.md). Server-side response filtering is the authorization boundary. Client-side display conditions control presentation only.

## Outcome

Public replays and automated boards show successful official model use as compact budget-cost summaries. Replay decisions are the canonical place to inspect recording calls. Authorized submission owners and operators can open the full accepted request and canonical response from the replay. Participants can manage a development key and inspect their private season meter and successful-call history. Operators can inspect development usage for any participant in a season.

The hands-on check compares anonymous, submission-owner, participant, and operator views in the browser.

## Replay decisions and cost

`ReplayPage.vue` fetches recording telemetry alongside the recording and passes it into the existing `DecisionLog`. A missing telemetry association or a recording with no successful calls is normalized to empty telemetry, so recordings from before this stage and runs with no model use still load normally.

`DecisionLog` remains the one data rail beside or below the renderer. It gains an `LLM cost` column immediately beside `Decision`; there is no separate model-calls panel. Each normal row sums the successful calls whose tick and slot match that decision. Calls with a null tick are grouped by slot into leading synthetic rows labelled `Setup`, before the numbered decision rows. A row with no matching calls uses the standard empty value used by the existing data tables.

The displayed value is the stored weighted cost, formatted with the explicit unit `budget units`. The frontend never recomputes historical cost from current prices. Reasoning tokens are a reported subset of output tokens and are not charged a second time.

```text
Player   Tick    Decision                         LLM cost
Player 1 Setup   Setup                            1,080 budget units
Player 1 12      {"card":"QS"}                  4,248 budget units
Player 2 12      {"card":"3C"}                  None
Player 1 13      {"card":"7H"}                  920 budget units
```

Each populated cost cell has an accessible details tooltip. Its trigger is reachable by keyboard, has a descriptive accessible name, reveals the details on hover and focus, and makes the same details available on touch. The details contain:

- Total successful call count for that tick and slot.
- Model alias and successful call count for every contributing alias.
- Input, reasoning, and output token totals.
- A visible `Estimated` label for every call whose usage was estimated.
- `Includes estimates` when a grouped total contains at least one estimated call.

When the API includes authorized request and completion bodies, the populated cost value is also the inspector trigger. Click, Enter, or Space opens an existing `UiDialog`-based call inspector. On touch, opening that dialog also exposes the tooltip's metadata. The dialog lists every matching call and presents its accepted request and canonical response together under clear headings. It uses one disclosure level per call when the content is long.

When bodies are absent, the cost cell provides metadata details only and has no inspector action. The frontend never infers authorization from attribution or ownership data. It renders only body fields returned by the server. This preserves operator inspection on the replay after an attributed submission is deleted, while a former owner sees metadata only. Agent profiles keep their normal recording links and do not add a second prompt inspector.

Unsuccessful logical requests have no telemetry row, so the decision log renders no failure status for them.

## Replay metadata

`RunMetadata` adds one quiet whole-recording fact:

```text
Seed 4821 · Ticks 96 · Owner ada · Created May 3, 2026 · LLM cost 41.6k
```

The cost uses the recording's stored total. Its accessible tooltip may show successful call count, input, reasoning, and output token totals, plus `Includes estimates` when applicable. These details stay out of the main metadata strip so the game stage remains visually primary. The summary does not show model latency.

## Automated-board model usage

`AutomatedBoardRow` carries `llm_usage_by_model` and `llm_weighted_cost` from Step 4. `LeaderboardBoards.vue` adds a `Model usage` column beside agent compute on the automated board only. Each row stays to one scan line:

```text
#  Agent       Mean score   Agent compute   LLM usage                                    Games  Replay
1  hearts-bot  -3.2 +/- 1.1 212 +/- 40 ms   18 calls · 41.6k units                       20     View
2  baseline    -6.8 +/- 0.9 3 +/- 1 ms      None                                         20     View
```

The token summary is input plus total output tokens. An accessible tooltip or disclosure supplies the per-alias breakdown with successful call count and input, reasoning, and output tokens. Each alias with estimated calls has a visible `Estimated` label, and the one-line aggregate says `Includes estimates` when any alias includes them. The breakdown does not show latency.

The human-feedback board has no model-usage column. Model usage remains informational and does not affect rank. The existing narrow-screen table behavior keeps every column reachable without turning the model summary into a stacked block.

## Participant development access

`ProfilePage.vue` adds two sibling sections below the identity card. Configuration and credential actions live in `Development access`; potentially long usage data lives in `Call history`.

### Development access

The profile first loads the authenticated participant's seasons with effective development LLM access.

- No eligible seasons renders a clear empty state explaining that development access is not enabled for the participant's seasons.
- One eligible season shows its name as text and does not render a selector.
- More than one eligible season renders the existing field and select pattern.

The selected season card shows allowed model aliases, each alias's price multiplier once, and plain used and remaining values for both successful calls and weighted budget units. It uses no progress chart. Summary values use `Includes estimates` when applicable.

```text
Development access
Season  Season 3
Models  large 4x · medium 2x · small 1x
Calls   46 used · 154 remaining
Budget  18.2k budget units used · 81.8k remaining
        Includes estimates
[ Rotate key ]  A key exists for this season.
```

Creating a first key calls the Step 2 endpoint directly. Rotating an existing key first opens a confirmation dialog that says the current key will stop working immediately and accumulated usage will remain. Only the explicit confirmation sends the rotation request.

The successful create or rotate response opens a one-time credential dialog. `OPENAI_BASE_URL` and `OPENAI_API_KEY` appear in full in read-only monospace fields. Each field has a Copy button, and a `Copy .env` button copies both complete assignments. The dialog warns that the secret cannot be retrieved again. Closing by Done, Escape, the close control, or any other supported path clears the secret and credential response from reactive UI state. The frontend never writes the secret to persistent browser storage.

```text
Development key created
Copy these now. The key cannot be shown again.

OPENAI_BASE_URL
[ https://sandbox.example.com/api/llm/v1 ] [ Copy ]

OPENAI_API_KEY
[ gs-dev-9f3a...                         ] [ Copy ]

[ Copy .env ]                                      [ Done ]
```

### Call history

Call history is a separately loaded, reverse-chronological, paginated table. Rows show date, model alias, input, reasoning, and output tokens, weighted cost in budget units, and a visible `Estimated` label where applicable. No latency is shown. Each row has one authorized `Inspect request and response` disclosure that presents both bodies under clear headings. `Load more` uses the cursor from Step 5 and preserves the currently selected season.

```text
Call history
Date        Model   Tokens                              Cost
May 6       large   1,204 in · 96 reasoning · 342 out  6,184 budget units
                    Estimated
  Inspect request and response
May 6       small   310 in · 40 out                     350 budget units
  Inspect request and response
[ Load more ]
```

Loading, empty, and API-error states use the existing `UiEmptyState` and action patterns. Changing the season clears rows and pagination state before loading the new summary and history.

## Operator development usage

The season-management view adds a `Development usage` section for the selected season. Its participant totals table stays compact and shows participant, successful calls used, weighted budget units used, remaining calls, remaining budget units, and `Includes estimates` where applicable. It does not show latency or place a call ledger inside a totals row.

`View calls` selects one participant and opens a separate detail region below the totals table. The region has a clear participant heading, close action, loading and empty states, and the same paginated call-history feature component used on the participant profile. Selecting another participant replaces that region's contents.

```text
Development usage
Participant  Calls used  Budget used  Remaining       Details
ada          46          18.2k units  154 / 81.8k     View calls
             Includes estimates
ben          12          3.1k units   188 / 96.9k     View calls

ada call history                                      [ Close ]
Date        Model   Tokens                              Cost
May 6       large   1,204 in · 96 reasoning · 342 out  6,184 budget units
                    Estimated
  Inspect request and response
```

## Shared feature components and formatting

Keep formatting and behavior consistent through feature components rather than page-local markup:

- A shared LLM cost formatter owns compact numbers and the full `budget units` label. It never uses a currency symbol or a bare number.
- A shared cost-details trigger owns call counts, alias and token breakdowns, `Estimated`, and `Includes estimates` wording. Replay decisions, run metadata, and automated-board rows configure the same feature behavior for their available data.
- A shared request-and-response presentation keeps the accepted request and canonical response headings, code treatment, long-content wrapping, and copy behavior consistent between the replay dialog and private histories.
- A shared development call-history table owns row formatting, the one request-and-response disclosure, pagination, estimate labels, and empty states. Participant and operator pages supply the authorized data and loading actions.

The cost tooltip is an approved interaction pattern for this feature. Its implementation must preserve keyboard, pointer, and touch access and must not rely on the HTML `title` attribute alone. It may remain a feature component. If implementation promotes it to a reusable `UiTooltip` primitive, that primitive needs typed props and emits, focused accessibility tests, and examples for every variant on `/styleguide` in the same change.

All styling uses semantic tokens and existing primitives. The call inspector and credential flows compose the existing `UiDialog`, `UiButton`, `UiField`, `UiInput`, and `UiEmptyState`. No other primitive or variant is planned. If implementation introduces one, it must follow the typed primitive, test, and `/styleguide` requirements in the same change.

## Tests

Frontend unit tests cover:

- Replay telemetry grouping by exact tick and slot, multiple calls in one cost cell, leading null-tick setup rows, the standard empty value, and recordings with absent or empty telemetry.
- Cost formatting in explicit budget units, call and token tooltip details, keyboard and touch access, visible row-level `Estimated` labels, and aggregate `Includes estimates` wording.
- Replay inspector opening by click, Enter, and Space when authorized bodies exist; request and response rendering together; metadata-only behavior for masked responses; focus restoration; and operator body access when the attributed submission no longer exists.
- Whole-recording cost and estimate details in `RunMetadata`, without call latency.
- Automated-board one-line summaries, multiple-alias details, estimated aggregates, explicit budget units, empty usage, unchanged ranking, and absence from the human-feedback board.
- Eligible development-season states for none, one, and many seasons; plain used and remaining values; one multiplier per alias; season changes; loading, empty, and API-error states; and absence of latency.
- Key creation, rotation confirmation and cancellation, immediate-invalidation warning, read-only full credentials, field Copy actions, `Copy .env`, one-time secret behavior, and secret-state clearing through every dialog close path.
- Participant call-history pagination, row estimate labels, one request-and-response disclosure, and season-reset behavior.
- Operator totals, estimate wording, participant selection, the separate detail region, detail replacement and closing, and reuse of the call-history behavior.
- Any new tooltip primitive's typed interface, focus and touch behavior, dismissal, and `/styleguide` examples.

Playwright coverage in Step 7 exercises anonymous, owner, former-owner, participant, and operator journeys against the full backend. It verifies the live DOM and locators for the replay cost column and dialog, credential rotation and copying, participant history, operator detail region, narrow-screen tables, keyboard operation, and masked body fields.

## Done when

- Replay decisions are the canonical recording-call view, with stored cost in budget units beside each decision, setup-call rows before numbered ticks, accessible cost details, and no separate model-calls panel or agent-profile debug inspector.
- Anonymous viewers see metadata only. Authorized current owners can inspect bodies for their slots, former owners cannot inspect bodies after submission deletion, and operators retain replay inspector access.
- `RunMetadata` shows one quiet whole-recording LLM cost with optional call, token, and estimate details.
- Automated-board rows show one-line model-use summaries with per-alias details, explicit budget units, and no effect on rank. The human-feedback board remains unchanged.
- Participant development access handles zero, one, or many eligible seasons; shows plain used and remaining values; and supports safe one-time key creation and rotation.
- Participant and operator call histories use one shared table and one request-and-response disclosure per call. Operator detail appears below the compact totals table.
- Every aggregate containing estimated usage says `Includes estimates`, and every estimated call row has a visible `Estimated` label.
- No Stage 9 UI surface displays model-call latency.
- Frontend unit tests, accessibility checks, and the Step 7 Playwright journeys pass.
