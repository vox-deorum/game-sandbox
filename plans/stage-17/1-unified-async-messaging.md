# Stage 17.1: Unified asynchronous messaging

Status: not started.

Part of [Stage 17](../stage-17-simultaneous-stepping.md), build-order step 1.

## Outcome

Every environment shares one buffered messaging model. Messages sent during step T are recorded on state T and delivered at each recipient's next chat opportunity, humans send whenever they like, and the acting-turn opportunity machinery is gone. Spades behaves visibly differently: the composer is enabled for the whole session, and a message composed during an opponent's turn arrives on the partner's next turn.

## Harness

- Agent sending is unchanged in shape: the chat hook runs at the agent's acting opportunity and its output is validated against the current recipient policy.
- Human messages latch per player in `SessionControl` the way inputs do. At every step boundary the harness drains the human queue, validates each message against `chat_policy(sender)` evaluated at that boundary, records admitted messages on that state, and delivers them onward. A disallowed recipient, an unknown sender, or an over-cap message is dropped with a diagnostic and nothing is forfeited.
- The Stage 15.4 admission rules keyed to the acting player disappear: no sender-plus-tick opportunity pairing, no one-drain grace, no acting-sender requirement. The message cap and the recorded `{from, to, text}` shape are unchanged, so the step-state schema does not change.
- `chat_options` stays in step state as the human sender's current recipient policy, republished when policy changes rather than gating on whose turn it is.

## Relay and frontend

- The relay's chat checks in `backend/src/session/live-session.ts` reduce to messaging enabled, sender membership, and the code-point cap. Per-audience filtering of targeted messages is unchanged.
- `frontend/src/pages/SessionPage.vue`, `frontend/src/composables/useLiveChat.ts`, and `ChatPanel` drop the opportunity model: the composer is enabled while the session runs and a human seat is present, the recipient list follows the latest `chat_options`, and sending never disables the composer.
- The jsdom unit tests and the Playwright journeys that assert on turn-gated chat are revised to the always-on model in this same step.

## Specification

[Communication](../../docs/specs/communication.md) is rewritten around the buffered model: send at any time, boundary admission, next-opportunity delivery, policy evaluated at admission, and the drop-with-diagnostic rule. [Interaction](../../docs/specs/interaction.md) drops its acting-turn chat sentences.

## Tests

- Harness: a human message sent during another player's turn is admitted at the next boundary and read on the recipient's next turn; a stale policy target is dropped without forfeit; the cap still applies per player.
- Frontend: composer enabled across turns, recipient list tracking `chat_options`, journeys updated.
