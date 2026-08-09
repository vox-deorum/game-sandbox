"""A tiny Days at Three Branches example that uses the sweep expression."""

from __future__ import annotations

from typing import Any


class Agent:
    """Stay in place and sweep each tick."""

    def reset(self, seed: int, observation: dict[str, Any]) -> None:
        """Prepare for one village day."""

    def act(self, observation: dict[str, Any]) -> dict[str, float | int]:
        """Return a stationary sweep expression using the raw action dictionary."""
        return {"heading": float(observation["self"]["heading"]), "speed": 0.0, "action": 10}
