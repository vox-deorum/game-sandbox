# Flappy Bird

Flappy Bird is the famously unforgiving one-button game from 2013: a small bird constantly falls, a tap makes it flap upward, and the goal is to fly through the gaps in an endless series of pipes without hitting anything. If you have never seen it, the [Wikipedia article](https://en.wikipedia.org/wiki/Flappy_Bird) tells the story, but the game itself fits in one sentence — flap at the right moments, or crash.

Your agent is the finger on the button. The game runs in real time, and on every step it shows your agent a snapshot of the world and asks for one of two actions: flap, or do nothing. The parts that work the same in every environment — the `reset` and `act` methods, the manifest, and how time limits are enforced — are covered in the [agent interface](../agent-interface.md); everything specific to Flappy Bird is here.

## How the game works

The bird falls under gravity, and each flap gives it a small upward push. The bird never moves horizontally — it hovers at about one fifth of the screen width while the pipes scroll in from the right at a constant speed. Each pipe has a gap, and the bird must pass through the gap without touching the pipe or the ground. The game gets no harder over a run: it simply continues, pipe after pipe, until the bird crashes.

## Observations

The observation is a NumPy array of 12 numbers. It describes three pipes (the one the bird most recently passed, the next one it must clear, and the one after that) and then the bird itself.

Remembering which index means what is a chore, so a helper module named `sandbox.features` sits next to your agent and names every index. It is plain Python with no heavy dependencies, so import what you need at the top of `agent.py`:

```python
from sandbox.features import NEXT_PIPE_GAP_TOP, PLAYER_Y
```

The table below lists all 12 indices with their names. The example column is one real snapshot taken mid-flight, so you can see how the numbers hang together.

| Index | Name in `sandbox.features` | Meaning | Example |
| --- | --- | --- | --- |
| 0 | `LAST_PIPE_X` | Last pipe (just passed): horizontal position | `0.05` |
| 1 | `LAST_PIPE_GAP_TOP` | Last pipe: top of the gap | `0.42` |
| 2 | `LAST_PIPE_GAP_BOTTOM` | Last pipe: bottom of the gap | `0.61` |
| 3 | `NEXT_PIPE_X` | Next pipe (the one to fly through): horizontal position | `0.55` |
| 4 | `NEXT_PIPE_GAP_TOP` | Next pipe: top of the gap | `0.24` |
| 5 | `NEXT_PIPE_GAP_BOTTOM` | Next pipe: bottom of the gap | `0.43` |
| 6 | `NEXT_NEXT_PIPE_X` | Pipe after next: horizontal position | `1.00` |
| 7 | `NEXT_NEXT_PIPE_GAP_TOP` | Pipe after next: top of the gap | `0.00` |
| 8 | `NEXT_NEXT_PIPE_GAP_BOTTOM` | Pipe after next: bottom of the gap | `1.00` |
| 9 | `PLAYER_Y` | Bird: vertical position | `0.44` |
| 10 | `PLAYER_VELOCITY` | Bird: vertical velocity | `0.40` |
| 11 | `PLAYER_ROTATION` | Bird: rotation | `-0.30` |

A few conventions make these numbers readable:

- **Everything is normalized.** Horizontal positions are fractions of the screen width and vertical positions are fractions of the screen height, so all values sit roughly between `-1` and `1`, and the pipe edges compare directly with the bird's own height.
- **The y axis grows downward.** A _larger_ vertical value is _lower_ on the screen. This is the single easiest thing to get backwards — if your first agent flies straight into the sky, you probably compared heights the wrong way around.
- **The bird sits at `0.2` horizontally.** Since the bird never moves sideways, a pipe's horizontal position tells you how far away it is: the next pipe at `0.55` is about a third of a screen ahead, and the number shrinks every step as the pipe scrolls closer.
- **Velocity is positive when falling.** A flap makes it sharply negative, then gravity pulls it back up toward positive. In the snapshot the bird is falling briskly at `0.40`.
- **Rotation is cosmetic at first.** Positive tilts the bird's nose up (right after a flap), negative tilts it down (in a dive). You can safely ignore it in your early agents.
- **A pipe that has not scrolled onto the screen yet reads `1.00, 0.00, 1.00`** — parked at the right edge with a fully open gap. That is why the pipe after next looks that way in the snapshot.

Beyond the index names, `sandbox.features` offers two small reading functions. Their examples use the same snapshot as the table:

| Helper | What it gives you | Example |
| --- | --- | --- |
| `next_gap_center(observation)` | The vertical center of the next pipe's gap — the height the bird should aim for. | `(0.24 + 0.43) / 2`, so `0.335` |
| `player_y(observation)` | The bird's vertical position as a plain float — remember, larger is lower. | `0.44` |

## Actions

Your `act` method returns one integer each step, and there are only two to choose from. `sandbox.features` names them too:

| Action | Name in `sandbox.features` | Meaning |
| --- | --- | --- |
| `0` | `IDLE` | Do nothing. The bird keeps falling under gravity. |
| `1` | `FLAP` | Flap. The bird gets an upward push. |

Flapping every step sends the bird into the sky, and never flapping drops it to the ground, so the whole craft of a Flappy Bird agent is choosing _when_ to flap. If your agent misses a step's deadline, the environment plays `0` for that step and the bird just keeps falling.

## The smallest agent

Here is the entire decision logic of a working Flappy Bird agent. Drop it into the `act` method of the template's agent class:

```python
from sandbox.features import FLAP, IDLE, next_gap_center, player_y

def act(self, observation):
    if player_y(observation) > next_gap_center(observation):
        return FLAP
    return IDLE
```

Take it line by line. `next_gap_center(observation)` is the height the bird should be at — the middle of the next gap. `player_y(observation)` is where the bird actually is. Because y grows downward, `player_y > next_gap_center` means the bird is _below_ its target, so it flaps to rise; otherwise it does nothing and lets gravity bring it down. In the snapshot from the observation table, `0.44 > 0.335`, so this agent would flap.

The result is a bird that sawtooths up and down around the center of each gap, and that is genuinely enough to clear pipe after pipe. Its weakness is that it is purely reactive: it compares positions but ignores velocity, so it flaps late when falling fast and keeps drifting upward after it stops flapping. Every stronger agent is a refinement of this same comparison — same inputs, better judgement about when to press the button.

## Scoring and rewards

The rewards add up step by step: `+0.1` for every step the bird stays alive, `+1.0` for every pipe it passes, `-0.5` for flying off the top of the screen, and `-1.0` for the crash that ends the episode. A higher total therefore means the bird survived longer and cleared more pipes — the goal is simply to keep flying and pass as many pipes as possible.

Any single run can be lucky or unlucky, so evaluating over several seeded runs, as `python -m sandbox eval` does, gives a much steadier picture of whether a change actually helped.

## Time limits

Flappy Bird runs in real time at a fixed pace of one step every 50 milliseconds, which is the deadline for each `act` call, within an overall step limit of 1 second and an episode limit of 120 seconds of measured compute. If your agent does not return an action in time, the environment does nothing for that step and the bird keeps falling. See [Time limits](../agent-interface.md#time-limits) for how the step and episode limits are enforced and accounted.

## Ideas to try

A good way to improve is one idea at a time, each building on the last:

- **Add a margin.** Flapping the instant the bird dips below the exact center makes it jitter. Try flapping only once it has fallen a little _below_ the target, or aim slightly above the gap's bottom edge instead of its center.
- **Use the velocity.** The bird keeps moving between decisions, so react to where it is _going_, not where it is: estimate its height a few steps ahead (current position plus velocity) and compare _that_ to the target. This one change stops most late flaps and overshoots.
- **Look ahead to the pipe after next.** When the next pipe is almost reached, the gap that really matters is the following one. Blend your target from the next gap toward the one after as `NEXT_PIPE_X` shrinks, and the bird stops making panicked climbs between pipes.
- **Respect the edges.** Flying above the top of the screen costs reward and the ground ends the run, so clamp your target height away from both extremes no matter where a gap sits.
- **Measure, don't eyeball.** Watch a run to build intuition, but judge every change over several seeded runs and compare the averages — a single run proves nothing either way.
