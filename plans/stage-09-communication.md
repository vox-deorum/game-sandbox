# Stage 9: Agent Communication

Status: not started

## Goal

Agents and human-controlled slots can exchange messages during a session, the chat panel shows them live, and they appear in recordings and replays. Everything is optional: agents without the hook and environments without the flag behave exactly as before. This stage comes last so the Hearts environment from Stage 8 is already in place to serve as the product test bed where broadcast-versus-targeted visibility actually matters.

## Scope

Implement chat routing in the harness per [communication.md](../specs/communication.md): after `act`, call `chat(inbox)` on agents that define it, passing the messages addressed to that slot since its last turn. Enforce the rules in the harness: at most one message per recipient plus one broadcast per turn, plain UTF-8 text, length capped by the environment metadata or the iteration override, and messaging skipped entirely when the environment or iteration disables it. A message sent on tick T reaches its recipient's inbox on the recipient's next turn. Time spent in `chat` counts against the same per-step and per-episode limits as `act` and `learn`; the Stage 2 timing machinery extends to cover it.

Messages flow into the per-step state object (sender slot, recipient, text, tick), whose schema fields exist since Stage 1, so recording and replay need no format change. Apply the visibility rules at the relay: the backend forwards broadcasts to every connected client, forwards targeted messages addressed to a human-controlled slot to the client controlling that slot, and withholds other targeted messages from spectators during live play. Recordings keep every message, so replays show them all.

Wire the human side per [interaction.md](../specs/interaction.md): outgoing messages from human-controlled slots travel the session WebSocket like input and are queued for the next tick. Build the chat panel as part of the on-screen renderer UI, showing broadcasts and messages addressed to slots controlled by the connected user, with an input box when that user controls a slot. Show recorded messages in the replay viewer at their ticks.

Turn messaging on for the Stage 8 Hearts environment as the product use: a low per-step cap, agents openly warning the table about a suspected moon shot (broadcast) or quietly coordinating (targeted), and the visibility rules deciding who sees what during play versus in the recording. Verify the template repo's `chat` stub against the real harness, and leave Flappy Bird messaging disabled unless there is a concrete human-facing use for it. Beyond Hearts, the harness and relay rules can also be exercised in isolation with a minimal multi-slot test fixture, but Hearts is what makes agent-to-agent chat matter.

## Spec references

[communication.md](../specs/communication.md), [interaction.md](../specs/interaction.md) (chat panel, WebSocket path), [environment.md](../specs/environment.md) (metadata flag and cap), [leaderboard.md](../specs/leaderboard.md) (iteration overrides), [recording.md](../specs/recording.md).

## Depends on

Stage 3 (relay), Stage 4 (renderer UI), Stage 6 (iteration overrides), Stage 8 (Hearts as the multi-agent test bed). Independent of Stage 7 (LLM).

## Done when

In a Hearts session, an agent broadcast reaches all slots and spectators on the next turn, a targeted message to a human-controlled slot reaches only the client controlling that slot live, the reply arrives in the agent's inbox the following turn, an over-cap message is rejected by the harness, and the full exchange, targeted messages included, is visible in the replay. Disabling messaging at the iteration level silences the same agents without code changes.

## Deviations

None yet.
