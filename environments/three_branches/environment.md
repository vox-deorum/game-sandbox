# Days at Three Branches

Days at Three Branches is a shared village day. A human visitor and a cast of independently running villagers act at the same time for 1,200 ticks.

This guide is the reference for the starter agent. Read it before changing `agent.py`.

## Your agent

Each character runs a separate instance of your `Agent` class. `reset(seed, observation)` runs once at the beginning of the day. `act(observation)` runs once per tick and returns one complete action.

The starter agent uses the raw observation dictionary. Its stand-still action is:

```python
{
    "heading": observation["self"]["heading"],
    "speed": 0.0,
    "action": 0,
}
```

## Observations

The observation is a dictionary. `self` describes your character, including its `id`, `position`, `heading`, `moved`, and `expression`. It also includes people and props that your character can perceive, a `bell` flag that is 1 while the beacon bell rings anywhere in the village, the current `tick`, the current `phase`, the static `village` layout, the roster, and resolved gameplay parameters. The map, roster, and parameters are identical throughout an episode, so you may cache them from `reset`. Treat them as read-only: the map and roster are shared objects, so mutating them corrupts what other characters observe.

Positions have `x` and `y` values in village meters. The current heading is in degrees counterclockwise from east.

## Actions

Return a dictionary with all three keys:

| Key | Value | Meaning |
| --- | --- | --- |
| `heading` | Number from 0 through 360 | The direction to face and move. 360 means east, the same as 0. |
| `speed` | Number from 0 through 1 | A fraction of the ground speed limit. Use 0 to stay still. |
| `action` | Whole number from 0 through 10 | An expression: 0 is none, 1 is use, and 2 through 10 are emotes. |

The action describes one complete tick. A character can turn, move, or choose an expression in the same action. An expression that uses a prop requires speed 0 and works only when the nearest point on a suitable prop's footprint is within 1.5 m along an unblocked line.

## First experiment

Change the starter's `action` value from `0` to `10`, which is the `sweep` emote. Run a local day, then make one small behavior change at a time so you can see what it does.

For the optional `learn` and `chat` methods, see the shared [agent interface reference](../../docs/students/agent-interface.md).
