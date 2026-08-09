"""The minimal baseline agent for Days at Three Branches."""

from __future__ import annotations

from typing import Any


class Agent:
    """Stand still while preserving the character's current heading."""

    def reset(self, seed: int, observation: Any) -> None:
        """Prepare the agent for a new day."""

    def act(self, observation: Any) -> dict[str, float | int]:
        """Return the environment's default action for the supplied observation."""
        return {"heading": float(observation["self"]["heading"]), "speed": 0.0, "action": 0}
