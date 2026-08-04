"""A legal starting agent for Skirmish at Crane Reach."""

from __future__ import annotations

from typing import Any


class Agent:
    """Observe each turn, keep this unit in place, and leave targeting automatic."""

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation: Any) -> dict[str, int]:
        return {"path": 0, "target": 0}

    # Optional: receive messages addressed to this player and return messages to send.
    # Return nothing to stay silent.
    #
    # def chat(self, inbox: list[dict]) -> list[dict] | None:
    #     ...
