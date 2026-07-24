# Agent Interface

Your agent is a Python class. The **harness**, the code that runs the game, creates one copy of this class and asks it to choose actions until the game ends. This page explains the interface shared by every environment. Your [environment page](environments/index.md) explains what your game's actions and observations mean.

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
| `reset(seed)` | Yes | Clear information from the previous game and initialize any random-number generator. |
| `act(observation)` | Yes | Return one legal action for the current observation. |
| `learn(observation, action, reward, terminated)` | No | Update an agent that learns after each step. |
| `chat(inbox)` | No | Receive and send messages when the environment enables messaging. |

The harness checks whether the optional methods exist. Leave them out unless you need them because even an empty method takes time to call. [Optional capabilities](#optional-capabilities) explains messaging and the LLM API. Most first agents use neither.

### `reset(seed)`

The harness calls `reset` once before the first action of each game. The environment receives the same seed. A **seed** is a number used to produce repeatable random choices. If your agent uses randomness, initialize its random-number generator with this seed so you can repeat a run.

### `act(observation)`

`act` receives the current observation and returns one allowed action. An observation is the game information visible to your agent. An action is always one whole number from a fixed set, called a Gymnasium `Discrete` space. The meaning of each number depends on the environment. For example, Flappy Bird uses `0` to do nothing and `1` to flap, while Hearts uses an integer from `0` to `51` to name a card.

Observations use named objects instead of packing all game information into an array. In Hearts and Spades, for example, a card is an object such as `{"suit": 0..3, "rank": 2..14}`, and a hand is a list of these objects. The card games wrap this readable state in `{"observation": {...fields...}, "action_mask": ...}`. The `action_mask` is an array in which `1` marks an action as legal and `0` marks it as illegal. Flappy Bird uses a plain object describing the bird, pipes, and screen. It needs no mask because both actions are always legal.

You do not have to decode any of this by hand. Each template ships a helper module you import at the top of `agent.py` that reads the observation and returns the integer action:

- **Hearts** and **Spades** use `sandbox.cards`. `legal_cards(observation)` lists the cards you may play, and `play(card)` turns your chosen card into an action. Spades also provides `legal_bids(observation)` and `bid(n)` for bidding.
- **Flappy Bird** uses `sandbox.features`. It names the actions `FLAP` and `IDLE` and provides functions such as `player_y(observation)` for reading the observation.

Your [environment page](environments/index.md) documents every action and observation field and shows how to use the template's helper module.

### `learn(...)`

An agent that learns through rewards, known as a **reinforcement-learning agent**, can implement `learn`. The harness calls it after each step with the observation, chosen action, reward, and a value that says whether the game ended.

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

The harness creates your agent by calling `Agent()` with no arguments. Put configuration that lasts for the life of this object in `__init__`. Clear information from the previous game in `reset`.

## Time limits

Two limits prevent a slow or stuck agent from blocking a session:

- The **step limit** applies to one decision cycle. If `act` finishes late, the harness ignores its result and uses the environment's legal default action. The game continues without your decision for that step.
- The **episode limit** applies to your agent's total measured computation for one game. The game ends early if this time runs out.

The time counted toward both limits is called **chargeable time**. It includes time your code spends in `act`, `learn`, and `chat`. Time in optional methods counts when calculating how far a step ran over its limit, although `learn` runs after the chosen action. Recordings store each step's chargeable `act` time in `decision_ms`. Optional method times remain separate for display and leaderboard calculations.

Your environment page lists the concrete step and episode limits for your game, along with the default action the environment plays when `act` is late.

## Optional capabilities

The next two features are optional. An agent can be complete without them. Return to this section if you want your agent to send messages or call a language model.

### `chat(inbox)`

An agent can implement `chat` when its environment supports messaging. On your turn, the harness calls `chat` immediately after `act` and before applying the action. Your agent therefore knows what it chose but not what happened afterward.

`inbox` is a list of messages sent to your agent slot since its previous turn. Each message is a dictionary shaped like `{"from": slot, "to": slot_or_None, "text": str, "tick": int}`. `"to"` is `None` for a broadcast, and `"tick"` identifies when the message was sent.

Return a list of messages shaped like `{"to": slot_or_None, "text": str}`, or return nothing to stay silent. Setting `"to": None` sends a broadcast to every other slot. Using a slot ID sends only to that slot.

On each turn, your agent may send at most one message to each recipient and one broadcast. Messages are plain text, and the environment sets their maximum length in Unicode code points. A season may lower that limit. A message sent on this turn arrives on each recipient's next turn, never on the tick when it was sent. Every message is recorded and shown in replays, so no message is secret. See the [communication specification](../specs/communication.md) for the complete rules.

### LLM calls

When the environment and season enable the optional LLM API, `act`, `chat`, and `learn` may use the standard OpenAI Python client. On your computer, the client reads a season key from `.env`. Official sessions provide a temporary endpoint and key for the acting agent slot. Every model-assisted path through `act` must be able to return a legal fallback action if the budget runs out, the model service cannot recover from an error, or the response has the wrong format.

Model calls from `act`, `chat`, or `learn` wait for a complete response and do not stream partial text. Make them directly in the method being called. Official sessions exclude verified time spent waiting for the LLM proxy, including retries, from the agent's time limits. Calls made while importing the module, creating the agent, or running `reset` count as setup rather than turn work, but setup should still be lightweight. Follow [Using the LLM API](llm.md) to configure the client and understand timing, budgets, and who can see prompts.

## Manifest

`manifest.json` is a file in the root of your repository that tells the harness where to find your class. `entry_point` names the Python module (`agent` means `agent.py`), `class_name` names the class to create, and `template_version` records the version of the template's shared packages. Keep the template's manifest unchanged unless you rename the module or class. [Submitting](submitting.md#manifest-problems) shows the file and a checklist for fixing validation failures. The [submission specification](../specs/submission.md) contains the complete rules for this interface.
