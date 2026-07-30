# Interaction: Rendering and Input

This specification defines how state reaches the browser, how a renderer draws it, and how human actions return to the environment.

## One renderer per environment

Every environment has a browser renderer. The server sends structured state, not pixels or video.

```text
Per-step state → environment renderer → game frame
                         ↑
                 live play and replay
```

The renderer owns the game world and in-game interface, including scores, lives, turn indicators, and environment-specific controls. The host page owns shared session controls such as pause, stop, status, replay transport, and the chat panel when messaging is enabled.

Live play and replay use the same renderer. See [Recording](recording.md).

Local play uses the same browser renderer and session protocol through a loopback-only Python relay. Its page has no account shell, but start, pause, resume, stop, input, status, and game-over behavior follow this contract.

Structured state uses less bandwidth and adds less latency than streamed video. It also makes replay interactive instead of a passive video. In exchange, each environment must provide a small renderer.

## Per-step state object

The harness emits one state object per step. It is both the live wire format and the stored replay format. Each state is a delta for the player who acted. It contains:

- Tick number.
- Acting player, action, reward, cumulative score, and timing.
- Environment-specific overlay data needed for rendering, including semantic legal choices when a human can act.
- Messages sent on that tick.
- Chat options for the designated human player while that player remains active.
- Optional observations and action details when an environment chooses to expose them.

The renderer cannot inspect the live environment. Anything needed on screen must appear in state.

A turn-based live session may also emit one opening presentation state after reset, before any player acts. It has no acting-player entry and carries the initial overlay and chat options when available. It uses the state schema for the live renderer but is not a recorded step, so replay begins with the first completed action.

## Session loop

One PettingZoo agent-environment cycle supports real-time, turn-based, single-agent, and multi-agent environments:

```text
Choose acting player → obtain action or default → step environment → emit state → repeat
```

The server is authoritative. The browser never simulates ahead. Human inputs include the controlled player ID.

The transport and state model identify every player, even when a product flow connects only one human.

The environment's [metadata](environment.md) selects timing:

| Mode | Pace interval | Advance rule |
| --- | --- | --- |
| Turn-based | None | Advance when the action arrives or the move clock expires. |
| Real-time | Set | Advance on each cadence, using the latest input or the default action. |

Real-time input takes effect after a network round trip, so supported games use moderate cadences rather than timing that depends on immediate reactions.

Live sessions may pause, which freezes stepping, cadence, and in-harness action and episode timing. Pausing does not stop the backend session-duration or idle timers. The host page changes its pause control only after the relay confirms an accepted pause or resume command. A newly connected browser is told when a session is paused. Stop commands have no confirmation message, so the interface waits for the result and ended status before showing the session as finished. Headless leaderboard runs do not pace or pause.

Human players have a timeout separate from agent compute limits. In real-time games, the cadence is the deadline. In turn-based games, the timeout is a move clock. A session may override the environment default. The interface shows the active value whenever it affects play.

## Human play

A human play session designates one human-controlled player. The selected seat must contain at least one player listed in the environment's `human_players`, and the first such member in the seat's declared order is the human player. A singleton seat needs nothing else. A wider unrestricted seat requires the person to choose one companion agent, which runs as a separately constructed instance for every other player in that seat.

A restricted seat accepts only its designated builtin, or a human when one of its players is human-capable. A restricted human seat takes no companion choice from the browser. On a wider restricted seat, a separate instance of the designated builtin controls every other player. The move clock applies only on the designated human player's turns. Step and episode compute limits remain per agent-controlled player. See [Environments](environment.md#players-and-seats).

## Starting watch and play sessions

Before opening a start form, the browser loads the play-open season identifier and the complete resolved gameplay parameter map for that environment. When no season is open for play, the endpoint returns pure environment defaults with a null season identifier, but public session start remains unavailable.

The browser retains hidden parameter values, applies visible player edits, and submits the expected season identifier plus the complete map. A missing or unknown parameter is invalid. If another season became play-open while the page was open, session start returns a typed conflict before a session row or container is created. An edit to the same season does not silently replace values already loaded by the player.

Because the submitted map already carries the season layer, session start validates that map against the current declarations and applies no further layer beneath it. The player is answerable for the values they submitted and for nothing else.

Parameter validation happens before seat-assignment validation. Only a valid `players` or `seat_plan` value changes the resolved seats. New seats use the flow's default assignment. An assignment that is not valid in the new layout is cleared, and the session cannot start until every required seat is assigned again.

The backend resolves the selected layout from installed environment metadata before accepting assignments. It rejects an undeclared builtin anywhere, including a wide-seat companion. It also rejects a submission, another builtin, or a client-supplied companion on a restricted seat before creating the session or starting container work.

## Human input

An environment may expose human-capable players, and a seat is offered to a human when at least one of its members is human-capable. The environment's ordered membership determines which member the person controls. Its renderer can accept:

- Raw device input, such as keyboard, pointer, touch, or gamepad.
- On-screen controls, such as buttons, board cells, card hands, or sliders.

A renderer may use both types of input. It maps each gesture to an action in the environment's action space and sends that action with the player ID. Spectators and replay viewers cannot send input.

The [environment contract](environment.md#observations-and-actions) defines the object-shaped observation and binary `action_mask` received by an agent. They are not required fields in every emitted state. For human input, the semantic overlay supplies the currently legal choices. The renderer uses those choices to present only legal controls, such as by disabling illegal ones, instead of calculating rules in the browser.

Object-shaped overlay data works the same way for rendering. The renderer directly draws, animates, and hit-tests meaningful values such as a `{"suit", "rank"}` card. It converts the chosen action back to an integer only when sending it. If a human player's move clock expires, the environment supplies a default legal action so play continues. That actual integer is played and recorded like any other move.

## Chat

When messaging is enabled, the host page provides a shared chat panel. Every messaging environment uses this panel, so its renderer does not need to know about messaging. The panel shows broadcasts and targeted messages sent to or from the connected user's designated human player.

Every live state is self-contained for human chat while the designated human player remains active. It carries that sender, the environment's ordered direct-recipient choices, and its default recipient. **Everyone** is always available as a broadcast even when the environment offers no direct recipient.

The panel stays available across every active player's turn. It becomes unavailable only when messaging is disabled, the connection is unavailable, the session ends, the designated human becomes inactive, or the current state offers no human policy. Sending an action does not consume or close the composer. An unsent draft survives ordinary state changes and reconnects. The selected recipient resets only when the sender, ordered recipients, or default recipient changes.

The browser sends the sender, recipient, and text without a compose tick. Its state remains an interface hint rather than the authority. The harness admits each frame at an atomic pre-step queue drain and validates it against the human policy published on the preceding live state, as [Communication](communication.md#delivery-and-visibility) defines.
