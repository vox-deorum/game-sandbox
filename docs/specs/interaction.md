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

Structured state keeps bandwidth and latency lower than streamed video and makes replay a first-class interactive view instead of a passive recording. The cost is that each environment must provide a small renderer.

## Per-step state object

The harness emits one state object per step. It is both the live wire format and the stored replay format. It contains:

- Tick number.
- Per-agent observation, action, reward, and cumulative score.
- Environment-specific overlay data needed for rendering.
- Messages sent on that tick.
- Timing.

The renderer cannot inspect the live environment. Anything needed on screen must appear in state.

## Session loop

There is one PettingZoo agent-environment-cycle for realtime, turn-based, single-agent, and multi-agent environments:

```text
Choose acting slot → obtain action or default → step environment → emit state → repeat
```

The server is authoritative. The browser never simulates ahead. Human inputs include the controlled slot ID.

The transport and state model identify every slot even when an initial product flow connects only one human. Supporting more connected humans later therefore does not change the environment contract.

The environment's [metadata](environment.md) selects timing:

| Mode | Pace interval | Advance rule |
| --- | --- | --- |
| Turn-based | None | Advance when the action arrives or the move clock expires. |
| Realtime | Set | Advance on each cadence, using the latest input or the default action. |

Realtime input takes effect after a network round trip, so supported games use modest cadences rather than twitch-sensitive timing.

Live sessions may pause. Pausing freezes stepping and timeout accounting. Headless leaderboard runs do not pace or pause.

Human slots use a separate timeout from agent compute limits. In realtime games, the cadence is the deadline. In turn-based games, the timeout is a move clock. A session may override the environment default, and the interface shows the active value when it affects play.

## Human input

An environment may expose human-capable slots. Its renderer can accept:

- Raw device input, such as keyboard, pointer, touch, or gamepad.
- On-screen controls, such as buttons, board cells, card hands, or sliders.

A renderer may use both. It maps each gesture to an action in the environment's action space and sends the action with the slot ID. Spectators and replay viewers receive no input capability.

A turn-based environment marks which actions are currently legal with a binary `action_mask`, carried in the per-step state so the renderer presents only legal choices, for example by disabling the illegal ones, rather than re-deriving the rules in the browser. Overlay data is object-shaped for the same reason: a card is a `{"suit", "rank"}` object, not an integer, so the renderer draws, animates, and hit-tests semantic values directly and encodes a chosen action back to its integer only when sending it. When a human slot's move clock expires, the environment supplies a default legal action — the real integer that gets played, recorded like any other move — so play continues.

## Chat

When messaging is enabled, the host page provides the chat panel as shared session chrome, so every messaging environment uses the same panel and the renderer needs no knowledge of messaging. Broadcasts and messages addressed to the connected user's slots appear there. Outgoing messages follow the same WebSocket path as input, but into a bounded per-slot FIFO queue rather than the coalescing input latch, drained once per stepped tick, so a human message is queued for the next tick, not the human's next turn. See [Communication](communication.md).
