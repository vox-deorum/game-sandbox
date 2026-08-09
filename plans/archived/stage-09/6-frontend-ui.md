# Stage 9.6: LLM Usage UI

Status: complete.

Part of [Stage 9](../stage-09-llm-gateway.md), build-order step 6. Replay and development surfaces read the APIs from [step 5](5-frontend-api.md). Automated-board data comes from [step 4](4-usage-aggregation.md), and development-key creation and rotation come from [step 2](2-enablement-keys-and-network.md). Server-side response filtering is the authorization boundary. Client-side display conditions control presentation only.

## Outcome

Public replays and automated boards show successful official model use as compact budget-cost summaries. Replay decisions are the canonical place to inspect recording calls. Authorized submission owners and operators can open the full accepted request and canonical response from the replay. Participants can manage a development key and inspect their private season meter and successful-call history. Operators can inspect development usage for any participant in a season.

The hands-on check compares anonymous, submission-owner, participant, and operator views in the browser.

## Replay decisions and cost

`ReplayPage.vue` fetches recording telemetry alongside the recording and passes it into the existing `DecisionLog`. A successful empty payload means the recording has no successful model calls, so recordings from before this stage and runs with no model use still load normally.

The existing decision rail remains beside or below the renderer, with no separate model-calls panel. Replays without chat use `DecisionLog`; chat-bearing replays use the existing interleaved `GameThread`. When environment metadata declares LLM capability, `DecisionLog` shows an `LLM cost` column immediately beside `Decision`, uses the same cost details and inspector, and sums successful calls whose tick and slot match that decision. A row with no matching calls uses the standard `None` value used by the existing data tables. Environments without LLM capability omit the `DecisionLog` column. `GameThread` remains unchanged.

Null-tick calls arrive through a separate setup-cost input, not as synthetic `DecisionEntry` values. `DecisionLog` renders them in a leading setup row group ordered by slot, with stable row IDs in the form `setup:<slot>`. The original decision entries, their keys, and the replay state's index-to-decision mapping remain unchanged. Active-row highlighting, `aria-current`, and automatic scrolling target decision rows only, so one or many setup rows never shift the row selected by the replay scrubber.

The displayed value is the stored weighted cost. The frontend never recomputes historical cost from current prices. Reasoning tokens are a reported subset of output tokens and are not charged a second time.

```text
Player   Tick    Decision                         LLM cost
Player 1 Setup   Setup                            1,080
Player 1 12      {"card":"QS"}                    4,248
Player 2 12      {"card":"3C"}                    None
Player 1 13      {"card":"7H"}                    920
```

Each populated cost cell has an accessible details tooltip. Its trigger is reachable by keyboard, has a descriptive accessible name, reveals the details on hover and focus, and makes the same details available on touch. The details contain:

- Total successful call count for that tick and slot.
- Model tier and successful call count for every contributing tier.
- Each call's stored cost weight in budget units per token.
- The authoritative input-plus-output token basis used for charging, with reasoning tokens shown separately as an output-token subset.
- Each call's authoritative stored budget cost and the grouped authoritative budget cost.

The details display the API's stored weight, token basis, and authoritative cost values. They never derive an old call's cost from current configuration.

The trigger and tooltip content have a programmatic association. The tooltip stays open while the pointer moves between trigger and content, opens while its trigger has keyboard focus, closes on Escape, and does not move focus. A metadata-only trigger toggles the same content by touch. These requirements apply whether the interaction remains a feature component or becomes a primitive.

When the API includes authorized `request` and `completion` bodies, the populated cost value is also the inspector trigger. Click, Enter, or Space opens an existing `UiDialog`-based call inspector. On touch, opening that dialog exposes the same cost details. The dialog lists every matching call and uses the exact action label `Inspect request and response`; it renders the API's `request` field under `Request` and its `completion` field under `Response`. It uses one disclosure level per call when the content is long. Dialog focus follows the existing `UiDialog` trap and returns to the cost trigger when the dialog closes.

When bodies are absent, the cost cell provides metadata details only and has no inspector action. The frontend never infers authorization from attribution or ownership data. It renders only body fields returned by the server. This preserves operator inspection on the replay after an attributed submission is deleted, while a former owner sees metadata only. Agent profiles keep their normal recording links and do not add a second prompt inspector.

Unsuccessful logical requests have no telemetry row, so the decision log renders no failure status for them.

