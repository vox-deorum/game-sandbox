# Interaction: Rendering and Input

This specification defines how state reaches the browser, how a renderer draws it, and how human actions return to the environment.

## One renderer per environment

Every environment has a **renderer**. The server sends structured state, not pixels or video, which keeps bandwidth low and makes replay interactive.

```text
Per-step state → renderer → game frame
                     ↑
             live play and replay
```

The renderer owns the game world and in-game interface, including scores, lives, turn indicators, and environment-specific controls. The host page owns shared session controls such as pause, stop, status, replay transport, and the chat panel when messaging is enabled.

Live play and replay use the same renderer. See [Recording](recording.md).

Local play uses the same renderer and session protocol through a loopback-only Python relay. Its page has no account shell, but start, pause, resume, stop, input, status, and game-over behavior follow this contract.

## Per-step state object

The harness emits one state object per completed environment transition. It is both the live wire format and the stored replay format.

In a sequential environment, the state begins with the player whose action caused the transition. It may also include actionless reward, score, and lifecycle deltas for other players affected by that action. In a simultaneous environment, one state contains every player that acted in the joint tick, in canonical player order.

Each state contains:

- A **tick** that numbers completed environment transitions; tick and step refer to the same event.
- One or more player entries, each carrying the action when one was applied, the immediate reward, the cumulative score, and optional timing.
- Environment-specific overlay data needed for rendering and human input. An overlay may list semantic legal choices when a human can act, or provide the semantic state the renderer needs to derive them.
- Messages admitted on that step boundary.
- Chat options for the [designated human player](#human-play) while that player remains active.
- Optional observations and action details when an environment chooses to expose them.

The renderer cannot inspect the live environment. Anything needed on screen must appear in the state.

A live session may also emit one opening presentation state after reset, before any player acts. It has no player entries and carries the initial overlay and chat options when available. An unpaced sequential session emits it when it has something to present. Every simultaneous session emits it before the first cadence interval. A paced sequential session instead waits for its first recorded state. The opening state uses the ordinary state schema for the live renderer but is not recorded, so replay begins with the first completed transition.

## Session loop

A sequential environment advances one acting player at a time:

```text
Choose acting player → obtain action or default → step environment → emit one state → repeat
```

Required PettingZoo dead steps perform lifecycle housekeeping only. They do not invoke participant hooks or emit recorded states. After each real action, the state includes any non-acting player whose reward changed or who became terminated or truncated.

A simultaneous environment advances every active player in one joint tick:

```text
snapshot pre-step world
        ↓
collect each action or default in canonical order
        ↓
run pre-step chat hooks in canonical order
        ↓
step environment once with the complete action map
        ↓
learn and emit one multi-player state
```

The simultaneous path snapshots the active roster, every observation, and every info mapping before participant work begins. It consumes the designated human's latched action at the cadence boundary, then runs agent actions sequentially in canonical player order. Every agent decides from its saved pre-step observation. All action hooks finish before any chat hook runs, and the environment receives exactly one action for every player that was active in the snapshot.

Participant compute limits remain per player. A late `act` result is replaced only for that player, and every later player still gets its decision opportunity. Chat and learning overruns keep the chosen action and may make the tick finish late. Once a player becomes inactive, it receives no later observation, action, chat, learning, or state entry.

The server is authoritative. The browser never simulates ahead. Human inputs include the controlled player ID.

The transport and state model identify every player, even when a product flow connects only one human.

The environment's [metadata](environment.md) selects timing:

| Mode | Pace interval | Advance rule | Late work |
| --- | --- | --- | --- |
| Sequential turn-based | None | Advance when the acting player's action arrives or the move clock expires. | The next turn begins after the action finishes. |
| Sequential real-time | Set | Advance on the existing target cadence, using the latest input or the default action. | The scheduler retains its target sequence. |
| Simultaneous | Set (required) | Treat each cadence boundary as the earliest start of one joint tick, using the latest latched human input or its default action. | Schedule the next boundary one full interval after completion. Never skip a player or run catch-up ticks. |

Real-time input takes effect after a network round trip, so supported games use moderate cadences rather than timing that depends on immediate reactions.

A recorded state's `started_at` is its action or cadence boundary. Its duration ends after participant hooks, the environment transition, learning, and overlay extraction, immediately before state construction and serialization. Recording and relay work (serialization and input/output) is outside that duration. Environment transition time is platform work and is not charged to a participant.

Live sessions may pause in one of two ways. The environment's `human_pause` metadata chooses which one a human session uses. A watch session always pauses playback, because its container usually finishes long before the buffered frames have played out.

| Control | Rule |
| --- | --- |
| **Session pause** | Freezes stepping, cadence, and in-harness action and episode timing, including the human move clock. The backend session-duration and idle timers keep running regardless. The browser also holds the frames it has already buffered, so the picture stops with the session. |
| **Playback pause** | Freezes only that viewer's frame playout. The session, its cadence, its move clocks, and the backend timers all keep running, so play continues underneath and a paused human may have default actions played for them. A session that ends while paused reveals its outcome only after that viewer resumes. |
| **Resume** | Unfreezes what pause froze. For a session pause the host page's control changes only after the relay confirms the accepted command. A playback pause is local to the browser and changes at once. |
| **Stop** | Prevents the next transition without interrupting participant work already running. It has no confirmation message, so the interface waits for the ended status before showing the session as finished. Stop also lifts the viewer's own pause, so an outcome held behind it is revealed rather than stranded. |
| **Reconnect** | A newly connected browser is told when the session is paused. A playback pause belongs to the browser that made it and is not restored elsewhere. |
| **Headless runs** | Automated leaderboard runs neither pace nor pause. |

Sequential human players have a timeout separate from agent compute limits. In sequential paced games, the cadence is the deadline. In turn-based games, the timeout is a **move clock** and a session may override the environment default. A simultaneous environment's positive cadence is the human input window and has no separate move-clock override. The interface shows the active value whenever it affects play.

## Human play

A human play session designates one human-controlled seat. The selected seat must contain at least one player listed in the environment's `human_players`, and the first such member in the seat's declared order is the primary human player. A singleton seat needs nothing else. On a wider unrestricted seat, the person chooses a companion agent for every other member or plays every member themself. Self-play is available only when every member is listed in `human_players`. A companion runs as a separately constructed instance for each player it controls. See [Environments](environment.md#players-and-seats).

A restricted human seat takes no companion choice from the browser. On a wider restricted seat, a separate instance of the designated builtin controls every other player. The move clock applies on each human-controlled player's turn, and step and episode compute limits remain per agent-controlled player. Chat continues to use the primary human player as its designated sender. See [restricted seats](environment.md#builtin-agents-and-restricted-seats).

## Starting watch and play sessions

The start form is seeded with the [play-open season](seasons.md#public-gates) identifier and the complete resolved gameplay parameter map for that environment. When no season is open for play, the seeding endpoint returns pure environment defaults with a null season identifier, and public session start remains unavailable.

The submitted request carries the expected season identifier plus the complete parameter map. A missing or unknown parameter is invalid. If the play-open season changed since the form was seeded, session start returns a typed conflict before a session or container is created. Editing the same season's [configuration](seasons.md#per-season-configuration) does not silently replace values already loaded by the player.

The submitted map already carries the season layer, so session start validates it against the current declarations and applies no further layer beneath it. The player is responsible for the values they submitted and for nothing else.

Parameter validation happens before seat-assignment validation. Only a valid `players` or `seat_plan` value changes the resolved seats. New seats use the flow's default assignment. An assignment that is not valid in the new layout is cleared, and the session cannot start until every required seat is assigned again.

The backend resolves the selected layout from installed environment metadata before accepting assignments. It rejects an undeclared builtin anywhere, including a wide-seat companion. It also rejects a submission, another builtin, or a client-supplied companion on a restricted seat before creating the session or starting container work. A self companion is rejected on a singleton or restricted seat, and on a wide seat with any member that is not human-capable.

## Human input

An environment may expose human-capable players, and a seat is offered to a human when at least one of its members is human-capable. The environment's ordered membership determines the primary human player. A self-played wide seat exposes every member to the renderer as controlled. The renderer can accept:

- Raw device input, such as keyboard, pointer, touch, or gamepad.
- On-screen controls, such as buttons, board cells, card hands, or sliders.

A renderer may use both types of input. It maps each gesture to an action in the environment's action space and sends that action with the player ID. Spectators and replay viewers cannot send input.

The [environment contract](environment.md#observations-and-actions) defines the object-shaped observation and binary `action_mask` received by an agent. They are not required fields in every emitted state. For human input, the semantic overlay either supplies the currently legal choices or provides the semantic state from which the renderer derives them. The renderer presents only legal controls, such as by disabling illegal ones.

Object-shaped overlay data works the same way for rendering. The renderer directly draws, animates, and hit-tests meaningful values such as a `{"suit", "rank"}` card. It converts the chosen action back to the environment's action shape only when sending it. If a human player's move clock expires, the environment supplies a default legal action so play continues. That default action is played and recorded like any other move.

## Chat

When messaging is enabled, the host page provides a shared chat panel. Every messaging environment uses this panel, so its renderer does not need to know about messaging. The panel shows broadcasts and targeted messages sent to or from the connected user's designated human player.

Every live state is self-contained for human chat while the designated human player remains active. It carries that player as the sender, the environment's ordered direct-recipient choices, and its default recipient. **Everyone** is always available as the broadcast choice even when the environment offers no direct recipient.

The panel stays available across every active player's turn. It becomes unavailable only when messaging is disabled, the connection is lost, the session ends, the designated human becomes inactive, or the current state offers no human policy. Sending an action does not consume or close the composer. An unsent draft survives ordinary state changes and reconnects. The selected recipient resets only when the sender, ordered recipients, or default recipient changes.

The browser sends the sender, recipient, and text without a compose tick. The browser's local state remains an interface hint rather than the authority. The harness admits each frame at an atomic pre-step queue drain and validates it against the human policy published on the preceding live state, as [Communication](communication.md#delivery-and-visibility) defines.
