# Stage 8: Agent Communication

Status: not started

## Goal

Agents and human-controlled slots can exchange messages during a session. The chat panel shows them live, and they appear in recordings and replays. Everything is optional. Agents without the hook and environments without the flag behave exactly as before. This stage comes right after multi-agent, so the Hearts environment from Stage 7 is already in place. Hearts serves as the product test bed, where broadcast-versus-targeted visibility actually matters.

## Scope

Implement chat routing in the harness per [communication.md](../docs/specs/communication.md). After `act`, call `chat(inbox)` on agents that define it, passing the messages addressed to that slot since its last turn. Enforce the rules in the harness: at most one message per recipient plus one broadcast per turn; plain UTF-8 text; length capped by the environment metadata or the iteration override; and messaging skipped entirely when the environment or iteration disables it. A message sent on tick T reaches its recipient's inbox on the recipient's next turn. Time spent in `chat` counts against the same per-step and per-episode limits as `act` and `learn`. Extend the Stage 2 timing machinery to cover it.

Messages flow into the per-step state object, carrying sender slot, recipient, text, and tick. These schema fields have existed since Stage 1, so recording and replay need no format change. Apply the visibility rules at the relay. The backend forwards broadcasts to every connected client. It forwards a targeted message addressed to a human-controlled slot to the client controlling that slot. It withholds other targeted messages from spectators during live play. Recordings keep every message, so replays show them all.

Wire the human side per [interaction.md](../docs/specs/interaction.md). Outgoing messages from human-controlled slots travel the session WebSocket like input and are queued for the next tick. Build the chat panel as part of the on-screen renderer UI. It shows broadcasts and messages addressed to slots controlled by the connected user, with an input box when that user controls a slot. Show recorded messages in the replay viewer at their ticks.

Turn messaging on for the Stage 7 Hearts environment as the product use. Set a low per-step cap. Agents can openly warn the table about a suspected moon shot (broadcast) or quietly coordinate (targeted), and the visibility rules decide who sees what during play versus in the recording. Verify the template repo's `chat` stub against the real harness. Leave Flappy Bird messaging disabled unless there is a concrete human-facing use for it. Beyond Hearts, a minimal multi-slot test fixture can exercise the harness and relay rules in isolation. But Hearts is what makes agent-to-agent chat matter.

## Spec references

[communication.md](../docs/specs/communication.md), [interaction.md](../docs/specs/interaction.md) (chat panel, WebSocket path), [environment.md](../docs/specs/environment.md) (metadata flag and cap), [leaderboard.md](../docs/specs/leaderboard.md) (iteration overrides), [recording.md](../docs/specs/recording.md).

## Depends on

Stage 3 (relay), Stage 4 (renderer UI), Stage 6 (iteration overrides), Stage 7 (Hearts as the multi-agent test bed). Independent of Stage 9 (LLM).

## Done when

In a Hearts session: an agent broadcast reaches all slots and spectators on the next turn; a targeted message to a human-controlled slot reaches only the client controlling that slot live; the reply arrives in the agent's inbox the following turn; an over-cap message is rejected by the harness; and the full exchange, targeted messages included, is visible in the replay. Disabling messaging at the iteration level silences the same agents without code changes.
