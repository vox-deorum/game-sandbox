# Stage 7.6: Watch Multi-Agent Dialog and Play-With-Agents

Status: done. The frontend now builds the step-4 `slots` payload: `startSession`/`StartSessionInput` in `frontend/src/api/client.ts` send an explicit per-slot `slots` object keyed by `player_N` (no derived `mode`, no single `submission_id`). A shared seat grid (`frontend/src/components/SeatAssignmentDialog.vue`, on a new `UiSelect` primitive) drives both flows. In watch mode, clicking any agent row, Naive or submitted, preselects that agent into every seat and lets the user change each seat. In play mode, seat 0 is the human, the rest default to the Naive baseline, and a per-row "Sit here" button moves the single human seat. There is no empty seat state. Every non-human seat always holds a concrete agent, so Start stays enabled and the emitted payload always covers exactly the required seats. Operator dropdowns identify a submission by its readable owner name when available and otherwise by `shortId(submission_id, 8)`, followed by the unchanged source suffix. The complete submission ID remains the option identity and the value sent in the session payload. Anonymous non-operator labels remain "Agent N", never "Submitted agent N". `WatchAgentPicker.vue` opens the dialog for a multi-seat environment and keeps the Stage 5 immediate one-seat start for single-slot Flappy Bird; `EnvironmentPage.vue` routes play through the seat grid for Hearts and the minimal `StartForm` for Flappy Bird. Per-agent ratings in a shared session already work through the recording-`players` attribution in `backend/src/ratings/routes.ts` (verification only, no backend change). jsdom tests cover the new dialog (preselection, changing an assignment, operator labels, complete submission IDs in values and payloads, the contract payload, and play seat-claiming), the reworked picker/page flows, the `slots` wire shape, and a four-seat shared-session per-agent rating view; `npm run check` and the full vitest suite pass with no Docker.

Part of [Stage 7](../stage-07-multi-agent.md). This is build-order step 6. It builds the frontend flows that assign agents to every seat of a multi-agent session and send the `slots` payload from step 4. It depends on the start contract (step 4). The flow logic is Docker-free and unit-testable in jsdom; the end-to-end journey is covered by step 8.

## Why this is its own seam

The start contract (step 4) defines the payload; this step is the human-facing surface that builds it. Building the watch multi-agent flow from [frontend.md](../../docs/specs/frontend.md) as a replacement for the Stage 5 single-agent watch start, not as a compatibility layer, keeps the seat-assignment UI and the session payloads expressed as slot assignments, which is what later multi-human play will extend.

## Watch configuration dialog

Any agent row, built-in or submitted, opens the same watch configuration dialog. It replaces and extends `frontend/src/components/WatchAgentPicker.vue` and the entry points on `frontend/src/pages/EnvironmentPage.vue`. The dialog:

- Preselects the clicked row for its relevant seat, while letting the user change the assignment before starting.
- Assigns one agent to every required seat.
- Offers the built-in Naive agent anywhere a baseline agent is allowed.
- Lists active `ready` submissions for compatible submitted-agent seats.
- Labels each operator-visible submission as `<owner_name> · <source>` when a readable owner name is available, or `<shortId(submission_id, 8)> · <source>` otherwise. This operator branch takes precedence over the `rating_status === 'own'` branch so an operator's own submissions remain identified. Non-operator anonymous labels use "Agent N", not "Submitted agent N".
- Uses the complete `submission_id` for option keys and values, preselection, decoding, and emitted session payloads. Shortening applies only to the missing-name operator label.
- Collects the random seed.
- Includes the same supported session overrides that already exist for live starts.
- Enables the Start action only when all required seats are assigned.

## Play-with-agents

Extend play-with-agents so that, for this stage, the connected human picks any of the four seats, all human-capable in the Hearts metadata (step 1), and submitted agents fill the remaining slots. This stage composes exactly one human slot, which start validation (step 4) enforces. Express the UI and session payloads as slot assignments, so later multi-human play can attach more connected users. Extend `startSession` and `StartSessionInput` in `frontend/src/api/client.ts` to send the `slots` object instead of a single `submission_id`.

## Leaderboard and ratings

Verify the leaderboard workflow on multi-agent match configurations. A season's match configuration declares slot shapes, not concrete opponents; the scheduler (step 3) expands it over the trigger-time `ready` submissions, so it is the resolved scheduled games and their rating attribution that name the concrete opposing submissions. Ratings apply per agent in shared sessions. This reuses the Stage 6 board and rating machinery against the multi-seat schedule from step 3; the per-agent rating attribution in a shared session is the new behavior to confirm.

## Tests

Vitest, jsdom, mocked fetch, no Docker, no canvas:

- The watch dialog preselects the clicked agent row for its seat and keeps Start disabled until every required seat is assigned.
- Changing a preselected assignment before Start works.
- An operator-owned submission with `owner_name` displays the readable name even when its rating status is `own`.
- An operator option without `owner_name` displays `shortId(submission_id, 8)`, not a shortened `owner_id`, using fixtures whose long owner and submission IDs have distinct prefixes.
- Neither complete identifier appears in the missing-name option's visible text or accessible name, while its option value, preselection, decoding, and emitted start payload retain the complete `submission_id`.
- Anonymous non-operator options use "Agent N" labels.
- A multi-agent session produces per-agent rating rows in a shared session, attributed to the right agents.
- The `slots` payload built by the frontend matches the step 4 contract.

## Done when

Clicking any agent row, built-in or submitted, opens the same watch configuration dialog with that agent preselected and changeable. The dialog assigns an agent to every required seat, offers Naive where a baseline is allowed, lists `ready` submissions for compatible seats, collects a seed, and enables Start only when all required seats are assigned. Operator options show the readable owner name and source when available, otherwise the first eight characters of the submission ID and source, while the complete submission ID remains unchanged in selection state and session payloads. The operator label branch also applies to the operator's own submissions. Anonymous non-operator options remain labeled "Agent N". Play-with-agents lets a human pick a slot while submitted agents fill the rest, with payloads expressed as slot assignments. The leaderboard workflow runs over multi-agent match configurations and ratings apply per agent in shared sessions. The jsdom tests above pass.
