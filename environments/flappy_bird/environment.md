# Flappy Bird

Flappy Bird is a one-button game. A small bird constantly falls, and pressing the button makes it flap upward. Your agent controls this button and tries to fly through gaps in pipes without crashing. The [agent interface](../../docs/students/agent-interface.md) explains the `reset` and `act` methods shared by every environment. This page covers everything specific to Flappy Bird.

## How the game works

Gravity pulls the bird down, and each flap gives it a small upward push. The bird stays about one fifth of the screen width from the left while pipes move in from the right at a constant speed. It must pass through each gap without touching a pipe or the ground. The game ends when the bird crashes.

> _Never played Flappy Bird?_ Try playing it first. The [Wikipedia article about Flappy Bird](https://en.wikipedia.org/wiki/Flappy_Bird) has some more background.

## Your first agent

Your template contains a complete working agent. This section explains how it makes each decision.

On every step, the runner calls `act` with an observation describing the bird and pipes, and your agent must return one action: flap or do nothing. The template's helper module gives readable names to the observation values and actions, so you do not need to work with unexplained numbers.

The starting agent reads `player_y` for the bird's height and `screen_height` for the screen's height, and returns `FLAP` or `IDLE`, its two actions. See [the helper module](#the-helper-module) below for the exact scales.

The strategy is one comparison: flap when the bird sits below the middle of the screen, otherwise let gravity pull it down. The comments inside `act` walk through the reasoning:

```python
from sandbox.features import FLAP, IDLE, player_y, screen_height


class Agent:
    """Flaps whenever the bird is below the middle of the screen."""

    def reset(self, seed: int) -> None:
        # Called once before each episode. This agent keeps no state between
        # steps, so there is nothing to prepare here; a learning agent would
        # reset its memory in this method.
        pass

    def act(self, observation) -> int:
        # player_y is the bird's height in real screen pixels, where 0 is the
        # top and screen_height(observation) is the bottom, so a larger value
        # means lower on the screen.
        below_middle = player_y(observation) > screen_height(observation) / 2

        # TODO(you): this is the whole strategy: flap when the bird sits below
        # mid-screen, otherwise let it fall. It holds a steady height but never
        # looks at the pipes, so it crashes at the first gap that is not at the
        # middle of the screen. The "Your first improvement" section of
        # environment.md shows you how to find the fix yourself.
        return FLAP if below_middle else IDLE
```

Run the agent from the template folder:

```console
python -m sandbox play    # watch it play, in your browser
python -m sandbox eval    # play several seeded episodes and report the mean score
python -m sandbox test    # run the checks
```

`eval` reports a score explained in [Scoring and rewards](#scoring-and-rewards).

The `TODO(you)` comment inside `act` marks the line to improve, because the starting agent never looks at the pipes. [Your first improvement](#your-first-improvement) walks you through what happens next and how to fix it, and this page is the `environment.md` file that the template comments mention.

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

The starting agent uses the template's `sandbox.features` helper module. Its functions read observation fields and its constants name the actions, so your code does not need unexplained expressions such as `observation["player"]["y"]` or `return 1`. Import the ones you need at the top of `agent.py`, not inside a method.

`player_y(observation)` returns the bird's vertical position in pixels. `next_gap_center(observation)` averages the top and bottom of the next pipe gap and returns the height to aim for on the same scale, falling back safely to the middle of the screen if an observation has no pipe ahead. `player_velocity(observation)` returns how far the bird moves vertically each step, so adding the position and the velocity estimates where it will be on the next step.

The module provides these helpers and constants:

| Helper or constant | Result |
| --- | --- |
| `player_x(observation)` | The bird's horizontal position in screen pixels |
| `player_y(observation)` | The bird's vertical position in screen pixels, `0` at the top and larger lower down |
| `player_velocity(observation)` | The bird's vertical velocity in pixels per step (positive is downward) |
| `next_pipe(observation)` | The nearest pipe ahead as `{x, gap_top, gap_bottom}`, or `None` if there is none |
| `next_gap_center(observation)` | The pixel height of the next gap's center, the height to aim for |
| `screen_width(observation)` | The screen width in pixels |
| `screen_height(observation)` | The screen height in pixels |
| `FLAP`, `IDLE` | The two actions, `1` (flap) and `0` (do nothing) |

## Under the hood

This is optional advanced reference material. The helpers above are the clearest way to write your first agent, so read on only if you want to use the observation dictionary directly.

Without the helpers, aiming the bird at the next pipe's gap means reading the observation's fields yourself:

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

The observation is one Python dictionary describing the bird, pipes, and screen. Each value is a screen coordinate or a small count:

```python
observation = {
    "player": {"x": ..., "y": ..., "vel_y": ..., "rot": ...},
    "pipes": (
        {"x": ..., "gap_top": ..., "gap_bottom": ...},  # next pipe first
        ...                                             # zero or more later pipes
    ),
    "pipes_passed": ...,   # how many pipes the bird has cleared so far
    "width": ...,          # screen width in pixels
    "height": ...,         # screen height in pixels
}
```

Every coordinate is a real screen pixel, not a fraction converted to a `0..1` scale. `width` and `height` give the screen size. `player["y"]` runs from `0` at the top to `height` at the bottom.

#### The player

`observation["player"]` describes the bird:

| Field | Meaning | Range or direction |
| --- | --- | --- |
| `x` | The bird sprite's left edge in pixels. | Roughly fixed; the bird does not move horizontally. |
| `y` | The bird sprite's top edge in pixels. | `0` at the top of the screen, `height` at the bottom. Larger is lower. |
| `vel_y` | The bird's vertical velocity in pixels per step. | Positive falls, negative climbs. The bird's next `y` is about `y + vel_y`. |
| `rot` | The bird's tilt in degrees, used to draw the sprite. | Most agents ignore it; there is no helper for it. |

Read these with `player_x`, `player_y`, and `player_velocity`, or reach into `observation["player"]` yourself.

#### The pipes

`observation["pipes"]` holds the pipes the bird has not fully passed, ordered from nearest to farthest by increasing `x`, so `pipes[0]` is the next pipe. Normal games continually keep upcoming pipes, but an empty tuple is still valid for a custom test state, so check it before reading `pipes[0]`, or use `next_pipe`, which returns `None` when it is empty.

| Field | Meaning |
| --- | --- |
| `x` | The pipe's left-edge pixel. Larger is farther right; the pipe scrolls left a fixed amount each step, so its `x` shrinks over time. A pipe leaves the observation after its right edge reaches the bird's left edge. |
| `gap_top` | The pixel `y` of the top edge of the gap (the bottom of the upper pipe). |
| `gap_bottom` | The pixel `y` of the bottom edge of the gap (the top of the lower pipe). |

Because `y` increases downward, `gap_top` is smaller than `gap_bottom`. The gap center is `(gap_top + gap_bottom) / 2`, which `next_gap_center` returns for the nearest pipe. The bird's `y` is its top edge, not its center, and the bird is 24 pixels tall. Aim comfortably inside the gap because a bird near an edge can still collide with the pipe. The observation does not include the constant horizontal pipe speed, but the distance between a pipe's `x` and `player["x"]` can help you time a flap.

#### The rest

`pipes_passed` counts the pipes cleared in the current game. `width` and `height` are the screen size in pixels, returned by the helpers `screen_width` and `screen_height`. Compare a raw `y` value with `height` to tell how far down the screen it is.

Here is one complete observation on a 288-by-512 screen:

```python
{
    "player": {"x": 57.0, "y": 244.0, "vel_y": 4.0, "rot": -12.0},
    "pipes": (
        {"x": 92.0, "gap_top": 170.0, "gap_bottom": 270.0},
        {"x": 236.0, "gap_top": 120.0, "gap_bottom": 220.0},
    ),
    "pipes_passed": 3,
    "width": 288,
    "height": 512,
}
```

The bird sits at `x = 57`, near the left, with the nearest pipe ahead at `x = 92`. That gap runs from `y = 170` down to `y = 270`, so its center is `220`. The bird's `y` of `244` is below that center, and its `vel_y` of `4` says it is falling, so a flap now would nudge it back up toward the gap.

## Pipe-gap setting

The pipe gap is the vertical opening between the upper and lower pipes. Local runs use the default gap of 100 pixels. A season may set any gap from 60 to 200 pixels, so read the gap from each observation instead of assuming a fixed opening.

## Time limits

Flappy Bird advances once every 50 milliseconds, or 20 steps per second, but that pace is not the agent's timeout. The usual limits are 1 second for each call to `act` and 120 seconds of measured computation during one game, and a season may use different limits. If `act` exceeds its limit, the environment uses action `0`, or `IDLE`, for that step. See [Time limits](../../docs/students/agent-interface.md#time-limits) for how the limits are measured and enforced.

## Your first improvement

Run `python -m sandbox play` and watch your agent until it crashes. What did you find out?

> The bird holds the middle of the screen no matter what is in front of it, so every run ends the same way: a gap arrives that is not at the middle, and the bird makes no attempt to reach it.

What height _should_ the bird aim for? Does the observation contain that answer?

> Scan the table in [The helper module](#the-helper-module) with that question in mind.

Record the average score from `python -m sandbox eval` before changing anything. Make one change, then run `eval` again. A single run can be lucky or unlucky, so compare the averages across the seeded games.

When it works, keep watching. The bird chases every gap now, but it still clips a pipe from time to time, usually because it arrives at the right height moving too fast to stay there. Your agent knows more than where the bird _is_. What does it know about where the bird is about to be?

When your agent plays well, the [submitting guide](../../docs/students/submitting.md) shows how to submit it.
