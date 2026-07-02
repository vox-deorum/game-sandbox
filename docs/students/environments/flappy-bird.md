# Flappy Bird

Flappy Bird is a one-button game in which a small bird constantly falls, a flap pushes it upward, and the goal is to fly through gaps in a series of pipes without hitting anything. Your agent controls the button. The [agent interface](../agent-interface.md) explains the parts that work the same in every environment, including the `reset` and `act` methods. This page explains everything specific to Flappy Bird.

## How the game works

The bird falls under gravity, and each flap gives it a small upward push. The bird never moves horizontally. It stays about one fifth of the screen width from the left while the pipes scroll in from the right at a constant speed. Each pipe has a gap, and the bird must pass through the gap without touching the pipe or the ground. The game continues until the bird crashes.

If you have never seen the game, the [Wikipedia article about Flappy Bird](https://en.wikipedia.org/wiki/Flappy_Bird) provides some background. The rule you need to build an agent is simple: flap at the right moments or crash.

## Actions

Your `act` method must return one integer on every step:

| Action | Name in `sandbox.features` | Meaning |
| --- | --- | --- |
| `0` | `IDLE` | Do nothing. Gravity continues to pull the bird downward. |
| `1` | `FLAP` | Flap once. The bird gets an upward push. |

Here, `0` and `1` are action labels. They do not describe a direction or a screen position. Returning any other integer is invalid and the environment rejects it. If your agent misses a step's deadline, the environment uses action `0`, so the bird keeps falling.

## Observations

The observation is a NumPy array of 12 numbers. It describes three pipes in left-to-right order, followed by the bird. An **index** tells you where a value appears in the array. Python starts counting at `0`, so index `0` is the first number, index `1` is the second number, and index `11` is the twelfth and final number. An index is not a screen position and is not the value stored there.

| Index | Name in `sandbox.features` | Meaning | Range or special value |
| --- | --- | --- | --- |
| 0 | `LAST_PIPE_X` | Left edge of the leftmost pipe in this observation | May be negative after leaving the screen |
| 1 | `LAST_PIPE_GAP_TOP` | Top edge of that pipe's gap | `0` at the top of the screen, `1` at the bottom |
| 2 | `LAST_PIPE_GAP_BOTTOM` | Bottom edge of that pipe's gap | `0` at the top of the screen, `1` at the bottom |
| 3 | `NEXT_PIPE_X` | Left edge of the middle pipe in this observation | `0` at the left edge, `1` at the right edge |
| 4 | `NEXT_PIPE_GAP_TOP` | Top edge of the middle pipe's gap | `0` at the top of the screen, `1` at the bottom |
| 5 | `NEXT_PIPE_GAP_BOTTOM` | Bottom edge of the middle pipe's gap | `0` at the top of the screen, `1` at the bottom |
| 6 | `NEXT_NEXT_PIPE_X` | Left edge of the rightmost pipe in this observation | `0` at the left edge, `1` at the right edge |
| 7 | `NEXT_NEXT_PIPE_GAP_TOP` | Top edge of that pipe's gap | `0` at the top of the screen, `1` at the bottom |
| 8 | `NEXT_NEXT_PIPE_GAP_BOTTOM` | Bottom edge of that pipe's gap | `0` at the top of the screen, `1` at the bottom |
| 9 | `PLAYER_Y` | Vertical position of the top of the bird | `0` at the top of the screen, `1` at the bottom |
| 10 | `PLAYER_VELOCITY` | Bird's vertical speed and direction | Negative is upward, `0` is stopped vertically, positive is downward |
| 11 | `PLAYER_ROTATION` | Bird's tilt | Negative is nose-down, `0` is level, positive is nose-up |

The three pipe triples are sorted by `X` on every step. The names in `sandbox.features` describe a common moment when the leftmost pipe has just passed the bird, but those roles are not permanent. Early in a run, `LAST_PIPE_X` can still be the first pipe approaching the bird. After a pipe leaves the screen and reappears on the right, the triples shift again. Use the `X` values to tell which pipes are ahead of the bird rather than relying only on `LAST`, `NEXT`, and `NEXT_NEXT` in the names.

### Horizontal positions

Horizontal values use the screen width as a scale. `X = 0` is the left edge of the screen, `X = 0.5` is halfway across, and `X = 1` is the right edge. Larger values are farther right. A negative value is left of the visible screen.

Each pipe's `X` value locates the pipe's left edge. The bird stays at about `X = 0.20`, so a pipe at `X = 0.55` is `0.35` screen widths ahead of the bird. As the pipe scrolls left, its value gets smaller. A pipe reaches the bird when its value is near `0.20`, not when it reaches `0`.

Every pipe scrolls left at the same constant speed: about `0.014` screen widths per step, available as `PIPE_SPEED` in `sandbox.features`. This horizontal velocity is not part of the observation because it never changes, but it lets you predict timing. A pipe `0.35` screen widths ahead of the bird arrives in about `0.35 / 0.014 ≈ 25` steps, which is 1.25 seconds at 20 steps per second.

### Vertical positions

Vertical values use the screen height as a scale, and the direction may feel backward if you are used to graphs in math class. `Y = 0` is the top of the screen, `Y = 0.5` is halfway down, and `Y = 1` is the bottom. Larger values are lower on the screen. A negative value is above the visible screen.

The ground begins before the bottom of the screen, so the bird normally crashes before `PLAYER_Y` reaches `1`. Suppose the next gap has a top value of `0.24` and a bottom value of `0.43`. The gap starts 24 percent of the way down the screen and ends 43 percent of the way down. Its center is `(0.24 + 0.43) / 2 = 0.335`.

### Velocity and rotation

Velocity and rotation use scales centered on `0`:

| Value | Negative | `0` | Positive |
| --- | --- | --- | --- |
| `PLAYER_VELOCITY` | The bird is moving upward. A flap sets this to about `-0.9`. | The bird is not moving vertically at that instant. | The bird is falling. `1` is its maximum downward speed. |
| `PLAYER_ROTATION` | The bird's nose points downward. `-1` is 90 degrees down. | The bird is level. | The bird's nose points upward. A flap sets this to `0.5`, or 45 degrees up. |

To work with velocity, call `player_velocity(observation)` from `sandbox.features`. It returns the bird's vertical velocity in screen heights per step, the same scale as `PLAYER_Y`. Therefore, adding the two estimates the bird's next position: with a velocity of `0.008` and `PLAYER_Y = 0.44`, the bird will be near `0.44 + 0.008 = 0.448` on the next step. Gravity adds about `0.002` to the velocity before each idle movement, so treat the sum as an estimate rather than an exact prediction.

If you read `observation[PLAYER_VELOCITY]` directly: the raw value uses a different scale, normalized by the bird's maximum fall speed, so `0.40` there means 40 percent of top speed, not 40 percent of the screen.

### Pipes that are not visible yet

A pipe that has not entered the screen appears as three values: `1.00, 0.00, 1.00`. These mean that its left edge is parked at the right edge of the screen (`X = 1`) and its temporary gap runs from the top (`Y = 0`) to the bottom (`Y = 1`). This is a placeholder, not the pipe's real gap, so it provides no useful vertical target yet.

Here is one complete observation, grouped by what its values describe:

```text
# nearest pipe       next pipe            pipe after next       bird
[0.05, 0.42, 0.61,   0.55, 0.24, 0.43,   1.00, 0.00, 1.00,     0.44, 0.40, -0.30]
```

In this particular snapshot, the leftmost pipe at `X = 0.05` has passed the bird and the middle pipe at `X = 0.55` is the next obstacle. Its gap runs from `Y = 0.24` to `Y = 0.43`. The bird is below the center of that gap because `0.44 > 0.335`. Its velocity `0.40` says it is falling, and its rotation `-0.30` means its nose points about 27 degrees downward.

## Scoring and rewards

The environment returns one reward after each action:

| Reward | Meaning |
| --- | --- |
| `+0.1` | The bird stayed alive on a step when it did not pass a pipe. |
| `+1.0` | The bird passed a pipe on this step. This replaces the usual `+0.1` for that step. |
| `-0.5` | The bird flew above the top of the screen on this step but did not crash. |
| `-1.0` | The bird crashed, ending the episode. |

The rewards add together over a run. A higher total generally means the bird survived longer and cleared more pipes. Evaluating several seeded runs with `python -m sandbox eval` gives a more reliable result than judging an agent from one run.

## Time limits

Flappy Bird is paced at one step every 50 milliseconds, or 20 steps per second. This number controls how quickly the live game advances; it is not the agent's timeout. An individual call to `act` has a 1-second limit, and the agent has a 120-second limit on its total measured compute during one episode. If `act` exceeds the 1-second limit, the environment uses action `0`, `IDLE`, for that step. See [Time limits](../agent-interface.md#time-limits) for how these limits are enforced and measured.

## Template helpers

The template includes a plain Python module named `sandbox.features`. Import from it at the top of `agent.py`. Its constants give readable names to the 12 observation indices and the two actions, so your code does not need unexplained numbers such as `observation[4]` or `return 1`.

For example, this code uses raw indices and action numbers:

```python
gap_center = (observation[4] + observation[5]) / 2
if observation[9] > gap_center:
    return 1
return 0
```

The helpers express the same decision in terms of the game:

```python
from sandbox.features import FLAP, IDLE, next_gap_center, player_y

def act(self, observation):
    if player_y(observation) > next_gap_center(observation):
        return FLAP
    return IDLE
```

`next_gap_center(observation)` averages indices 4 and 5, the gap boundaries in the middle pipe triple, and returns a plain float. In the example snapshot above, that middle pipe is the next obstacle. `player_y(observation)` returns the top of the bird as a plain float. Because larger y values are lower, `player_y > next_gap_center` means the bird is below that target and should flap. `player_velocity(observation)` returns the bird's vertical velocity converted to screen heights per step; it is the one helper that changes a value's scale instead of only naming an index, and the [Velocity and rotation](#velocity-and-rotation) section explains why the conversion exists.

This small agent demonstrates how to compare vertical positions, but it ignores velocity and assumes the middle pipe is the right target. A stronger agent should first use the three `X` values to identify the approaching pipe, then account for how quickly the bird is moving.

## Ideas and examples

A good way to improve is one idea at a time:

- **Add a margin.** Flapping as soon as the bird drops below the exact center can make it jitter. Try waiting until it is a little below the target, or aim for another point inside the gap.
- **Use velocity.** `player_y(observation) + player_velocity(observation)` estimates where the bird will be on the next step, since the helper converts velocity to screen heights per step. Gravity adds about `0.002` on an idle step. Compare that prediction to your target instead of the current position, so the agent reacts before it overshoots.
- **Look ahead.** When the next pipe is close to the bird, start moving the target toward the gap in the pipe after it. `NEXT_PIPE_X` tells you when the current pipe is close.
- **Respect the edges.** Flying above the top costs reward and touching the ground ends the run, so keep targets away from both extremes.
- **Measure changes.** Watch a run to build intuition, then compare averages over several seeded runs. One run may be unusually lucky or unlucky.

The [Hello Flappy Bird agent](https://github.com/vox-deorum/game-sandbox/blob/main/examples/flappy_bird/hello/agent.py) is a complete worked example that uses `sandbox.features`.
