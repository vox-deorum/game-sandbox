# Environments

Every environment exposes a [PettingZoo](https://pettingzoo.farama.org/) interface. Native multi-agent games implement it directly. A general compatibility wrapper lifts single-agent Gymnasium games into a one-slot PettingZoo environment.

The rest of the system therefore sees one shape:

```text
Gymnasium game → single-agent wrapper ┐
                                      ├→ PettingZoo interface → session harness
Native multi-agent game ──────────────┘
```

Every environment accepts a seed on reset so controlled repetitions can be compared. See [Leaderboards](leaderboard.md).

## Metadata layers

Metadata has two layers:

| Layer | Examples | Used by |
| --- | --- | --- |
| PettingZoo | Action space, observation space, agent IDs, rewards | Agent and environment loop |
| Game Sandbox | Display text, slot counts, human slots, timing, capabilities, renderer | Website, scheduler, session controls |

Game Sandbox metadata includes:

- Display name and description.
- Minimum and maximum slots.
- Human-capable slots and their default timeout.
- Recommended episode length.
- Pace interval, or no interval for turn-based play.
- Default step and episode compute limits.
- Messaging availability and message cap.
- LLM API availability.
- Whether seat order changes the game.
- Renderer identifier.

A season may override the timing, messaging, and LLM defaults. See [Leaderboards](leaderboard.md).

The **pace interval** is the only distinction between realtime and turn-based stepping. A set interval advances on a wall-clock cadence. No interval advances when the acting slot provides an action. See [Interaction](interaction.md).

## First environment

The first environment is a Flappy Bird style single-agent game using the compatibility wrapper. The same registry and session loop support later multi-agent environments.
