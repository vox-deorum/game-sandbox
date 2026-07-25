# Agent Communication

Agents and human-controlled players may exchange short text messages during a session. Messaging is optional for the environment, season, and agent.

## Interface

Messaging does not change `act(observation)`. An agent may implement:

```python
def chat(self, inbox):
    ...
```

On the agent's turn, the harness calls `chat` immediately after `act` and before the environment applies the action. The agent therefore knows its chosen action, but not the outcome of the step. `inbox` contains messages addressed to that player since its previous turn. Each message includes its sender, text, and the tick when it was sent. The method returns messages or nothing. An agent without this method stays silent and incurs no chat cost. See [Submissions](submission.md).

## Messages

A message contains:

- Sender player.
- Recipient player, or broadcast.
- Plain UTF-8 text.
- Tick sent.

Messages address players rather than seats, so the players of one wide seat can message each other like any other players even though they are the same submission. Message volume scales with the player count rather than the seat count.

A human sends as the acting player, which is why the sender stays unambiguous for a human holding several players: the chat input is available only while one of that seat's players is acting. See [Interaction](interaction.md#chat). An agent sends as the player whose turn invoked its `chat` hook, so both kinds of participant speak as the player that is acting.

On each turn, an agent may send at most one message to each recipient and one broadcast. The environment sets the text limit in Unicode code points. This matches `len(text)` in Python, so an astral-plane character such as an emoji counts as one. A season may lower the limit or disable messaging. Binary payloads and structured side channels are not supported.

## Delivery and visibility

```text
Sender → harness → recipient inbox on its next turn
             └──→ recording
```

Accepted messages enter the pending inboxes at the end of the tick when they were sent. A message sent on tick T is therefore first seen after T, on the recipient's next turn. Each inbox item includes the tick when it was sent.

Agents never communicate directly. Human messages travel through the session WebSocket and enter a bounded first-in, first-out queue for each player. They do not use the coalescing input latch, so messages never replace one another. The harness drains the queue once per stepped tick and validates human messages by the same rules as agent messages, including the per-turn limit of one message to each recipient and one broadcast.

Broadcasts are visible to every player and spectator. During live play, a targeted message is shown only to the clients controlling its recipient or sender. The sender also receives the message so its chat panel can render recorded state instead of a local copy. This reveals nothing the sender did not write. Every message is recorded, including targeted messages, so no channel is permanently secret. See [Recording](recording.md).

Live chat history starts on a best-effort basis when a client connects. A reconnecting client resumes with new messages and uses the recording to find anything sent before it connected or while it was away. The decision log behaves the same way.

## Timing

Time spent in `chat` counts toward the agent's step and episode limits and appears in efficiency measurements. A slow `chat` never replaces or invalidates the action because `act` has already returned. A chat overrun only delays completion of the step, preserves messages that were already validated, and counts against the same budgets as a slow `learn`. See [Leaderboards](leaderboard.md).
