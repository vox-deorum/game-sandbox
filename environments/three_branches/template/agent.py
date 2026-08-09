"""A working Days at Three Branches starter agent.

The raw observation is a dictionary. This agent keeps its current heading, does not move, and
chooses no expression. Read ``environment.md`` before changing the policy.
"""

from __future__ import annotations

from typing import Any


class Agent:
    """Stand still while preserving the character's current heading."""

    def reset(self, seed: int, observation: dict[str, Any]) -> None:
        """Prepare for one village day."""

    def act(self, observation: dict[str, Any]) -> dict[str, float | int]:
        """Return the stand-still action, which is legal throughout a day."""
        return {"heading": float(observation["self"]["heading"]), "speed": 0.0, "action": 0}

    # Optional: read messages addressed to this character and return messages to send. A direct
    # message uses a player id such as {"to": "player_1", "text": "Hello"}. Use None for `to` to
    # broadcast within the environment's range. Return nothing to stay silent.
    #
    # def chat(self, inbox: list[dict]) -> list[dict] | None:
    #     ...
