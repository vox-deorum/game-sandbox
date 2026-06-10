# Interaction: Rendering and Input

This file covers how a game looks in the browser and how human input flows back to the game.

## Custom renderer per environment

Every environment has a dedicated frontend renderer. We do not stream pixels or video from the server, and we do not fall back to server-rendered frames for any environment. Streaming is too much bandwidth and too much latency for the kinds of games we host, and it makes replays second-class. Writing a small renderer per environment is straightforward, and we accept that cost up front.

A renderer is a frontend module that takes a per-step state object and draws the current frame. "The frame" includes both the game world (sprites, board positions, physics, whatever the game is made of) and the game UI around it: scores, lives, current tick, agent labels, turn indicators, status messages, action history, and any other metadata that makes the screen feel like a real game rather than a debugger view. The renderer is what gives each environment its identity on the website. The same renderer is used for live play and for replays, so anything that can be shown live can also be shown in a replay (see [recording.md](recording.md)).

## Per-step state object

The environment emits one state object per step. It is the canonical wire format between the environment and the renderer, and it is also what gets stored for replay.

A per-step payload includes:

- Tick number.
- Per-agent observations that are useful for display.
- Per-agent action taken on that tick.
- Per-agent reward for that tick.
- Per-agent cumulative score.
- Environment-specific overlay fields (for example, a Flappy Bird payload might include pipe positions).
- Messages sent on that tick, each with its sender and recipient (see [communication.md](communication.md) for visibility rules).
- Timing.

The renderer never reaches behind the state object. If something needs to be drawn, it shows up in the payload.

## Session loop

The server is authoritative. It steps the environment at the environment's fixed tick rate (part of its [metadata](environment.md)) and pushes one state object per tick to the renderer over the session's WebSocket. The renderer sends human inputs as they happen; on each tick the environment takes the latest input received for the human slot, or a noop if none arrived. The browser never simulates ahead.

This puts a plain constraint on the table: a human action only shows its effect after a network round trip. That is fine at modest tick rates and on nearby networks, and it is not a recipe for twitch games over the open internet. Realtime environments choose their tick rate with this in mind, and the Flappy Bird clone's tick rate is set low enough to stay playable.

Turn-based environments have no tick rate. The server steps them as actions arrive instead: an agent slot is stepped as soon as its agent returns an action, and the human slot waits until the human submits a move. Everything else about the loop is unchanged. The server stays authoritative, one state object goes out per step, and the browser never simulates ahead.

## Human input

For environments whose [metadata](environment.md) exposes a human slot, the renderer page also takes human input. Input can come from two complementary places, and each environment's renderer decides which to expose:

- **Raw device input.** Keyboard, mouse, gamepad, or touch, captured directly by the renderer page. Best for fast or action-paced games where low-friction control matters more than discoverability (Flappy Bird, racing games, anything realtime).
- **On-screen input UI.** Buttons, sliders, drag handles, action menus, board cells, card hands, or any other controls the renderer chooses to draw alongside the game. Useful when the action space is structured (a discrete menu of moves, a placement on a grid, a choice from a set), when the game is turn-based, or when raw device input would be awkward (touch devices, accessibility, complex action shapes). The on-screen UI is part of the renderer, so it gets the same per-step state object and can react to it (greying out illegal moves, highlighting the active player, showing whose turn it is).
A renderer can use both at once. For example, a turn-based game might accept either a keyboard shortcut or a click on the corresponding on-screen button.

Whatever the source, input is mapped into an action in the environment's action space and sent to the server, which feeds it into the human slot on the next tick (see the session loop above and [execution.md](execution.md)).

## Chat

For environments with messaging enabled (see [communication.md](communication.md)), the renderer also draws a chat panel as part of the on-screen UI. Broadcasts and messages addressed to the human appear there, and the human's outgoing messages travel the same WebSocket path as input, reaching the other slots on the next tick.
