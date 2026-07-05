# Agent Communication

Agents and human-controlled slots may exchange short text messages during a session. Messaging is optional for the environment, season, and agent.

## Interface

Messaging does not change `act(observation)`. An agent may implement:

```python
def chat(self, inbox):
    ...
```

The harness calls `chat` immediately after `act` on the agent's turn, before the environment applies the action, so the agent knows its chosen action but not the step's outcome. `inbox` contains messages addressed to that slot since its previous turn, each carrying its sender, text, and the tick it was sent. The method returns messages or nothing. An agent without the method stays silent and incurs no chat cost. See [Submissions](submission.md).

## Messages

A message contains:

- Sender slot.
- Recipient slot, or broadcast.
- Plain UTF-8 text.
- Tick sent.

An agent may send at most one message to each recipient and one broadcast per turn. The environment sets the text limit, counted in Unicode code points (`len(text)` in Python, so an astral-plane character such as an emoji costs one), and a season may lower the limit or disable messaging. Binary payloads and structured side channels are not supported.

## Delivery and visibility

```text
Sender → harness → recipient inbox on its next turn
             └──→ recording
```

A tick's accepted messages are delivered to pending inboxes at the end of the tick they were sent, so a message sent on tick T is first seen strictly after T, on the recipient's next turn; each inbox item carries the tick it was sent.

Agents never communicate directly. Human messages use the session WebSocket and enter a bounded per-slot FIFO queue (not the coalescing input latch, so messages never swallow each other), drained once per stepped tick, regardless of whose turn it is, through the same validation as agent messages.

Broadcasts are visible to every slot and spectator. During live play, a targeted message is shown only to the clients controlling its recipient and its sender. Reflecting a message back to its sender lets the sender's chat panel render it from the recorded state rather than from a local echo, and reveals nothing the sender did not write. Every message is recorded, including targeted messages, so no channel is permanently secret. See [Recording](recording.md).

Live chat history is best-effort from the moment a client attaches. A reconnecting client resumes from the current line and relies on the recording as the archive for anything sent before it attached or while it was away, the same behavior the decision log has.

## Timing

Time spent in `chat` counts toward the agent's step and episode limits and appears in efficiency measurements. A slow `chat` never substitutes the action (`act` already returned it and `chat` cannot invalidate it), so a chat overrun only delays when the step completes, keeps the messages it already validated, and counts against the same budgets as a slow `learn`. See [Leaderboards](leaderboard.md).
