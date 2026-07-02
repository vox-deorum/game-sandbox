"""Your agent.

Implement the two required methods. The two optional hooks (``learn`` and ``chat``) are shown
commented out: the harness detects them *by presence*, so leaving them commented means "this
agent does not learn / does not chat" and the harness will not spend time calling them.
Uncomment and implement only the ones you want.

The only thing you may import from the sandbox is the ``sandbox.features`` helper module, and
only at the top of this file (a commented import is ready below). It names the 12 observation
indices and the two actions so ``act`` reads ``observation[NEXT_PIPE_GAP_TOP]`` instead of a
bare ``observation[4]``. Everything else you develop against vanilla PettingZoo, and the server
runs this exact class through the same interface. Episode state belongs in ``reset``; the
constructor takes no arguments.
"""

from __future__ import annotations

from typing import Any

# Uncomment to use the provided feature helpers, for example:
#   from sandbox.features import FLAP, IDLE, next_gap_center, player_y
# then in act: return FLAP if player_y(observation) > next_gap_center(observation) else IDLE.


class Agent:
    """A Flappy Bird agent over the 12-feature numerical observation.

    The observation is a length-12 NumPy array of normalized numbers describing the bird and the
    three nearest pipes; the action is ``0`` (do nothing) or ``1`` (flap). The most useful values
    for a simple policy are the next pipe's gap (indices 4 and 5) and the bird's own height
    (index 9). The ``sandbox.features`` helpers name every index, and ``environment.md`` (shipped
    alongside this file) lists them all with their scales and everything else specific to the game.
    """

    def reset(self, seed: int) -> None:
        """Prepare for a new episode. The same seed the environment got is passed here, so a
        stochastic agent can be made reproducible. Called once before the first ``act``."""
        raise NotImplementedError("implement Agent.reset")

    def act(self, observation: Any) -> int:
        """Return an action (0 = do nothing, 1 = flap) for the given observation."""
        raise NotImplementedError("implement Agent.act")

    # Optional: a reinforcement-learning hook called after every step with that step's
    # transition. Its time counts against your timing and episode budget.
    #
    # def learn(self, observation: Any, action: int, reward: float, terminated: bool) -> None:
    #     ...

    # Optional: a messaging hook (only used in environments with messaging enabled). Called
    # on your turn with the messages addressed to your slot; return messages to send, or
    # nothing to stay silent.
    #
    # def chat(self, inbox: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    #     ...
