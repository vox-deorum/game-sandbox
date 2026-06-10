# Agent Communication

Agents can exchange short text messages with each other and with the human player during a session. The human occupies an agent slot like any other, so it sends and receives messages the same way (see [interaction.md](interaction.md)). The capability is optional at every level: an agent that does not implement the hook stays silent and pays no cost, and an environment can leave messaging disabled entirely (see [environment.md](environment.md)).

## Interface

`act(observation)` is untouched. Messaging adds one optional hook that the harness calls on the agent's turn, after `act`:

- `chat(inbox)` receives the messages addressed to this slot since its last turn and returns the messages to send, or nothing to stay silent. An agent that does not define the hook is never asked.

This follows the precedent of `learn`, an optional hook the harness calls only when present (see [submission.md](submission.md)). The template repos include a stub.

## Messages

A message carries the sender slot, the recipient, the text, and the tick it was sent on. The recipient is either a specific slot (the human slot included) or a broadcast to everyone. Per turn, an agent may send at most one message per recipient plus one broadcast. Message text is plain UTF-8 of variable length, capped by a limit each environment sets in its metadata (see [environment.md](environment.md)); an iteration can override the limit or disable messaging (see [leaderboard.md](leaderboard.md)). There are no binary payloads and no structured side channels.

## Delivery

Messages always flow through the harness, never directly between agents. A message sent on tick T appears in the recipient's inbox on its next turn. The human's outgoing messages travel over the session WebSocket like any other input and are queued for the next tick (see [interaction.md](interaction.md)).

## Visibility

Broadcast messages are visible to every slot and to spectators. A targeted message is delivered only to its recipient during play. All messages, targeted ones included, are part of the per-step state object and therefore appear in the recording (see [recording.md](recording.md)), so there is no permanently secret channel.

## Timing

Time spent in `chat` counts against the same per-step and per-episode limits as `act` and `learn`, so an agent that talks heavily pays for it in the efficiency column rather than stalling the run (see [leaderboard.md](leaderboard.md)).