A `500 telemetry_unavailable` response means associated retained telemetry is broken or unreadable, not empty. The recording and game still load. `ReplayPage` shows a visible danger `UiEmptyState` with the exact message `LLM cost data unavailable.` `RunMetadata` omits its LLM cost total. In an LLM-capable environment, every decision-row cell in the `LLM cost` column says `Unavailable` instead of `None`. No setup-cost rows are invented when their source data is unavailable. The frontend never normalizes this response to empty telemetry.

## Replay metadata

`RunMetadata` adds one quiet whole-recording fact:

```text
Seed 4821 · Ticks 96 · Owner ada · Created May 3, 2026 · LLM 41.6k units
```

The cost uses the recording's stored total. Its accessible tooltip shows successful call and tier counts, stored cost weights, the input-plus-output token basis, reasoning tokens as an output-token subset, and authoritative budget costs. These details stay out of the main metadata strip so the game stage remains visually primary. The summary does not show model latency.

## Automated-board model usage

`AutomatedBoardRow` carries `llm_usage_by_model` and `llm_weighted_cost` from Step 4. `LeaderboardBoards.vue` adds an `LLM usage` column beside agent compute on the automated board only. Each row stays to one scan line:

```text
#  Agent       Mean score   Agent compute   LLM usage                                    Games  Replay
1  hearts-bot  -3.2 +/- 1.1 212 +/- 40 ms   41.6k units                                  20     View
2  baseline    -6.8 +/- 0.9 3 +/- 1 ms      None                                         20     View
```

The human-feedback board has no model-usage column. Model usage remains informational and does not affect rank. The existing narrow-screen table behavior keeps every column reachable without turning the model summary into a stacked block.

## Participant development access

Development access is scoped to the current submission-open season for an environment. It appears only when that season has effective LLM access.

### My Agents

The current-season row shows a compact development usage meter with weighted budget units used against the season token budget. The meter always includes a text value. A small key-management button is layered above the full-card `RouterLink` using the established SeasonsPage action pattern, so activating the button does not follow the row link. At most one eligible row exists per environment.

### Agent profile

The owner sees a **Development access** section above Submission History. It has no season selector. It shows available model tiers with price multipliers, the usage meter with used and remaining budget units, key creation or rotation, and a **View call history** action. The section is absent when there is no eligible season. Past-season call history remains reachable from a **View call history** action inside each expanded submission-history row.

Creating a first key calls the Step 2 endpoint directly. Rotating an existing key first opens a confirmation dialog that warns the current key will stop working immediately while accumulated usage remains. Only explicit confirmation sends the rotation request.

A successful create or rotate opens a one-time credential dialog. `OPENAI_BASE_URL` and `OPENAI_API_KEY` appear in full in read-only monospace fields. Each field has a Copy button, and **Copy .env** copies both assignments. Closing the dialog through any supported path clears the credential response and secret from reactive state. The frontend never writes the secret to persistent browser storage.

### Shared call history dialog

One shared `UiDialog` serves participant, submission-history, and operator entry points without nesting focus traps. Its reverse-chronological list shows date, model tier, input, reasoning, and output tokens, and weighted cost in budget units. It omits latency and estimate labels. **Load more** uses the Step 5 cursor.

Selecting a row swaps the dialog body to that call's detail: token detail, stored weight, authoritative cost, request under **Request**, and completion under **Response**. A **Back** control restores the list and its scroll position.

## Operator development usage

The season-management view shows a compact totals table with participant, informational calls used, budget units used, and budget units remaining. Selecting a participant row opens the shared call-history dialog. The page does not render a separate below-table detail region.

## Shared feature components and formatting

Keep formatting and behavior consistent through feature components rather than page-local markup:

- A shared LLM cost formatter owns compact numbers and the `units` label.
- A shared cost-details presentation owns call and tier counts, token bases, stored cost weights, and authoritative costs. Replay decisions and run metadata use its tooltip form. Automated-board rows use its `By model` disclosure with the per-tier data Step 4 persists.
- A shared request-and-response presentation keeps the exact `Request` and `Response` headings, code treatment, long-content wrapping, and copy behavior consistent between the replay and call-history dialogs. Its replay action label is always `Inspect request and response`.
- A shared development call-history dialog owns list and detail navigation, scroll restoration, row formatting, pagination, and empty states. Callers supply the authorized data and loading actions.

The cost tooltip is an approved interaction pattern for this feature. Whether it is a feature component or primitive, it must programmatically associate trigger and content, remain open when the pointer crosses from trigger to content, open from keyboard focus, close on Escape, leave focus on its trigger, support touch access, and avoid relying on the HTML `title` attribute alone. If implementation promotes it to a reusable `UiTooltip` primitive, that primitive also needs typed props and emits and examples for every variant on `/styleguide` in the same change.

