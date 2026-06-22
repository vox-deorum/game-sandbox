# Agent Communication

Agents and human-controlled slots may exchange short text messages during a session. Messaging is optional for the environment, season, and agent.

## Interface

Messaging does not change `act(observation)`. An agent may implement:

```python
def chat(self, inbox):
    ...
```

The harness calls `chat` after `act` on the agent's turn. `inbox` contains messages addressed to that slot since its previous turn. The method returns messages or nothing. An agent without the method stays silent and incurs no chat cost. See [Submissions](submission.md).

## Messages

A message contains:

- Sender slot.
- Recipient slot, or broadcast.
- Plain UTF-8 text.
- Tick sent.

An agent may send at most one message to each recipient and one broadcast per turn. The environment sets the text limit, and a season may lower the limit or disable messaging. Binary payloads and structured side channels are not supported.

## Delivery and visibility

```text
Sender → harness → recipient inbox on its next turn
             └──→ recording
```

Agents never communicate directly. Human messages use the session WebSocket and enter the same harness queue.

Broadcasts are visible to every slot and spectator. A targeted message is visible only to its recipient during live play. Every message is recorded, including targeted messages, so no channel is permanently secret. See [Recording](recording.md).

## Timing

Time spent in `chat` counts toward the agent's step and episode limits and appears in efficiency measurements. See [Leaderboards](leaderboard.md).
