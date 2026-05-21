# Interaction: Rendering and Input

This file covers how a game looks in the browser and how human input flows back to the game.

## Custom renderer per environment

Every environment has a dedicated frontend renderer. We do not stream pixels or video from the server, and we do not fall back to server-rendered frames for any environment. Streaming is too much bandwidth and too much latency for the kinds of games we host, and it makes replays second-class. Writing a small renderer per environment is straightforward, and we accept that cost up front.

A renderer is a frontend module that takes a per-step state object and draws the current frame. The same renderer is used for live play and for replays, so anything that can be shown live can also be shown in a replay (see [recording.md](recording.md)).

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

For environments whose [metadata](environment.md) exposes a human slot, the renderer page also accepts human input (keyboard, mouse, or touch where appropriate). Input is captured in the browser, mapped to an action in the environment's action space, and delivered to whoever is driving the human slot in the active session. See [execution.md](execution.md) for where that driver lives in each deployment mode.
