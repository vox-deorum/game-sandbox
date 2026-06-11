# Agent Interface

Your agent is a Python class with four methods — two required, two optional. You develop against vanilla PettingZoo; the server runs this exact class through the same interface, so there is nothing sandbox-specific to import. The authoritative design is the [submission spec](../specs/submission.md).

## The four methods

```python
class Agent:
    def reset(self, seed: int) -> None:
        ...                      # required

    def act(self, observation):
        ...                      # required; returns an action in the action space

    # optional — implement only if you want them:
    # def learn(self, observation, action, reward, terminated): ...
    # def chat(self, inbox): ...
```

- **`reset(seed)`** prepares the agent for a new episode. It is called once before the first `act`. The seed is the _same_ seed the environment receives, so a stochastic agent can be made reproducible by seeding its own RNG here.
- **`act(observation)`** returns an action in the environment's action space. For Flappy Bird the observation is a length-12 normalized NumPy array and the action is `0` (do nothing) or `1` (flap).
- **`learn(observation, action, reward, terminated)`** is _optional_. When present, the harness calls it after each step with that step's transition, so a reinforcement-learning agent can keep updating during play.
- **`chat(inbox)`** is _optional_ and only used in environments with messaging enabled. It is called on your turn with the messages addressed to your slot, and returns messages to send or nothing to stay silent.

The optional hooks are detected **by presence**: if you do not define `learn` or `chat`, the harness never calls them and you pay no time for them. Do not add empty stubs — that just makes the harness call a method that does nothing.

## What the harness guarantees

- It calls `reset(seed)` once at the start of an episode, then alternates `act` (and `learn`, if present) per step until the episode ends.
- The same seed produces the same episode, so two runs of a deterministic agent are identical.
- The constructor takes no arguments. Establish all per-episode state in `reset`, not `__init__`.

## Timeouts you live under

Two limits, both defaulted by the environment and overridable per run:

- A **per-step limit**: if a single `act` (plus `learn`, if present) exceeds it, the harness discards your action, applies the environment's default action for that step, and records the overage. You pay for slowness in the outcome _and_ in your timing column.
- A **per-episode budget**: the cumulative measured compute across the episode. Exhaust it and the episode ends early with reason `episode_limit`.

Time spent in `learn` and `chat` counts against both limits, so an agent that learns or talks heavily pays for it in the efficiency column rather than stalling the run. The recorded `decision_ms` is pure `act` time; `learn_ms`, when present, is reported separately.

## The manifest

A `manifest.json` at your repo root tells the harness how to load your agent. Three fields:

```json
{
  "entry_point": "agent",
  "class_name": "Agent",
  "template_version": 1
}
```

- `entry_point` — the module (importable from the repo root) that holds your agent class.
- `class_name` — the class inside it.
- `template_version` — the integer version of the template dependency set your repo targets.

Keep the template's manifest as is unless you rename your module or class.
