"""Your agent.

Implement the two required methods. The two optional hooks (``learn`` and ``chat``) are shown
commented out: the harness detects them *by presence*, so leaving them commented means "this
agent does not learn / does not chat" and the harness will not spend time calling them.
Uncomment and implement only the ones you want.

This file imports nothing from the sandbox: you develop against vanilla PettingZoo, and the
server runs this exact class through the same interface. Episode state belongs in ``reset``;
the constructor takes no arguments.
"""

from __future__ import annotations

from typing import Any


class Agent:
    """A Flappy Bird agent over the 12-feature numerical observation.

    The observation is a length-12 NumPy array (see the environment docs); the action is
    ``0`` (do nothing) or ``1`` (flap).
    """

    def reset(self, seed: int) -> None:
        """Prepare for a new episode. The same seed the environment got is passed here, so a
        stochastic agent can be made reproducible. Called once before the first ``act``."""
        raise NotImplementedError("implement Agent.reset")

    def act(self, observation: Any) -> int:
        """Return an action (0 = do nothing, 1 = flap) for the given observation."""
        raise NotImplementedError("implement Agent.act")

    # Optional: a reinforcement-learning hook called after every step with that step's
    # transition. Its time counts against your per-step and per-episode limits.
    #
    # def learn(self, observation: Any, action: int, reward: float, terminated: bool) -> None:
    #     ...

    # Optional: a messaging hook (only used in environments with messaging enabled). Called
    # on your turn with the messages addressed to your slot; return messages to send, or
    # nothing to stay silent.
    #
    # def chat(self, inbox: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    #     ...
