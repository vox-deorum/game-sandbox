# Stage 8.7: Testing, CI, and Docs

Status: done. The Docker-gated Spades chat integration tests landed in the existing `backend-integration` lane (`backend/test/integration/spades-chat.test.ts`, five cases: a real-driver session with the chatting example agents whose broadcast and targeted messages surface in the streamed lines and the recording; a targeted human `chat` frame written to container stdin reaching the harness queue and the recording; the built-in `/opt/agents/builtin/spades` in an all-Naive session; a workflow season with `overrides.messaging.enabled=false` silencing and a lowered cap rejecting over-cap sends, with the made-nil demo scores pinned against `environments/src/spades/tests/test_spades_chat.py`; and a live session picking up the play-open season's overrides through the orchestrator). The browser journey extended `frontend/e2e/spades.spec.ts` (a second spectator, the sending tick badge, reconnect without duplication, the reopened ended session hydrated from the recording, the over-cap composer, and live season silencing) and added a Spades season through the multi-seat scheduler over the `examples/spades/*` roster to a released board where partners share the team score, with the shared constants in `support/names.ts` and a `setMessagingOverride` helper. No new CI lanes: the integration tests join `backend-integration`'s glob and the browser journey joins the manually-dispatched `e2e.yml`. The spec reconciliation added Spades to environment.md's environment list and the forfeit floor and the live-session override reach to leaderboard.md; the contributor and student docs already matched the shipped behaviour. All Docker-free suites, the strict docs build, the Docker-gated integration lane, and the browser journey are green.

Part of [Stage 8](../stage-08-communication.md). This is the cross-cutting companion to build-order steps 1 through 6. Each step owns and documents its own tests; this file deliberately does not restate them, because a duplicated contract drifts. It keeps only what no single step owns: the whole-stage journey, the Docker-gated integration tests, the browser end-to-end journey, the CI placement, and the reconciliation of specs and docs with what actually shipped. This is not a separate phase done at the end; the obligations here are tracked across the stage so nothing falls between steps.

## Per-step coverage

The coverage contract lives in each subplan's Tests section, which is the source of truth:

- [Step 1](1-spades-environment-and-metadata.md): the Spades rules, scoring, metadata, local renderer, and tie-aware local standings.
- [Step 2](2-spades-template-and-example.md): the template layer, `cards.py`, the counter example, and the built-in agent.
- [Step 3](3-spades-renderer-and-onscreen-input.md): the browser renderer, on-screen input, tie-aware web standings, and the Spades forfeit floor.
- [Step 4](4-harness-chat-and-chatting-examples.md): the message router, hook order, budgets, the human queue, and the chatting examples.
- [Step 5](5-relay-visibility-and-season-override.md): the chat protocol, visibility and authorization matrices, the persisted effective config, the season override, the efficiency aggregation, and the admin editor.
- [Step 6](6-chat-panel-live-and-replay.md): the chat panel live, ended, and in replay, with reconnect deduplication and the send path.

## The stage journey

A Spades hand plays in the browser with the chatting examples seated. An agent's broadcast nil warning appears on every connected panel, spectator pages included, with the frame of the tick it was sent, and lands in each other seat's inbox on that seat's next turn. A targeted message to the human-controlled seat is shown live only to the controlling client; a second spectator page never shows it. The human's reply, sent from the chat panel, arrives in the agent's inbox the following turn. An over-cap message is rejected while the rest of the exchange lands intact. A reconnected panel resumes without duplicating a message. The replay, and the ended session reopened directly, show the full exchange, targeted messages included, at their ticks. And disabling messaging on the season silences the same composition, scheduled games and live sessions both, without a code change.

## Docker-gated integration tests

These run the real Stage 3 driver in the existing `backend-integration` lane, so the default test run stays Docker-free:

- A real-driver Spades session with two chatting example agents whose messages appear in the streamed lines and the recording.
- A `chat` frame written into container stdin reaching the harness queue.
- The built-in `/opt/agents/builtin/spades` loading in an all-Naive session.
- A season run with `overrides.messaging = {enabled: false}` silencing the same agents without a code change, and a lowered cap rejecting over-cap sends.
- A live session picking up the play-open season's overrides through the orchestrator.

## Browser end-to-end

A new `frontend/e2e/spades.spec.ts` in the manually-dispatched `e2e.yml` workflow covers the stage journey above, plus a Spades season through the multi-seat matchmaking scheduler over the `examples/spades/*` roster to a released board where partners share the team score. Seat 0 always opening the bidding keeps the spec deterministic; shared constants live in the e2e support module.

## CI

No new lanes. The Docker-free Python, backend, and frontend suites run on every change in the existing lanes; the Docker-gated chat and Spades integration tests join the existing `backend-integration` lane; the browser journey joins the manually-dispatched `e2e.yml` workflow; and `generated-code-fresh` already catches a stale `backend/src/generated/environments.json` or unregenerated `schema/ts` types, which this stage touches in steps 1 and 4.

## Docs

- **Specs:** the decision-level reconciliations already landed together with this plan revision: the sender-reflection visibility sentence in [communication.md](../../docs/specs/communication.md) and the host-owned chat panel in [interaction.md](../../docs/specs/interaction.md). The contract sharpenings land with the steps that pin them, the spec-and-plan-together discipline of the [plans README](../README.md): step 4 sharpens the communication.md order sentence and adds the inbox-tick, per-stepped-tick queuing, code-point cap, and chat-overrun sentences; step 5 adds the best-effort attach-onward live-history sentence. This step verifies the reconciled specs against the shipped behavior and keeps [environment.md](../../docs/specs/environment.md) and [leaderboard.md](../../docs/specs/leaderboard.md) aligned where the metadata, the forfeit floor, and the season override (now reaching live sessions) changed visible behavior.
- **Student docs:** verify the `chat` section and the corrected `act → chat → environment step → learn` cycle diagram of [agent-interface.md](../../docs/students/agent-interface.md) and the Spades page's Messaging section (landed in steps 2 and 4) against the shipped behavior, shapes included.
- **Contributor docs:** update the [environments guide](../../docs/contributors/environments.md) metadata table if the messaging fields need a row, and the [examples and template guide](../../docs/contributors/examples-and-template.md) for the third template.
- **Plan:** keep the [plans README stage overview](../README.md) Stage 8 line aligned with the parent stage and subplans, and flip the Stage 8 parent and each subplan's status from "not started" through "in progress" and "done" as work lands, the discipline Stages 5 through 7 followed.
- Run `uv run python scripts/ci.py docs` (the strict documentation build) as the doc gate.

## Done when

Every step's own tests are green in the Docker-free suites. The Docker-gated Spades chat integration tests pass in their lane, the browser journey passes when `e2e.yml` is dispatched, and both `npm run check` gates are clean. The spec, student, and contributor docs describe the shipped messaging model (the shapes, the cap rule, the delivery timing, the visibility rules with sender reflection, and season overrides reaching live sessions) and the strict docs build passes. At that point the Stage 8 parent's "Done when" is demonstrable end to end, and the stage status flips to done.
