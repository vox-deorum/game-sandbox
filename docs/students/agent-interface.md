# Agent Interface

Your agent is a Python class, a small package of decision-making code and the values it remembers. Depending on the assignment, it can control one or more players, each created as its own instance with no memory shared between them. At each time step until the game ends, the game runner asks each instance to choose an action. Your [environment page](environments/index.md) explains what your game's actions and observations mean.

## Minimal agent

```python
class Agent:
    def reset(self, seed: int) -> None:
        self.last_observation = None

    def act(self, observation):
        self.last_observation = observation
        return 0
```

> _What are `: int` and `-> None`?_ These are optional Python type hints. Python ignores them at runtime, so you can leave them as they are.

The example above always chooses action `0`. It shows the shape of an agent class, but action `0` is not useful and is not legal in every environment. Replace the decision in `act` with your own strategy.

## Methods

| Method | Required? | Purpose |
| --- | --- | --- |
| `reset(seed)` | Yes | Prepare for a new game and set up random choices. |
| `act(observation)` | Yes | Return one legal action for the current observation. |
| `learn(observation, action, reward, terminated)` | No | Update an agent that learns after each step. |
| [`chat(inbox)`](#chatinbox) | No | Receive and send messages when the environment enables messaging. |

The runner calls an optional method only if you define it, so leave it out until you need it. Most first agents use only `reset` and `act`.

### `reset(seed)`

A **seed** is a number that makes random choices repeatable. The runner calls `reset` once before the first action of each game, passing the same seed to your agent and to the environment. If your agent uses randomness, set up its random-number generator with this seed so you can repeat a run.

### `act(observation)`

`act` receives the game information visible to your agent and returns one allowed whole-number action. The action number has a different meaning in each environment. For example, Flappy Bird uses `0` to do nothing and `1` to flap, while Hearts uses a number that represents a card.

You do not have to decode action numbers by hand. Each template includes a helper module that turns readable choices into the action number the game needs:

- **Hearts** and **Spades** use `sandbox.cards`. `legal_cards(observation)` lists the cards you may play, and `play(card)` turns your chosen card into an action. Spades also provides `legal_bids(observation)` and `bid(number)` for bidding.
- **Flappy Bird** uses `sandbox.features`. It names the actions `FLAP` and `IDLE` and provides functions such as `player_y(observation)` for reading the game state.

### `learn(...)`

An agent that learns from rewards, often called a **reinforcement-learning agent**, can implement `learn`. The runner calls it after each step with the observation, chosen action, reward, and whether the game ended.

## Call order

```text
reset(seed)
    ↓
act(observation) → chat(inbox) → game step → learn(...)
    ↑                                          |
    └────────────── next observation ─────────┘
```

`chat` runs only when the environment enables messaging and your class defines the method. The loop ends when the game ends or a limit stops it.

## Agent instances and state

The runner creates your agent by calling `Agent()` with no arguments. Put setup that should last the whole life of the instance in `__init__`, and clear anything specific to a single game in `reset`.

> _What's `__init__`?_ Python runs this method once, automatically, when an object of your class is created, before `reset` is ever called.

An instance can remember information between games in one session, including values updated by `learn`. Nothing it remembers carries over to a later official session, a later submission, or a later season. If your code controls multiple players, each player has its own instance and its own remembered values.

## Official run restrictions

Official games run under these restrictions:

- The template supplies a fixed set of Python packages. You cannot install extra packages during a game.
- Your project files and the rest of the computer are read-only. The only writable place is a small temporary directory, the one Python's `tempfile` module uses by default.
- General internet access is unavailable, and the only exception is the Game Sandbox LLM API when it is enabled.
- CPU time and memory are limited.

Develop and test on your own computer, then put everything your agent needs in the repository you submit. Extra Python modules and data files, such as a trained model, are fine as long as they fit the size limit in [Submitting](submitting.md#repository-rules).

## Time limits

Your environment guide lists the default decision limit and game limit. The environment overview shows changes for the play-open season. My Submissions shows changes for the season accepting your submission.

- A **decision limit** applies to one turn. If `act` finishes late, the runner ignores its result and uses a legal default action for that turn. The game continues, but the time `act` spent still counts toward the game limit.
- A **game limit** applies to your agent's total computation during one game (one full episode). Time in `act`, `learn`, and `chat` counts toward it.

In an official scored game, a crash, an illegal action, or using all of the game limit causes the assigned seat to forfeit. A late `act` call by itself does not forfeit the seat because the runner uses the legal default action instead. If your submission controls several players in one seat, a failure by any of them forfeits that seat. See the [leaderboard specification](../specs/leaderboard.md) for the complete forfeit rules.

## Optional capabilities

### `chat(inbox)`

An agent can implement `chat` when its environment supports messaging. On your turn, the runner calls `chat` immediately after `act` and before applying the action, so your agent knows what it chose but not what happened next.

`inbox` is a list of messages sent to your player since its previous turn. Messages name players with strings such as `"player_1"`, not the plain numbers used in observations. A received message looks like this, where `tick` is the game step on which it was sent:

```python
{"from": "player_0", "to": "player_2", "text": "hi partner", "tick": 3}
```

To send messages, return a list such as `[{"to": "player_0", "text": "hi partner"}]`, or return nothing to stay silent. Use `None` as the recipient to send a message to every other player.

Messaging follows a few rules at each acting opportunity:

- You can send one message to each recipient and one broadcast.
- The environment sets the maximum message length, and a season can lower it.
- The environment overview shows messaging changes for the play-open season. My Submissions shows them for the season accepting your submission.
- A message that breaks a limit is dropped without an error, so a message that never arrived probably broke one.
- Messages are recorded on the completed step and become readable only at a later acting opportunity.
- Every message appears in replays, so nothing you send is secret.

See the [communication specification](../specs/communication.md) for the complete rules.

### LLM calls

When the environment and season enable the optional LLM API, `act`, `chat`, and `learn` may use the standard OpenAI Python client. The environment overview shows LLM API availability for the play-open season. My Submissions shows it for the season accepting your submission. Every model-assisted path through `act` must return a legal fallback action if the budget runs out, the service has an error, the response has the wrong format, or a background reply is not ready.

A method may make a normal request and wait for the complete response. An agent that can continue without the immediate reply may instead use the template's `BackgroundLLM` helper to start one plain-text request and collect it from a later hook. Do not create threads yourself. In official sessions, verified time inside the Game Sandbox LLM service does not count toward the decision or game limit, but your local computation still does, so keep imports, construction, and `reset` lightweight. Follow [Using the LLM API](llm.md) for synchronous and cross-tick examples, setup, budgets, errors, and prompt visibility.

## Manifest

`manifest.json` sits in the root of your repository and tells the runner where to find your class. `entry_point` names the Python module (`agent` means `agent.py`), `class_name` names the class to create, and `template_version` records the version of the template's shared packages. Keep the template's manifest unchanged unless you rename the module or class. [Submitting](submitting.md#manifest-problems) shows the file and a checklist for fixing validation failures.
