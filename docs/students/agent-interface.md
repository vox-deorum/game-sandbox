# Agent Interface

Your agent is a Python class, a small package of decision-making code and the values it remembers. Depending on the assignment, it can control one or more players, each with a separate `Agent()` instance without shared memory. At each time step, the game runner will ask each instance to choose actions, until the game ends. Your [environment page](environments/index.md) explains what your game's actions and observations mean.

## Minimal agent

```python
class Agent:
    def reset(self, seed: int) -> None:
        self.last_observation = None

    def act(self, observation):
        self.last_observation = observation
        return 0
```

This example always chooses action `0`. It shows the shape of an agent class, but action `0` is not useful and is not legal in every environment. Replace the decision in `act` with your own strategy.

## Methods

| Method | Required? | Purpose |
| --- | --- | --- |
| `reset(seed)` | Yes | Prepare for a new game and set up random choices. |
| `act(observation)` | Yes | Return one legal action for the current observation. |
| `learn(observation, action, reward, terminated)` | No | Update an agent that learns after each step. |
| `chat(inbox)` | No | Receive and send messages when the environment enables messaging. |

The runner uses an optional method only when you define it. Leave optional methods out until you need them. Most first agents use only `reset` and `act`.

### `reset(seed)`

The runner calls `reset` once before the first action of each game. The environment receives the same seed. A **seed** is a number that makes random choices repeatable. If your agent uses randomness, set up its random-number generator with this seed so you can repeat a run.

### `act(observation)`

`act` receives the game information visible to your agent and returns one allowed whole-number action. The action number has a different meaning in each environment. For example, Flappy Bird uses `0` to do nothing and `1` to flap, while Hearts uses a number that represents a card.

You do not have to decode action numbers by hand. Each template includes a helper module that turns readable choices into the action number the game needs:

- **Hearts** and **Spades** use `sandbox.cards`. `legal_cards(observation)` lists the cards you may play, and `play(card)` turns your chosen card into an action. Spades also provides `legal_bids(observation)` and `bid(number)` for bidding.
- **Flappy Bird** uses `sandbox.features`. It names the actions `FLAP` and `IDLE` and provides functions such as `player_y(observation)` for reading the game state.

Your [environment page](environments/index.md) documents every action and observation field and shows how to use these helpers.

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

## State and official runs

The runner creates your agent by calling `Agent()` with no arguments. Put setup that lasts for the life of that instance in `__init__`. Clear game-specific information in `reset`.

An instance can remember information between games in one session, including values updated by `learn`. It does not persist to a later official session, a later submission, or a later season. If your code controls multiple players, each player has its own instance and its own remembered values. Use `chat` when an environment supports messages and your strategy needs to communicate.

Official games run in a restricted computer environment:

- The template supplies a fixed set of Python packages. You cannot install extra packages during a game.
- Your project files and the rest of the computer are read-only. The one writable place is a small temporary directory, the one Python's `tempfile` module uses by default.
- General internet access is unavailable. An enabled Game Sandbox LLM API is the only network exception.
- CPU time and memory are limited.

Develop and test on your own computer, then put everything your agent needs in the repository you submit. Extra Python modules and data files, such as a trained model, are fine within the size limit in [Submitting](submitting.md#repository-rules).

## Time limits

Your environment page lists default decision and total-computation limits. A season can change those limits, and the environment's page on the website shows the values in effect for the current season.

- A **decision limit** applies to one turn. If `act` finishes late, the runner ignores its result and uses a legal default action for that turn. The game continues, but the time `act` spent still counts toward the game limit.
- A **game limit** applies to your agent's total computation during one game. Time in `act`, `learn`, and `chat` counts toward it.

In an official scored game, a crash, an illegal action, or using all of the game limit causes the assigned seat to forfeit. A late `act` call by itself does not forfeit the seat because the runner uses the legal default action instead. If your submission controls several players in one seat, a failure by any of them forfeits that seat.

## Optional capabilities

The next two features are optional. Return here if you want your agent to send messages or call a language model.

### `chat(inbox)`

An agent can implement `chat` when its environment supports messaging. On your turn, the runner calls `chat` immediately after `act` and before applying the action. Your agent therefore knows what it chose but not what happened afterward.

`inbox` is a list of messages sent to your player since its previous turn. Messages name players with strings such as `"player_1"`, not the plain numbers used in observations. A received message looks like this, where `tick` is the game step on which it was sent:

```python
{"from": "player_0", "to": "player_2", "text": "hi partner", "tick": 3}
```

To send messages, return a list such as `[{"to": "player_0", "text": "hi partner"}]`, or return nothing to stay silent. Use `None` as the recipient to send a message to every other player.

At each acting opportunity, your agent can send one message to each recipient and one broadcast. The environment sets the maximum message length, and a season can lower it. A message that breaks any of these limits is dropped without an error, so a message that never arrived probably broke a limit. Messages are recorded on the completed step and become readable only at a later acting opportunity. Every message appears in replays, so do not treat messages as secret. See the [communication specification](../specs/communication.md) for the complete rules.

### LLM calls

When the environment and season enable the optional LLM API, `act`, `chat`, and `learn` may use the standard OpenAI Python client. Every model-assisted path through `act` must return a legal fallback action if the budget runs out, the service has an error, or the response has the wrong format.

Make the call in the method that needs it and wait for the complete response. In official sessions, the platform measures how long your agent waits for the Game Sandbox LLM service and does not count that wait toward the decision or game limit. Keep imports, construction, and `reset` lightweight. Follow [Using the LLM API](llm.md) for setup, budgets, errors, and prompt visibility.

## Manifest

`manifest.json` is a file in the root of your repository that tells the runner where to find your class. `entry_point` names the Python module (`agent` means `agent.py`), `class_name` names the class to create, and `template_version` records the version of the template's shared packages. Keep the template's manifest unchanged unless you rename the module or class. [Submitting](submitting.md#manifest-problems) shows the file and a checklist for fixing validation failures.
