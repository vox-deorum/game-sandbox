# Flappy Bird

Flappy Bird is a one-button game in which a small bird constantly falls, a flap pushes it upward, and the goal is to fly through gaps in a series of pipes without hitting anything. Your agent controls the button. The [agent interface](../agent-interface.md) explains the parts that work the same in every environment, including the `reset` and `act` methods. This page explains everything specific to Flappy Bird.

## How the game works

The bird falls under gravity, and each flap gives it a small upward push. The bird never moves horizontally. It stays about one fifth of the screen width from the left while the pipes scroll in from the right at a constant speed. Each pipe has a gap, and the bird must pass through the gap without touching the pipe or the ground. The game continues until the bird crashes.

If you have never seen the game, the [Wikipedia article about Flappy Bird](https://en.wikipedia.org/wiki/Flappy_Bird) provides some background. The rule you need to build an agent is simple: flap at the right moments or crash.

## Your first agent

Your template already contains a complete, working agent, the one this section builds. It runs before you change anything, and the rest of this section explains it line by line so you can see exactly how each step is decided.

On every step the harness calls `act` with an observation of the bird and the pipes, and your job is to return one action: flap or do nothing. You don't have to read raw numbers to decide: the template's helper module gives the observation's values readable names, and this agent uses two of them, plus the names of the two actions.

`player_y(observation)` is the bird's height in real screen pixels, measured from the top of the screen, where `0` is the very top and `screen_height(observation)` is the bottom, so a larger value means the bird is lower.

`screen_height(observation)` is the height of the screen in pixels, so half of it is the middle of the screen.

`FLAP` and `IDLE` are the two actions, the readable names for `1` (flap once) and `0` (do nothing).

The strategy is one comparison: if the bird is below the middle of the screen, flap to climb; otherwise let gravity pull it down. The bird settles around the middle of the screen and holds that height, but it pays no attention to where the gaps in the pipes actually are.

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

Both actions are always allowed in Flappy Bird, so this agent will not make an illegal move. There is no action mask to read; you only choose between flapping and falling.

With the agent already in place, you can run it straight away from the template folder:

```console
python -m sandbox play    # watch it play, in a window
python -m sandbox eval    # play several seeded episodes and report the mean score
python -m sandbox test    # run the checks, which pass before you change anything
```

`eval` reports a score you can read with the [Scoring and rewards](#scoring-and-rewards) section below, and `test` is green on the fresh template because this agent is already complete.

The `TODO(you)` comment inside `act` marks the one line where you take over. This agent never looks at the pipes, so it survives only until the first gap that sits away from the middle of the screen. When you are ready, the [Your first improvement](#your-first-improvement) section shows you how to find the fix yourself. In your own repository this page is the `environment.md` file, which is what the template's comments point to.

## Scoring and rewards

The environment returns one reward after each action:

| Reward | Meaning |
| --- | --- |
| `+0.1` | The bird stayed alive on a step when it did not pass a pipe. |
| `+1.0` | The bird passed a pipe on this step. This replaces the usual `+0.1` for that step. |
| `-0.5` | The bird flew above the top of the screen on this step but did not crash. |
| `-1.0` | The bird crashed, ending the episode. |

The rewards add together over a run. A higher total generally means the bird survived longer and cleared more pipes. Evaluating several seeded runs with `python -m sandbox eval` gives a more reliable result than judging an agent from one run.

## The helper module

Your first agent used `sandbox.features`, the template's plain Python helper module. Import what you need from it at the top of `agent.py`, not inside a method. Its functions and constants read the observation's fields and name the two actions, so your code doesn't have to contain an unexplained `observation["player"]["y"]` or `return 1`.

`player_y(observation)` returns the bird's height in screen pixels. `next_gap_center(observation)` averages the top and bottom of the next pipe's gap and returns the pixel height the bird should aim for, on the same scale as `player_y`; when there is no pipe ahead it falls back to the middle of the screen. `player_velocity(observation)` returns the bird's vertical velocity in pixels per step, the same scale as `player_y`, so adding the two estimates where the bird will be next step.

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

Your first agent didn't have to touch the raw observation or a raw action integer; the helpers handled both. This section is the full reference for what the observation contains and what `act` returns, for when you outgrow the helpers and want to read the observation yourself.

Without the helpers, a decision that aims the bird at the next pipe's gap reads the object's fields directly:

```python
pipes = observation["pipes"]
if pipes:
    gap_center = (pipes[0]["gap_top"] + pipes[0]["gap_bottom"]) / 2
    return 1 if observation["player"]["y"] > gap_center else 0
return 0
```

### Actions

Your `act` method must return one integer on every step:

| Action | Name in `sandbox.features` | Meaning |
| --- | --- | --- |
| `0` | `IDLE` | Do nothing. Gravity continues to pull the bird downward. |
| `1` | `FLAP` | Flap once. The bird gets an upward push. |

Here, `0` and `1` are action labels. They do not describe a direction or a screen position. Returning any other integer is invalid and the environment rejects it. Both actions are always legal, so unlike the card games Flappy Bird carries **no action mask**. If your agent misses a step's deadline, the environment uses action `0`, so the bird keeps falling.

### Observations

The observation is a single object (a Python dict) describing the bird, the pipes, and the screen. There is no `action_mask` key and no 52-long array anywhere: every value is either a real screen coordinate or a small count. It has this shape:

```python
observation = {
    "player": {"x": ..., "y": ..., "vel_y": ..., "rot": ...},
    "pipes": (
        {"x": ..., "gap_top": ..., "gap_bottom": ...},   # nearest pipe first
        ...                                              # zero or more further pipes
    ),
    "pipes_passed": ...,   # how many pipes the bird has cleared so far
    "width": ...,          # screen width in pixels
    "height": ...,         # screen height in pixels
}
```

Every coordinate is a **real screen pixel**, not a normalized fraction. There is no fixed `0..1` scale to undo: `width` and `height` tell you how large the screen is, and `player["y"]` runs from `0` at the top to `height` at the bottom.

#### The player

`observation["player"]` describes the bird:

| Field | Meaning | Range or direction |
| --- | --- | --- |
| `x` | The bird's horizontal position, its left-to-right pixel on the screen. | Roughly fixed; the bird does not move horizontally. |
| `y` | The bird's vertical position in pixels. | `0` at the top of the screen, `height` at the bottom. Larger is lower. |
| `vel_y` | The bird's vertical velocity in pixels per step. | Positive falls, negative climbs. The bird's next `y` is about `y + vel_y`. |
| `rot` | The bird's tilt in degrees, used to draw the sprite. | Most agents ignore it; there is no helper for it. |

Read these with `player_x`, `player_y`, and `player_velocity`, or reach into `observation["player"]` yourself.

#### The pipes

`observation["pipes"]` is a tuple with one entry per pipe on screen, **ordered nearest-first** (ascending `x`), so `pipes[0]` is the next pipe to clear. It may be **empty** when no pipe is on screen, so guard for that (or use `next_pipe`, which returns `None` in that case) before reading `pipes[0]`.

| Field | Meaning |
| --- | --- |
| `x` | The pipe's left-edge pixel. Larger is farther right; the pipe scrolls left a fixed amount each step, so its `x` shrinks over time. |
| `gap_top` | The pixel `y` of the top edge of the gap (the bottom of the upper pipe). |
| `gap_bottom` | The pixel `y` of the bottom edge of the gap (the top of the lower pipe). |

Because `y` grows downward, `gap_top` is the smaller number and `gap_bottom` the larger one, and the bird clears the pipe by keeping its `y` between them. The gap's center is `(gap_top + gap_bottom) / 2`, which `next_gap_center` returns for the nearest pipe. Horizontal pipe speed is constant and is not part of the observation, but you can gauge timing from how far a pipe's `x` is ahead of `player["x"]`.

#### The rest

`pipes_passed` is how many pipes the bird has flown through so far this episode, a plain count. `width` and `height` are the screen size in pixels; `screen_width` and `screen_height` return them, and `height` is what turns a raw `y` into "how far down the screen."

Here is one complete observation on a 288-by-512 screen:

```python
{
    "player": {"x": 57.0, "y": 244.0, "vel_y": 4.0, "rot": -12.0},
    "pipes": (
        {"x": 92.0, "gap_top": 180.0, "gap_bottom": 300.0},
        {"x": 236.0, "gap_top": 120.0, "gap_bottom": 240.0},
    ),
    "pipes_passed": 3,
    "width": 288,
    "height": 512,
}
```

The bird sits at `x = 57`, near the left, with the nearest pipe ahead at `x = 92`. That gap runs from `y = 180` down to `y = 300`, so its center is `240`. The bird's `y` of `244` is just below that center, and its `vel_y` of `4` says it is falling, so a flap now would nudge it back up toward the gap.

## Time limits

Flappy Bird is paced at one step every 50 milliseconds, or 20 steps per second. This number controls how quickly the live game advances; it is not the agent's timeout. An individual call to `act` has a 1-second limit, and the agent has a 120-second limit on its total measured compute during one episode. If `act` exceeds the 1-second limit, the environment uses action `0`, `IDLE`, for that step. See [Time limits](../agent-interface.md#time-limits) for how these limits are enforced and measured.

## Your first improvement

Run `python -m sandbox play` and watch your agent until it crashes. What did you find out?

> The bird holds the middle of the screen no matter what is in front of it, so every run ends the same way: a gap arrives that is not at the middle, and the bird makes no attempt to reach it.

Now, what height _should_ the bird be aiming for, do we have an answer in the observation?

> Scan the table in [The helper module](#the-helper-module) with that question in mind.

Record the mean score from `python -m sandbox eval` before you touch anything, make the one change you believe in, and run `eval` again. A single run can be lucky or unlucky, so trust the mean over the seeded episodes, not one game.

When it works, keep watching. The bird now chases every gap, and it still clips a pipe now and then, usually because it arrives at the right height moving too fast to stay there. Your agent knows more than where the bird _is_. What does it know about where the bird is about to be?
