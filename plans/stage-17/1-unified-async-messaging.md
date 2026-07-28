# Stage 17.1: Unified asynchronous messaging

Status: not started.

Part of [Stage 17](../stage-17-simultaneous-stepping.md), build-order step 1.

## Outcome

Every messaging environment uses one buffered boundary model. The designated human may compose throughout the session, agent chat keeps running after that agent chooses its action, and every accepted message becomes readable only at a later acting opportunity.

Spades changes visibly: the composer remains enabled during every active player's turn. A message queued during an opponent's turn is admitted on the next completed step and reaches its recipient on that recipient's later turn.

## Boundary order

One AEC step uses this order:

1. Snapshot the acting observation and obtain the action.
2. Atomically drain the designated human player's message FIFO.
3. Resolve the pre-step recipient policy for the human sender and the acting agent sender, when present.
4. Validate the human batch, drain the acting agent's inbox, and run its optional `chat` hook.
5. Apply the environment action and run the acting agent's optional `learn` hook.
6. Record the accepted human and agent messages on the completed state.
7. Deliver that batch to recipient inboxes.

The queue drain is the admission cutoff. A frame accepted by `SessionControl` before the drain joins this boundary; a later frame waits for the next one. The contract does not assign a browser frame to a step from its wall-clock arrival or a client-provided tick.

Delivery after recording and after the acting chat hook preserves the strict delay. A message recorded on step T cannot be read by an agent during T. Chat-less agents still have their inbox discarded at their acting opportunity so pending messages remain bounded.

Stage 17.3 reuses the same phases for a parallel tick. All actions finish first, all chat hooks run against the pre-step world, one state is recorded, and only then is the batch delivered.

## Harness simplification

`SessionControl` keeps the bounded per-player FIFO it already owns. `ExternalChatFrame`, the Python live-command parser, and `take_chat()` remove the compose tick. Queue capacity remains sixteen frames per external player.

The acting-turn `ExternalChatCoordinator` is removed. It no longer needs to announce sender-and-tick opportunities, retain policy snapshots, or allow a one-drain grace period. `Episode` identifies the one designated `ExternalPlayer`, drains that source on every completed step regardless of the acting player, and sends the resulting `{"to", "text"}` batch through `ChatRouter.validate_outgoing()` with the human's current pre-step policy.

`ChatRouter` remains the single policy and outgoing-message validator for agents and humans. Its batch limit is renamed from per-turn to per-boundary:

- At most one direct message to each permitted recipient.
- At most one broadcast.
- The existing Unicode code-point text cap.

Messages from an inactive or unknown sender, duplicate recipients, invalid text, and policy-disallowed targets are dropped with concise stderr diagnostics. They do not create state diagnostics, client rejection envelopes, illegal moves, or forfeits.

The environment's `chat_policy(sender)` hook may be evaluated for the designated human even when another player is acting. Its fallback remains every other active player in canonical order with broadcast as the default. Agent policy is still evaluated for the agent whose `chat` hook runs.

## Command and relay

The shared command becomes:

```json
{
  "kind": "chat",
  "player": "player_0",
  "to": "player_2",
  "text": "Save a high spade"
}
```

Update `schema/ts/src/protocol.ts`, its parser and serialization tests, `harness/src/game_sandbox_harness/live_io.py`, the local relay tests, and all browser send sites together.

The production relay continues to require the session owner and human mode. For chat it also requires effective messaging, the designated external player, and the code-point cap before forwarding. It never treats general roster membership as authority to forge an agent sender. Recipient policy remains harness-authoritative. Targeted live-message visibility remains unchanged.

There is no compatibility branch for the old compose-tick command.

## Self-contained live policy

While the designated human player remains active, every emitted live state carries `chat_options` for that player:

- `sender`
- ordered `target_recipients`
- `default_recipient`

The opening AEC presentation state publishes the reset policy. Each completed state publishes the policy from its post-step world, which is the world in which the browser composes before the next boundary. A reconnect therefore receives a usable policy from the relay's existing latest-state replay without separate retained relay state.

`frontend/src/composables/useLiveChat.ts` stops consuming a sender-and-tick opportunity when an action is sent. It derives availability from the active human sender and connection state. It retains the draft across ordinary state changes and resets the selected recipient only when the sender, ordered recipients, or default recipient changes.

`ChatPanel`, `frontend/src/pages/SessionPage.vue`, and `frontend/src/local/LocalPlayPage.vue` use the same always-on contract. The composer becomes unavailable only when disconnected, the session ends, messaging is disabled, the human player becomes inactive, or the current state offers no human policy.

## Specifications and documentation

[Communication](../../docs/specs/communication.md) is rewritten around:

- one designated human sender;
- the atomic pre-step admission boundary;
- pre-step policy validation;
- one per-boundary outgoing batch;
- recording on the admitted boundary;
- delivery after that boundary;
- stderr-only rejection diagnostics.

[Interaction](../../docs/specs/interaction.md) removes the acting-turn composer and compose-tick rules. It states that every live state is self-contained for the active human chat policy.

The student agent interface and Spades guide keep the agent hook order `act`, `chat`, environment step, `learn`. Update any wording that says a human may send only while acting or that calls the outgoing batch limit per-turn.

## Tests

Harness tests cover:

- a human message queued while another player acts, admitted on the next boundary, recorded there, and delivered only on the recipient's later turn;
- a frame arriving after the atomic drain waiting for the following boundary;
- policy evaluation against the pre-step world;
- an inactive sender, stale target, duplicate target, over-cap text, and full FIFO dropping diagnostically without a forfeit;
- agent and human messages sharing one recorded batch while neither is visible to a chat hook on that boundary;
- an AEC player terminating individually and receiving no later chat hook or inbox growth;
- byte-identical non-messaging recordings before and after the refactor.

Revise existing turn-gating coverage in:

- `harness/tests/test_session_chat.py`;
- `backend/test/session/live-session.test.ts`;
- `backend/test/integration/spades-chat.test.ts`;
- `frontend/test/session.test.ts`;
- `frontend/test/local-play.test.ts`;
- `frontend/test/ui/chatpanel.test.ts`;
- `frontend/e2e/spades.spec.ts`.

The browser tests pin an enabled composer across opponent turns, recipient reset only on a policy change, the tick-free command, reconnect from one latest state, local-play parity, and unchanged targeted-message visibility.

## Done when

- No acting-turn coordinator, sender-and-tick opportunity, compose-tick command, one-drain grace, or action-consumed composer state remains.
- One harness validation path enforces sender, policy, cap, and per-boundary duplicates for human and agent batches.
- Every active-human live state is independently sufficient to render and send chat.
- Messages admitted on boundary T are recorded on T and cannot be read by an agent until a later opportunity.
- Spades unit, integration, and browser journeys pass under the always-on composer model.
