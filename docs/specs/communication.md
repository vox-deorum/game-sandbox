# Agent Communication

Agents and human-controlled players may exchange short text messages during a session. Messaging is optional for the environment, season, and agent.

## Interface

Messaging does not change `act(observation)`. An agent may implement:

```python
def chat(self, inbox):
    ...
```

On the agent's acting opportunity, the harness calls `chat` after its `act` result is available and before the environment applies the action. In a simultaneous tick, every active player's action finishes before any chat hook begins. The agent therefore knows its own chosen action, but the harness gives it no access to another player's returned action or to the outcome of the step. `inbox` contains messages addressed to that player since its previous acting opportunity. Each inbox item includes its sender, recipient, text, and sent tick. The method returns messages or nothing. An agent without this method stays silent and incurs no chat cost. Its inbox is still drained so unread messages remain bounded. See [Submissions](submission.md).

## Messages

A recorded message object contains:

- Sender player.
- Recipient player, or broadcast.
- Plain UTF-8 text.

A message's sent tick is the tick of the state object that contains it. An inbox item adds that tick as an explicit `tick` field.

Messages address players rather than seats. A direct message is valid only when the environment's current recipient policy allows that target for its sender. Message volume scales with the player count rather than the seat count.

A human sends only as the session's designated human player and may compose while that player remains active. An agent sends as the player whose acting opportunity invoked its `chat` hook. The harness enforces both sender identities rather than trusting a browser-provided player ID. See [Interaction](interaction.md#chat).

A logically active player is present in `env.agents` and is not marked terminated or truncated. This excludes an AEC player awaiting a required [dead step](interaction.md#session-loop). The set is resolved once per completed transition, and every rule below is stated against it. A message with an inactive or unknown sender, an inactive recipient, a duplicate recipient, invalid text, or a policy-disallowed target is dropped with a concise standard-error diagnostic. Messaging rejection never creates a state diagnostic, client rejection envelope, illegal move, or forfeit.

An environment may provide a live-state policy for a sender. It returns ordered, unique direct recipients (excluding the sender) and a default recipient. A direct default must be in that set; broadcast is also a valid default. The policy may change as the game advances. Without it, every other logically active player is permitted in canonical order and broadcast is the default. An invalid result falls back to those defaults and writes a standard-error diagnostic.

An environment may also provide `broadcast_recipients(sender)` to limit delivery of that sender's broadcasts. The hook returns an ordered sequence of unique, known players excluding the sender. Players who are no longer logically active are removed silently. An empty valid sequence delivers to nobody. Without the hook, or when the hook raises an exception or returns an invalid result, the broadcast reaches every other logically active player in canonical order. Invalid results and hook failures write a standard-error diagnostic.

A named recipient who is no longer logically active is removed from the policy, and a default that leaves with it becomes broadcast.

Broadcast is always available and is represented by a null recipient. An environment can restrict or reorder direct recipients but cannot remove broadcast. The same policy validates messages returned by an agent's `chat` hook and messages submitted by a human. A message that breaks the policy, the text limit, or the per-boundary limits is dropped with a standard-error diagnostic.

On each completed step boundary, a sender may contribute at most one direct message to each permitted recipient and one broadcast. These limits reset independently for every sender and boundary. The environment sets the text limit in Unicode code points, matching `len(text)` in Python. A season may lower the limit or disable messaging. Binary payloads and structured side channels are not supported.

## Delivery and visibility

### Delivery

```text
human FIFO ─┐
            ├─→ validate → environment step → recording → recipient inboxes
agent chat ─┘
```

One completed boundary uses this messaging order:

1. Snapshot the observations used by the boundary and obtain every required action.
2. Atomically drain the designated human player's message queue.
3. Use the human policy published on the preceding live state and resolve each chatting agent's current pre-step policy.
4. Validate the human batch, drain each participating player's inbox, and run optional `chat` hooks.
5. Apply the environment transition and run applicable `learn` hooks.
6. Record the accepted human and agent messages on the completed state.
7. Resolve each sender's broadcast recipients and deliver that batch to recipient inboxes.

A sequential boundary has one acting player. A simultaneous boundary obtains every active player's action first, then runs chat hooks in canonical player order against the unchanged pre-step environment. The recorded message batch lists the human FIFO first, followed by agent batches in canonical player order, each keeping its sender's returned order.

The atomic queue drain is the admission cutoff. A browser frame accepted before the drain joins that boundary. A later frame waits for the next completed step. Wall-clock arrival and client-provided ticks do not assign a message to a boundary.

Human messages travel through the session WebSocket to one bounded first-in, first-out queue for the designated human player. They do not use the coalescing action-input latch. The command carries the sender, recipient, and text. The transport rejects another sender before allocating queue storage.

The episode retains the human policy published on the latest live state. At the next boundary, every queued human message is validated against that cached pre-step policy, even when another player acts. The completed transition publishes the next policy while the human remains active. Required AEC dead steps neither publish nor replace it.

Accepted messages are recorded on their admitted boundary and delivered only afterward. A message recorded on tick T cannot be read by any `chat` hook on tick T. Its inbox item includes T as the sent tick, and the recipient first reads it at a later acting opportunity.

A completed transition discards the inbox of every player that left on it, and delivery skips a recipient that left the same way, because neither gets a later acting opportunity to read them. Once the designated human is inactive, its queued frames are still drained at each boundary and dropped there, so the transport's queue bound is the only limit on them.

### Visibility

Every live watcher receives every delivered message, including targeted messages. A watcher is any socket that does not control a human player, including every socket in a scripted watch session. A human controller receives broadcasts plus targeted messages sent to or from one of its players. Every message is recorded and visible in replay. See [Recording](recording.md).

Live chat history is best-effort when a client connects. A reconnecting client receives new messages and uses the recording for messages sent before it connected or while it was away. The decision log follows the same rule.

## Timing

Like every optional hook (see [Submissions](submission.md#agent-interface)), time spent in `chat` counts toward the agent's step and episode limits and appears in efficiency measurements. A slow `chat` never replaces or invalidates the action because `act` has already returned. A chat overrun only delays the step's completion; it preserves messages that were already validated and counts against the same budgets as a slow `learn`. See [Leaderboards](leaderboard.md#automated-board).
