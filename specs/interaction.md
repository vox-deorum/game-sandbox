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
- Timing.

The renderer never reaches behind the state object. If something needs to be drawn, it shows up in the payload.

## Human input

For environments whose [metadata](environment.md) exposes a human slot, the renderer page also takes human input. Input can come from two complementary places, and each environment's renderer decides which to expose:

- **Raw device input.** Keyboard, mouse, gamepad, or touch, captured directly by the renderer page. Best for fast or action-paced games where low-friction control matters more than discoverability (Flappy Bird, racing games, anything realtime).
- **On-screen input UI.** Buttons, sliders, drag handles, action menus, board cells, card hands, or any other controls the renderer chooses to draw alongside the game. Useful when the action space is structured (a discrete menu of moves, a placement on a grid, a choice from a set), when the game is turn-based, or when raw device input would be awkward (touch devices, accessibility, complex action shapes). The on-screen UI is part of the renderer, so it gets the same per-step state object and can react to it (greying out illegal moves, highlighting the active player, showing whose turn it is).

A renderer can use both at once. For example, a turn-based game might accept either a keyboard shortcut or a click on the corresponding on-screen button.

Whatever the source, input is mapped into an action in the environment's action space and delivered to whoever is driving the human slot in the active session. See [execution.md](execution.md) for where that driver lives in each deployment mode.