All styling uses semantic tokens and existing primitives. Add a read-only `UiMeter` with typed `value`, `max`, and required text-value props. Color is never its only indicator. Add its semantic-token styles, tests, `/styleguide` example, and row in the living primitive inventory at `docs/contributors/frontend/design-system.md` with its first use.

## Tests

Frontend unit tests cover:

- Replay telemetry grouping by exact tick and slot, multiple calls in one cost cell, a separate setup-cost input, multiple setup slots with stable `setup:<slot>` row IDs, the standard `None` value for successful empty telemetry in capable environments, and omission of the cost column in incapable environments.
- Setup rows leaving `DecisionEntry[]`, decision keys, replay current-index mapping, active-row highlighting, and active-row scrolling unchanged, including the correct scrubbed decision row with several setup rows present.
- Chat-bearing replays retaining interleaved messages while showing setup costs, exact tick-and-slot costs, unavailable states, and authorized inspection.
- A `500 telemetry_unavailable` response leaving the recording and game usable, showing the danger `LLM cost data unavailable.` state, omitting the `RunMetadata` total, and never appearing as empty telemetry. In a capable environment, `DecisionLog` cost cells show `Unavailable`.
- Cost formatting in explicit budget units and tooltip details for calls, tiers, stored weights, input-plus-output token bases, reasoning tokens, and authoritative costs. No Stage 9 surface displays estimate wording.
- Every cost tooltip implementation programmatically associating trigger and content, persisting across trigger-to-content hover, opening from keyboard focus, closing on Escape without moving focus, and exposing the same details on touch.
- Replay inspector opening by click, Enter, and Space when authorized bodies exist; the exact `Inspect request and response` action and `Request` and `Response` headings; metadata-only behavior for masked responses; focus restoration; and operator body access when the attributed submission no longer exists.
- Whole-recording cost details in `RunMetadata`, without call latency.
- Automated-board one-line summaries, multiple-tier details, explicit budget units, empty usage, unchanged ranking, and absence from the human-feedback board.
- My Agents eligible and ineligible current-season rows, layered key action behavior, and meter text values.
- Agent-profile Development access presence and absence, available model tiers, meter values, and past-season history actions.
- Key creation, rotation confirmation and cancellation, immediate-invalidation warning, read-only full credentials, field Copy actions, `Copy .env`, one-time secret behavior, and secret-state clearing through every dialog close path.
- Shared call-history list and detail navigation, cursor pagination, Back behavior, scroll restoration, and a single focus trap.
- Operator totals and participant-row activation opening the shared call-history dialog.
- `UiMeter` typed props, required text value, accessibility, semantic-token styling, and `/styleguide` coverage.
- A promoted `UiTooltip`, if used, additionally has a typed interface and `/styleguide` examples.

Playwright coverage in Step 7 exercises anonymous, owner, former-owner, participant, and operator journeys against the full backend. It verifies the live DOM and locators for the replay `LLM cost` column, unavailable-telemetry state, tooltip behavior, `Inspect request and response` action, `Request` and `Response` dialog headings, My Agents meter and layered key action, agent-profile access, credential rotation and copying, shared history dialog, operator row activation, narrow-screen tables, keyboard operation, and masked body fields.

## Done when

- Replay decisions are the canonical recording-call view. LLM-capable environments show stored cost in budget units beside each decision, a separate setup-cost row group that does not alter replay indexing, accessible cost details, and no separate model-calls panel or agent-profile debug inspector. Incapable environments omit the cost column.
- Empty telemetry in an LLM-capable environment displays `None`. `telemetry_unavailable` leaves the replay usable, displays a danger state, and omits the recording total. In an LLM-capable environment, `DecisionLog` cells display `Unavailable`.
- Anonymous viewers see metadata only. Authorized current owners can inspect bodies for their slots, former owners cannot inspect bodies after submission deletion, and operators retain replay inspector access.
- `RunMetadata` shows one quiet whole-recording LLM cost with optional call and token details.
- Automated-board rows show one-line model-use summaries with per-tier details, explicit budget units, and no effect on rank. The human-feedback board remains unchanged.
- My Agents shows a text-backed development meter and layered key action on eligible current-season rows. The agent profile shows owner-only current-season access and past-season history actions.
- Participant and operator call histories use one shared list-and-detail dialog with no nested focus trap. Operator rows open that dialog directly.
- `UiMeter` joins the design system with typed props, semantic-token styling, accessibility coverage, and a styleguide example.
- No Stage 9 UI surface displays estimate labels.
- No Stage 9 UI surface displays model-call latency.
- Frontend unit tests, accessibility checks, and the Step 7 Playwright journeys pass.
