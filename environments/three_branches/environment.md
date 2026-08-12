# Days at Three Branches

Days at Three Branches is a village simulation. Your program controls one NPC, and the platform starts a separate copy of it for every villager. Each copy sees only its own observation, so characters can coordinate only by moving, noticing one another, using props, and speaking.

Start with [Getting Started](../../docs/students/getting-started.md). Then edit `agent.py` and run `python -m sandbox watch` from the template folder.

## Your first agent

`act` receives a plain Python dictionary and returns a movement and expression dictionary. The starter stands still while retaining its current heading.

```python
def act(self, observation):
    return {
        "heading": observation["self"]["heading"],
        "speed": 0.0,
        "action": 0,
    }
```

Heading is measured in degrees counterclockwise from east. Speed is a fraction from `0.0` to `1.0`; the terrain sets the actual distance. Action `0` is no expression, `1` is use, and actions `2` through `10` are wave, nod, shake_head, point, laugh, shrug, startle, sleep, and sweep.

## What your character knows

Every observation has these keys:

| Key | Meaning |
| --- | --- |
| `self` | Your id, position, heading, movement on the last tick, and expression. |
| `seen` | Characters in front of you with a clear line of sight. |
| `nearby` | Characters close enough to hear. |
| `props` | Visible interactive props and their states. |
| `bell`, `tick`, `phase` | The village signal, time in the day, and named phase (`day` when disabled). |
| `village`, `roster`, `parameters` | The static map, character identities, and selected settings. |

Walls and water block movement. Walls block sight and hearing, while doorways do not. Props can be used only while you are still, close enough, and have a clear line to them. The nearest eligible prop is selected automatically when action `1` is returned.

## Running locally

```console
python -m sandbox watch  # watch your villagers with a scripted visitor
python -m sandbox test   # run the supplied checks
python -m sandbox eval   # compare repeatable days with the baseline
```

`naive` is the simple cast baseline. `scripted_visitor` controls the visitor in automated runs. Both production builtins use fresh entropy, so do not expect two live builtin sessions with the same seed to move identically. A fixed village plus a captured action stream still replays exactly on the same build.

For shared `reset`, optional learning, chat, and submission details, see the [agent interface](../../docs/students/agent-interface.md) and [submitting guide](../../docs/students/submitting.md).
