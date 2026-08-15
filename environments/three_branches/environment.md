# Days at Three Branches

Days at Three Branches is a village simulation. Your program controls one NPC, and the platform starts a separate copy for every villager. Each copy has its own memory and sees only its own observation. Villagers can coordinate by moving, noticing one another, using props, and speaking.

Start with the [template](https://github.com/Minor-Solutions/game-sandbox/tree/main/environments/three_branches/template). Edit `agent.py`, then run `python -m sandbox watch` from that folder to watch a day beside the scripted visitor.

## Make an action

Import the small helper namespaces rather than assembling raw action dictionaries:

```python
from sandbox.village import action, me, people


def act(self, observation):
    heading = me.heading(observation)
    if people.seen(observation):
        return action.walk(heading, 0.5, "wave")
    return action.stand(heading, "none")
```

`action.walk(heading, speed, expression)` wraps headings into `[0.0, 360.0)` and clamps speed to `0.0` through `1.0`. `action.stand(heading, expression)` is the still version. Expressions are `"none"`, `"use"`, or one of `action.EMOTES`.

## Improve the starter

The starter walks toward its home's doorway while it is on interior ground. Outside, it heads toward the well-plaza pump. It waves while walking when it sees somebody and sits only when `props.usable(observation)` previews a bench.

That is intentionally weak. It does not remember a route or avoid walls. A useful first improvement is to choose a destination from the static village, then compare nearby points with `layout.walkable` and `layout.can_step` before walking.

## A village day

One submission controls the cast seat. The platform makes a separate `Agent` instance for every NPC: `player_1` through `player_5` in `cast_5`, or through `player_10` in `cast_10`. The visitor is `player_0` and is human-controlled in live play or controlled by the scripted visitor in automated runs. `reset(seed, observation)` runs once before a day, so build any route graph there instead of in every `act` call.

A day has 1200 simultaneous ticks. Your action is chosen from the current observation, then every character moves, then prop use resolves in character order. Every healthy completed character scores 100. The automated board uses compute time as its tiebreaker, while people judge whether the village feels alive.

Ground, walls, doorways, buildings, props, and scenery are standing knowledge in `observation["village"]`. Water and walls stop movement. Walls block sight and hearing, but doorways do not. Interactive props have collision shapes, so `layout.walkable` and `layout.can_step` are safer than assuming a prop's cell is empty.

## Helpers

Import only the namespaces you use:

```python
from sandbox.village import action, day, geometry, layout, me, people, props
```

| Namespace | Main helpers |
| --- | --- |
| `action` | `walk`, `stand`, and `EMOTES` |
| `me` | `player_id`, position, heading, movement, expression, home, and `rng` |
| `people` | seen people, nearby people, roster, and player-id predicates |
| `props` | all placements, seen state, reach, use preview, and `TYPES` |
| `layout` | cells, ground, safe standing and steps, sight, buildings, and doorways |
| `geometry` | distance, heading, wrapping, vision cone, and ranges |
| `day` | tick, phase, bell, and resolved parameters |

Helpers that read village state take `observation` first. `action` and `geometry` are pure builders or calculations and do not take an observation. `me.rng(observation, session_seed)` gives each player a stable independent `random.Random` stream for that session seed.

### Using props

Return `action.stand(heading, "use")` to use a prop. Use requires speed `0`, a clear line, and being within reach of the prop's collision shape. You never name the prop: `props.usable(observation)` previews the nearest prop the engine would select. Check that preview before using when your behavior needs a particular prop.

## Season settings and limits

The first season uses five villagers with day and night off. Later seasons can use ten villagers, day phases, and the optional LLM API. `day.parameters(observation)` shows the resolved settings, and `day.phase(observation)` is `"day"` when day and night is off.

Each `act` call has a 0.25 second limit. A whole day has a 120 second limit. The cast decisions run sequentially, so quick code matters more in `cast_10`. Build durable data in `reset` and keep per-tick work small.

## Run locally

```console
python -m sandbox watch  # watch your villagers and the scripted visitor
python -m sandbox test   # run supplied checks
python -m sandbox eval   # run repeatable automated days
```

See the shared [agent interface](../../docs/students/agent-interface.md) for `reset`, optional learning, chat, and submission details.

## Chat with other agents

Chat is optional, and it uses the same canonical player IDs that appear in `me.player_id(observation)`, `people.seen(observation)`, and the roster. For example, a villager might receive a message from the visitor as `"player_0"` and reply directly to `"player_0"`. There is no chat helper namespace: return ordinary dictionaries from an optional `chat` method.

```python
def chat(self, inbox):
    for message in inbox:
        if message["from"] == "player_0":
            return [{"to": "player_0", "text": "Hello from the village."}]
    return []
```

Each item in `inbox` is a raw dictionary. It includes the sender, recipient, text, and the tick when it was sent:

```python
{"from": "player_0", "to": "player_2", "text": "Meet at the pump.", "tick": 3}
```

Use `None` for `"to"` to broadcast to every player who can hear the sender. Messages are delivered on a later acting opportunity, and every message is visible in the replay.

## Raw reference

`act` receives a plain dictionary. You can use it directly, but the helpers above keep common work readable.

| Field | Contents |
| --- | --- |
| `self` | id, position, heading, movement from the previous tick, expression |
| `seen` | visible characters: id, position, heading, movement, expression |
| `nearby` | characters within hearing range and line, with id and position only |
| `props` | visible interactive prop ids and states |
| `bell`, `tick`, `phase` | global bell state, current tick, and day phase |
| `village` | static size, ground rows, buildings, prop placements, scenery, and spawn |
| `roster`, `parameters` | character homes and resolved season settings |

The raw action space is:

```text
Dict{
  "heading": [0.0, 360.0),
  "speed":   Box(0.0, 1.0, shape=(), float32),
  "action":  Discrete(11)
}
```

Action `0` is none and `1` is use. The remaining ids are: `2` wave, `3` nod, `4` shake_head, `5` point, `6` laugh, `7` shrug, `8` startle, `9` sleep, and `10` sweep.
