# Stage 16.3: Sessions and interface

Status: not started.

Part of [Stage 16](../stage-16-pinned-seats.md), build-order step 3.

## Outcome

Live sessions obey the pinned-seat rule: human if the person takes the seat, the designated builtin otherwise, never a submission. The seat dialog, the Rate flow, the season config editor, and every attribution label present pinned seats coherently, and the UI tests and journeys assert on the new behavior.

## Session validation and launch

`validateSeatShape` in `backend/src/session/orchestrator.ts` accepts exactly two assignments for a pinned seat: a human assignment when the seat is human-capable, or the designated builtin. A submission assignment fails with a 400 naming the seat. When a human takes a wide pinned seat, the companion is forced to the designated builtin rather than offered as a choice.

`SeatBinding` in `backend/src/session/launch-config.ts` carries the builtin name, and `assembleLaunch` expands a builtin-held pinned seat into per-player builtin bindings exactly as it expands the baseline today.

## Session flows

- **Play**: the seat dialog renders a pinned seat as a locked control naming the builtin's display label, with the Human option offered when the seat is human-capable and no submission choices. This is the proposed default treatment; confirm the presentation with the owner when work starts.
- **Watch**: a pinned seat is always the builtin and is not configurable.
- **Rate**: the locked configuration fills every unpinned seat with the intended agent; the pinned seat follows the play rule. The session actions table in [Frontend](../../docs/specs/frontend.md) changes from "intended agent in every resolved seat" to "intended agent in every unpinned seat".

## Interface

- `frontend/src/components/SeatAssignmentDialog.vue` renders the locked pinned row and the conditional Human toggle, built from existing field primitives and semantic tokens.
- `frontend/src/components/admin/SeasonConfigEditor.vue` offers the pinned option with a builtin picker on any seat, seeds and locks it for a metadata-fixed seat, and the schedule preview reflects the arithmetic from step 2.
- Standings, replay lists, and run detail label a pinned seat's builtin by its display label, with the existing blind-label rule applying only to submissions.

## Tests

- jsdom unit tests for the dialog's locked row, the Human toggle, the forced companion, and the editor's seeded and locked pinned control.
- A Playwright journey starting a session with a pinned seat as builtin, taking the seat as human, and completing a Rate flow against an environment with one pinned seat.
- `uv run python scripts/ci.py frontend-e2e` passes after the changes.
