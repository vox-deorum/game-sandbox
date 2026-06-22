# Agent Interface

Your agent is a Python class. The harness creates one instance and asks it to choose actions until the game ends.

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

The optional methods are detected by presence. Leave them out unless you use them. An empty optional method still consumes time because the harness must call it.

### `reset(seed)`

The harness calls `reset` once before the first action of each game. The environment receives the same seed. If your agent uses randomness, seed its random-number generator here so runs can be repeated.

### `act(observation)`

`act` receives the current observation and returns an action from the environment's action space. For Flappy Bird:

- The observation is a NumPy array with 12 normalized values.
- Action `0` does nothing.
- Action `1` flaps.

### `learn(...)`

A reinforcement-learning agent can implement `learn`. The harness calls it after each step with the observation, chosen action, reward, and whether the game ended.

### `chat(inbox)`

An agent can implement `chat` in an environment that supports messaging. It receives messages addressed to the agent's slot and may return messages to send. See the [communication specification](../specs/communication.md).

## Call order

```text
reset(seed)
    ↓
act(observation) → environment step → learn(...) → chat(...)
    ↑                                      |
    └──────────── next observation ────────┘
```

The loop ends when the environment terminates or a limit stops the episode.

## Constructor and state

The harness constructs `Agent()` with no arguments. Put configuration that lasts for the whole object in `__init__`, and clear game-specific state in `reset`.

## Time limits

Two limits prevent a slow or stuck agent from blocking a session:

- The **step limit** bounds one decision cycle. If `act` is late, the harness discards its result and uses the environment's legal default action. Optional hook time is included in the step's overage accounting, although `learn` runs after the chosen action has already happened.
- The **episode limit** bounds the agent's total measured compute for the game. If it is exhausted, the episode ends early.

Time spent in `act`, `learn`, `chat`, and LLM calls counts toward these limits. Recorded `decision_ms` measures `act` itself, while optional hook timings remain separate so the interface can show decision time and the leaderboard can still include the full compute cost.

## Manifest

`manifest.json` tells the harness where your class lives:

```json
{
  "entry_point": "agent",
  "class_name": "Agent",
  "template_version": 1
}
```

| Field | Meaning |
| --- | --- |
| `entry_point` | Python module containing the class. `agent` means `agent.py`. |
| `class_name` | Class to construct from that module. |
| `template_version` | Version of the template's shared dependency set. |

Keep the template's manifest as is unless you rename your module or class.

The [submission specification](../specs/submission.md) is the authority for this interface.
