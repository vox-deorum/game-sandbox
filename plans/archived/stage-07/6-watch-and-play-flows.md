# Stage 7.6: Watch Multi-Agent Dialog and Play-With-Agents

Status: done.

Part of [Stage 7](../stage-07-multi-agent.md), build-order step 6. The shared seat grid composes sessions for Play, Watch, and Rate. It depends on the session-start contract and uses the seat model defined in [Frontend](../../../docs/specs/frontend.md#watch-and-play-flows).

## Shared seat configuration

`SeatAssignmentDialog.vue` uses `UiSelect` for every seat, including the human seat. `EnvironmentPage.vue` opens it for multi-seat Play; `WatchAgentPicker.vue` opens it for multi-seat or configurable Watch and Rate. A single-seat watch with no visible settings starts immediately. Single-seat Play uses `StartForm`.

The entry action determines the initial assignments:

- Play starts the human in a human-capable restricted seat, or the first human-capable seat otherwise. Other unrestricted seats start with Naive.
- Watch preselects the clicked agent in every unrestricted seat and uses each restricted seat's designated builtin.
- Rate preselects the clicked agent in every unrestricted seat and locks it in the last one. Other seats stay editable. A human-capable restricted seat starts with You. Season settings remain locked.

Every editable human-capable seat offers You. Selecting it moves the sole human controller and restores the old seat to Naive or its designated restricted builtin. Selecting an agent in the human seat permits an all-agent session. Restricted seats offer only You, when capable, and their designated builtin.

Wide human seats retain their companion choices and validation. Changing the layout clears a human assignment that no longer fits and removes stale companion choices. Start requires a valid assignment for every resolved seat and any required companion.

The button reads `Start playing` when a human is seated and `Start watching` otherwise. Human timing controls follow the assignment; Rate keeps the timeout locked and omits an override from the request. The explicit `seats` payload uses resolved seat IDs, such as `seat_0`, and includes the season identifier and complete gameplay parameters.

## Agent labels and starting

Builtin options display declared labels and use stable names as values. Operator submission labels show the readable owner name, or `shortId(submission_id, 8)` when unavailable, followed by the source suffix. This operator label also applies to the operator's own agent. Other viewers see anonymous `Agent N` labels or `Your agent` for their own submission. The full submission ID remains the option value and payload identity.

Start actions show their pending state and reject duplicate submissions. A failed start preserves the configuration and shows the error. Active-session conflicts use the shared session-replacement flow.

## Ratings and verification

Ratings apply per agent in a shared session, whether the viewer watched or played. Existing backend recording attribution supplies those identities.

The jsdom tests cover defaults, You selection and movement, returning to watching, restricted-seat options, companion choices, layout changes, timing controls, rating-target locks, labels, complete payload IDs, and start failures. Picker and page tests verify the entry flows and session navigation. The Spades browser journey selects You in a rating session, starts a real container, and submits a move through the canvas.

The frontend check and test suites, strict documentation build, and full browser suite verify this flow.
