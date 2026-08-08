# Flappy Bird

Flappy Bird is a one-button game. A small bird constantly falls, and pressing the button makes it flap upward. Your agent controls this button and tries to fly through gaps in pipes without crashing. The [agent interface](../../docs/students/agent-interface.md) explains the `reset` and `act` methods shared by every environment. This page covers everything specific to Flappy Bird.

After you complete [Getting Started](../../docs/students/getting-started.md), open `agent.py`, run `python -m sandbox play`, then follow [Your first agent](#your-first-agent).

## How the game works

Gravity pulls the bird down, and each flap gives it a small upward push. The bird stays about one fifth of the screen width from the left while pipes move in from the right at a constant speed. It must pass through each gap without touching a pipe or the ground. The game ends when the bird crashes.

> _Never played Flappy Bird?_ Try playing it first. The [Wikipedia article about Flappy Bird](https://en.wikipedia.org/wiki/Flappy_Bird) has some more background.

## Your first agent

Your template contains a working agent. On every step, `act` receives an observation of the bird and pipes and returns `FLAP` or `IDLE`. The helper module provides readable names for the observation values and actions.

The starting strategy uses one comparison: flap when the bird sits below the middle of the screen, otherwise let gravity pull it down. It reads the bird and screen heights to make that decision. See [The helper module](#the-helper-module) for the exact scales, and follow the comments inside `act` for the reasoning:

```python
from sandbox.features import FLAP, IDLE, FlappyObservation, player_y, screen_height


class Agent:
    """Flaps whenever the bird is below the middle of the screen."""

    def reset(self, seed: int) -> None:
        # Called once before each episode. This agent keeps no state between
        # steps, so there is nothing to prepare here; a learning agent would
        # reset its memory in this method.
        pass

    def act(self, observation: FlappyObservation) -> int:
        # player_y is a real screen coordinate, where 0 is the top and a
        # larger value means lower on the screen.
        below_middle = player_y(observation) > screen_height(observation) / 2

        # TODO(you): this holds a steady height but never looks at the pipes.
        return FLAP if below_middle else IDLE
```

Run the agent from the template folder:

```console
python -m sandbox play    # watch it play, in your browser
python -m sandbox eval    # play several seeded episodes and report the mean score
python -m sandbox test    # run the checks
```

`eval` reports the score from [Scoring and rewards](#scoring-and-rewards).

## Scoring and rewards

The environment returns one reward after each action:

| Reward | Meaning |
| --- | --- |
| `+0.1` | The bird stayed alive on a step when it did not pass a pipe. |
| `+1.0` | The bird passed a pipe on this step. This replaces the usual `+0.1` for that step. |
| `-0.5` | The bird flew above the top of the screen on this step but did not crash. |
| `-1.0` | The bird crashed, ending the episode. |

The rewards add together during a run, and a higher total usually means the bird survived longer and cleared more pipes.

## The helper module

The starting agent uses the template's `sandbox.features` helper module. Import what you need at the top of `agent.py`. The helpers avoid raw expressions such as `observation["player"]["y"]` and `return 1`.

`player_y(observation)` returns the bird's vertical position in pixels. `next_gap_center(observation)` returns the gap center of the first observed pipe whose right edge remains beyond the bird's left edge, on the same scale. It safely falls back to the middle of the screen when there is no such pipe. `player_velocity(observation)` returns how far the bird moves vertically each step, so adding it to the position estimates the bird's position on the next step.

`FlappyObservation`, the observation shape, is also importable from `sandbox.features`.

The module provides these helpers and constants:

| Helper or constant | Result |
| --- | --- |
| `player_x(observation)` | The bird's horizontal position in screen pixels |
| `player_y(observation)` | The bird's vertical position in screen pixels, `0` at the top and larger lower down |
| `player_velocity(observation)` | The bird's vertical velocity in pixels per step (positive is downward) |
| `next_pipe(observation)` | The first observed pipe whose right edge is still beyond the bird's left edge, as `{x, gap_top, gap_bottom}`, or `None` if there is none |
| `next_gap_center(observation)` | The pixel height of the next gap's center, the height to aim for |
| `screen_width(observation)` | The screen width in pixels |
| `screen_height(observation)` | The screen height in pixels |
| `FLAP`, `IDLE` | The two actions, `1` (flap) and `0` (do nothing) |

## Your first improvement

The starting agent aims for the middle of the screen instead of the next pipe gap. For your first improvement, add `next_gap_center` to the import, replace `screen_height(observation) / 2` with `next_gap_center(observation)`, then run `python -m sandbox play`.

```python
target_y = next_gap_center(observation)
return FLAP if player_y(observation) > target_y else IDLE
```

Record the mean score from `python -m sandbox eval` before and after the edit. Compare seeded averages, not one lucky run. Once the bird tracks gaps, use `player_velocity` to account for where it will be on the next step.

When your agent plays well, the [submitting guide](../../docs/students/submitting.md) explains how to submit it.

## Under the hood

This optional reference explains how to use the observation dictionary directly. The helpers above are the clearest way to write your first agent.

Without the helpers, aiming the bird at the first observed pipe's gap means reading the observation's fields yourself:

```python
pipes = observation["pipes"]
if pipes:
    gap_center = (pipes[0]["gap_top"] + pipes[0]["gap_bottom"]) / 2
    return 1 if observation["player"]["y"] > gap_center else 0
return 0
```

### Actions

Your `act` method returns one number on every step:

| Action | Name in `sandbox.features` | Meaning |
| --- | --- | --- |
| `0` | `IDLE` | Do nothing. Gravity continues to pull the bird downward. |
| `1` | `FLAP` | Flap once. The bird gets an upward push. |

Here, `0` and `1` are labels, not directions or screen positions. The environment rejects any other number. Both actions are always legal, so Flappy Bird does not need a list of legal moves.

### Observations

The observation is a Python dictionary of real screen pixels and small counts. `player["y"]` uses `0` at the top, can be negative while the bird is above the screen, and increases downward.

| Key | Value |
| --- | --- |
| `player` | A dictionary with the bird's position, vertical velocity, and tilt |
| `pipes` | A tuple of pipe dictionaries whose right edge is still beyond the bird's left edge, nearest first |
| `pipes_passed` | The count of pipes cleared in this episode |
| `width`, `height` | Screen dimensions in pixels |

#### The player

`observation["player"]` describes the bird:

| Field | Meaning | Range or direction |
| --- | --- | --- |
| `x` | The bird sprite's left edge in pixels. | Roughly fixed; the bird does not move horizontally. |
| `y` | The bird sprite's top edge in pixels. | `0` at the top of the screen. Larger is lower, and the bird collides with the ground before its top edge reaches `height`. |
| `vel_y` | The bird's vertical velocity in pixels per step. | Positive falls, negative climbs. The bird's next `y` is about `y + vel_y`. |
| `rot` | The bird's tilt in degrees, used to draw the sprite. | Most agents ignore it; there is no helper for it. |

Use `player_x`, `player_y`, and `player_velocity`, or read `observation["player"]` directly.

#### The pipes

`observation["pipes"]` holds pipes whose right edge is still beyond the bird's left edge, ordered from nearest to farthest. The first item, `pipes[0]`, is the first observed pipe that has not fully moved past the bird. The sequence can be empty in a custom test state, so check before reading it or use `next_pipe`.

| Field | Meaning |
| --- | --- |
| `x` | The pipe's left-edge pixel. Larger is farther right; the pipe scrolls left a fixed amount each step, so its `x` shrinks over time. A pipe leaves the observation after its right edge reaches the bird's left edge. |
| `gap_top` | The pixel `y` of the top edge of the gap (the bottom of the upper pipe). |
| `gap_bottom` | The pixel `y` of the bottom edge of the gap (the top of the lower pipe). |

Because `y` increases downward, `gap_top` is smaller than `gap_bottom`. `next_gap_center` returns the nearest gap center. The bird's `y` is its top edge, and the bird is 24 pixels tall, so aim inside the gap. Pipe speed is not observed, but the distance from a pipe's `x` to `player["x"]` can help time a flap.

#### The rest

`pipes_passed` counts pipes cleared in the episode. `width` and `height` are screen dimensions in pixels, available through `screen_width` and `screen_height`.

## Pipe-gap setting

The pipe gap is the vertical opening between the upper and lower pipes. Local runs use the default gap of 100 pixels. A season may set any gap from 60 to 200 pixels, so read the gap from each observation instead of assuming a fixed opening. Use **Set Up Locally** on My Submissions to download the season's setting into your template.

Most starter strategies do not need to read the season setting directly. It matters when you tune how much room to leave from a pipe edge: narrower gaps reward earlier, gentler corrections, while wider gaps allow more vertical movement before the next pipe arrives.

## Time limits

Flappy Bird advances once every 50 milliseconds, or 20 steps per second, but that pace is not the agent's timeout. The usual limits are 1 second for each call to `act` and 120 seconds of measured computation during one game, and a season may use different limits. If `act` exceeds its limit, the environment uses action `0`, or `IDLE`, for that step. See [Time limits](../../docs/students/agent-interface.md#time-limits) for how the limits are measured and enforced.
