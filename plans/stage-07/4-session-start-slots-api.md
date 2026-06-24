# Stage 7.4: Session Start Slot Assignments and Validation

Status: not started.

Part of [Stage 7](../stage-07-multi-agent.md). This is build-order step 4. It replaces the single-agent session start shape with an explicit `slots` assignment object and makes backend validation authoritative. It is Docker-free: the request shape, validation, and attribution are unit-testable against the in-memory storage with the fake driver.

## Why this is its own seam

The harness multi-slot path (step 5) and the watch and play flows (step 6) both depend on a single, well-defined start contract. Defining that contract on its own, with authoritative validation and the recording attribution rules, lets the execution work and the frontend work proceed against a stable shape and lets the validation rules be tested without standing up a container.

This is a breaking replacement, not a compatibility layer. There is no need to preserve backward compatibility with old development databases or the Stage 5 request shape. This is not in production, so local databases may be reset or migrated destructively if the cleaner schema warrants it.

## The new start payload

The session start request changes from a single optional `submission_id` to an explicit `slots` assignment object. The payload is `env_id`, `mode`, optional `seed`, optional `human_slot_timeout_ms`, and `slots`, keyed by slot id. Each slot assignment has `kind: "human" | "builtin-agent" | "submission"`, plus `submission_id` only for submitted-agent slots.

This touches `START_SESSION_SCHEMA` and `StartBody` in `backend/src/app.ts`, the `StartRequest` interface and `start()` in `backend/src/session/orchestrator.ts`, and the seat assembly in `backend/src/session/launch-config.ts`, whose `assembleSeats()` already maps seat bindings to `{ slots, players }`.

## Authoritative validation

Backend validation is authoritative and runs before any container starts:

- Human assignments are valid only for metadata human slots. For Hearts every seat is human-capable (step 1), so a human is accepted in any seat, and this stage additionally caps the human count at one, with the remaining slots filled by agents. The cap is a session-composition limit that later multi-human play relaxes; it is not a per-seat capability.
- Submission assignments must reference active `ready` submissions for the requested environment.
- Built-in agent assignments create no submission attribution row.
- Missing or incompatible required seats are rejected before a container starts.

## Attribution

`session_submissions` records one row per submitted slot. The table is already keyed by `(session_id, slot_id)`, so this is one insert per submission slot through `recordSessionSubmission`. Human and built-in slots are represented only in the recording header's `players` attribution, never as a `session_submissions` row.

## Tests

Vitest, in-memory storage, fake driver, no Docker:

- Reject missing required seats, a human assigned to a slot the metadata does not mark human-capable, more than one human slot for this stage's single-human limit, inactive or non-`ready` submissions, and submissions for the wrong environment, each before a container would start.
- A valid multi-slot Hearts start with submitted, built-in, and human slots writes one `session_submissions` row per submitted slot, and represents human and built-in slots only in the recording header `players`.
- The tests prove the breaking start-shape replacement rather than compatibility with the old single-`submission_id` shape.

## Done when

The session start API accepts the `slots` assignment payload and rejects the old shape. Backend validation authoritatively rejects missing, incompatible, inactive, wrong-environment, and more-than-one-human assignments before a container starts. A valid start records one `session_submissions` row per submitted slot while built-in and human slots appear only in the recording header `players`. All of this is proven by Docker-free Vitest tests.
