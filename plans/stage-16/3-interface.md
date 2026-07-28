# Stage 16.3: Play, Rate, Watch, and admin interface

Status: not started.

Part of [Stage 16](../stage-16-named-builtins.md), build-order step 3.

## Outcome

The website displays every named builtin, makes the restricted-seat rule obvious in all session flows and in season matchup editing, and keeps each seat's player count directly under its label.

## Session flows

The environment page, `WatchAgentPicker.vue`, and `SeatAssignmentDialog.vue` receive resolved seats and declared builtins from environment metadata. The top-level picker renders one keyed row per declared builtin in place of its single hardcoded Naive row. Every agent option uses the builtin's stable name as its value and its display label as its text.

- **Play:** a human-capable restricted seat starts as Human, and its only alternative is the designated builtin. If the user sits in another capable seat, the restricted seat returns to its builtin. A restricted seat with no human-capable player is a locked builtin assignment. A wide restricted Human seat shows the derived builtin as explanatory text and offers no companion picker.
- **Watch:** the restricted seat is locked to its designated builtin. Every unrestricted seat keeps the ordinary builtin and submission choices.
- **Rate:** the intended agent fills every unrestricted seat. A human-capable restricted seat starts as Human and exposes the only enabled assignment choice, Human or its designated builtin. A non-human-capable restricted seat is locked to its builtin. Parameters, seed, timeout, and unrestricted assignments stay locked.

Rate places the intended agent in unrestricted seats only, so `WatchAgentPicker.vue`, the dialog prefill, payload assembly, and the frontend API types all read the resolved restriction. Metadata guarantees at least one unrestricted seat, so a restricted layout always opens the multi-seat dialog and always has somewhere legal to put the intended agent. The single-seat direct Watch and Rate path stays valid for player-bounds layouts and one-seat plans, which the same guarantee keeps unrestricted.

Rate disables each locked parameter and each locked assignment control individually rather than disabling the enclosing fieldset, so the restricted seat's Human-or-builtin choice stays interactive.

The server remains authoritative. Frontend filtering is presentation, not the only enforcement.

## Seat heading layout

Every row uses a two-line heading in the left grid column:

```text
Seat 1        [Naive agent                 ]
2 players
```

`SeatAssignmentDialog.vue` moves `.player-count` out of `.seat-control`, whose `flex-wrap` is what pushes the count under the selector today, and into a heading wrapper below `.seat-label`. Two constraints come with the move:

- The `id` that the seat's `aria-labelledby` points at stays on the `Seat N` text rather than moving to the new wrapper, so a seat's accessible name does not become `Seat 1 2 players`.
- `.seat-row` is `grid-template-columns: auto minmax(0, 1fr)`, so the heading column would otherwise size to the longest count string and shift the selectors between a `1 player` seat and a `10 players` seat. The heading column takes a fixed minimum width.

The right column continues to hold the assignment control and, where applicable, the companion field beneath it. The layout applies in Play, Watch, and Rate, at narrow and wide viewports, for singular and plural counts. It uses the existing semantic tokens and UI primitives, and the style guide changes only if a new primitive variant turns out to be needed.

## Admin matchup editor

`SeasonConfigEditor.vue` builds each match-seat selector from `submission` plus every declared `builtin:<name>`, replacing its current iteration over the fixed `SEAT_SPECS` array. The display text uses builtin labels, such as `Scripted hero`, while the saved string stays `builtin:scripted_hero`.

Once the selected parameters resolve a seat plan, the restricted seat's selector is set to its designated builtin and disabled. The row keeps all resolved seats and their canonical numbering. Changing `seat_plan` rebuilds the row when its width or its restriction changes, then validates before save.

For a three-seat plan restricted at `seat_0`, the editor shows:

```text
Seat 1: Scripted hero (locked)
Seat 2: Submission
Seat 3: Submission
```

Projection copy keeps its existing seating and baseline concepts, because the scheduler arithmetic is unchanged.

## Attribution

Live standings, replay lists, rating forms, automated boards, human-feedback boards, and run details display the label belonging to the named builtin. Live pages may resolve the label from current metadata. Replays use only the snapshotted recording label. The blind-label rule continues to apply to submissions, not to builtins.

## Specification

- [Frontend](../../docs/specs/frontend.md) defines Play, Watch, Rate, the editor, the labels, and the two-line seat heading.
- [Interaction](../../docs/specs/interaction.md) defines the default Human placement and the restricted wide-seat presentation.

## Tests

- jsdom tests cover one top-level picker row and a stable key per declared builtin, plus named builtin option values and labels in unrestricted dialog seats. Each builtin's Watch action is clicked and must prefill and emit that builtin's own name, including an unrestricted seat beside a restricted seat designated for a different builtin.
- Play tests cover the Human default, switching the restricted seat to its builtin, moving the human elsewhere, a non-human-capable restriction, and a wide restricted seat with no companion picker.
- Watch tests prove the restricted assignment is locked and unrestricted seats stay editable.
- Rate tests prove the intended agent fills only unrestricted seats and that only the Human or designated-builtin control remains enabled.
- Seat layout tests assert that `Seat X` and its player-count hint share one heading wrapper and that the hint is absent from the control wrapper, for singular and plural counts. One test asserts the select's accessible name is still `Seat X` alone.
- Admin tests cover every named builtin choice, a locked restricted seat, full-width match rows, plan changes, saved compact strings, validation messages, and unchanged projected totals.
- Backend and jsdom fixtures supply the restricted-seat metadata, since no shipped environment restricts a seat yet. Spades' second builtin covers the multi-builtin pickers and labels against a real environment.
- A narrow-viewport Playwright assertion on an existing multi-seat environment confirms `X players` stays beneath `Seat X` rather than wrapping beneath the selector. The existing browser journeys remain regression coverage for Play, Watch, Rate, and admin scheduling.
- `uv run python scripts/ci.py frontend-e2e` passes after the interface changes.
