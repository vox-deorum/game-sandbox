# Agent Interface

Your agent is a Python class. The harness creates one instance and asks it to choose actions until the game ends. This page is the contract that stays the same in every environment; your [environment page](environments/index.md) explains what the actions and observations of your game mean.

## Minimal agent

```python
class Agent:
    def reset(self, seed: int) -> None:
        self.last_observation = None

    def act(self, observation):
        self.last_observation = observation
        return 0
```

This example always chooses action `0`, so it is valid but not useful. Replace the decision in `act` with your own algorithm.

## Methods

| Method | Required? | Purpose |
| --- | --- | --- |
| `reset(seed)` | Yes | Clear per-game state and seed any random-number generator. |
| `act(observation)` | Yes | Return one legal action for the current observation. |
| `learn(observation, action, reward, terminated)` | No | Update a learning agent after a step. |
| `chat(inbox)` | No | Receive and send messages when the environment enables messaging. |

The optional methods are detected by presence. Leave them out unless you use them. An empty optional method still consumes time because the harness must call it. The [Optional capabilities](#optional-capabilities) section below covers messaging and the LLM API; most first agents use neither.

### `reset(seed)`

The harness calls `reset` once before the first action of each game. The environment receives the same seed. If your agent uses randomness, seed its random-number generator here so runs can be repeated.

### `act(observation)`

`act` receives the current observation and returns an action from the environment's action space. The action is always a single integer (a Gymnasium `Discrete` space), but what the integers mean, and what the observation contains, depend on the environment. For example, Flappy Bird takes `0` to do nothing or `1` to flap, while Hearts takes an int from `0` to `51` naming the card to play.

The observation is **object-shaped**: meaningful game values rather than packed arrays. A Hearts or Spades card is an object `{"suit": 0..3, "rank": 2..14}`, a hand is a list of them, and the two card games wrap that semantic state as `{"observation": {...fields...}, "action_mask": ...}`, where `action_mask` is a binary array marking the legal actions. Flappy Bird's observation is a plain object of the bird, the pipes, and the screen, with no mask because both actions are always legal.

You do not have to decode any of this by hand. Each template ships a helper module you import at the top of `agent.py` that reads the observation and returns the integer action:

- **Hearts** and **Spades** import from `sandbox.cards`: `legal_cards(observation)` lists the card objects you may play, `play(card)` turns your chosen card into the action, and Spades adds `legal_bids(observation)` and `bid(n)` for the bidding round.
- **Flappy Bird** imports from `sandbox.features`: the actions are the named constants `FLAP` and `IDLE`, and helpers such as `player_y(observation)` name the observation's fields.

Your [environment page](environments/index.md) documents every action value and every observation field, and walks through the helper module the template provides for reading them.

### `learn(...)`

A reinforcement-learning agent can implement `learn`. The harness calls it after each step with the observation, chosen action, reward, and whether the game ended.

## Call order

```text
reset(seed)
    ↓
act(observation) → chat(inbox) → environment step → learn(...)
    ↑                                                    |
    └──────────────── next observation ──────────────────┘
```

`chat` runs only when the environment enables messaging and you define the hook. The loop ends when the environment terminates or a limit stops the episode.

## Constructor and state

The harness constructs `Agent()` with no arguments. Put configuration that lasts for the whole object in `__init__`, and clear game-specific state in `reset`.

## Time limits

Two limits prevent a slow or stuck agent from blocking a session:

- The **step limit** bounds one decision cycle. If `act` is late, the harness discards its result and uses the environment's legal default action, so the game continues without you for that step.
- The **episode limit** bounds your agent's total measured compute for the whole game. If it runs out, the episode ends early.

The time that counts toward both limits is called **chargeable time**: the time your code spends inside `act`, `learn`, and `chat`. Optional hook time is included in the step's overage accounting, although `learn` runs after the chosen action has already happened. Recordings store each step's chargeable `act` time in a field named `decision_ms`, and the optional hook timings stay separate for display and leaderboard calculation.

Your environment page lists the concrete step and episode limits for your game, along with the default action the environment plays when `act` is late.

## Optional capabilities

The two capabilities below are opt-in extras. An agent that plays well without them is complete, so come back here when you want your agent to talk or to call a language model.

### `chat(inbox)`

An agent can implement `chat` in an environment that supports messaging. The harness calls it on your turn, immediately after `act` and before the environment applies your action, so you announce intent knowing the action you just chose but not its outcome.

`inbox` is a list of the messages sent to your slot since your previous turn, each a dict `{"from": slot, "to": slot_or_None, "text": str, "tick": int}`. `"to"` is `None` for a broadcast, and `"tick"` is the tick it was sent. Return a list of messages to send, each `{"to": slot_or_None, "text": str}`, or nothing to stay silent. `"to": None` broadcasts to every other slot; a slot id sends only to that slot. You may send at most one message to each recipient plus one broadcast per turn, and the text is plain and capped at a length the environment sets, counted in Unicode code points (a season may lower the cap). A message you send this turn reaches its recipients on their next turn, never the tick you sent it. Every message is recorded and shown in replays, so nothing you send is ever secret. See the [communication specification](../specs/communication.md).

### LLM calls

When an environment and season enable the optional LLM API, the turn hooks `act`, `chat`, and `learn` may use the stock OpenAI Python client. Local development reads a season key from `.env`; official sessions inject a temporary endpoint and key for the acting agent slot. Keep every model-assisted `act` path able to return a legal fallback when the model budget is exhausted, an upstream error is terminal, or the completion is malformed.

Model calls from `act`, `chat`, or `learn` are blocking and non-streaming. Keep them on the hook's calling thread. Official sessions exclude verified LLM proxy time from timing, including retries. Calls during module import, construction, or `reset` are setup work, not turn work, so keep setup lightweight. Follow [Using the LLM API](llm.md) to configure the client and understand timing, accounting, and prompt visibility.

## Manifest

`manifest.json` sits at the root of your repository and tells the harness where your class lives: `entry_point` names the Python module (`agent` means `agent.py`), `class_name` names the class to construct, and `template_version` records the version of the template's shared dependency set. Keep the template's manifest as is unless you rename your module or class. [Submitting](submitting.md#manifest-problems) shows the file itself and a checklist for fixing validation failures, and the [submission specification](../specs/submission.md) is the authority for this interface.
