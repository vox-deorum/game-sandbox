"""The smallest honest Skirmish at Crane Reach example agent."""

from __future__ import annotations

from typing import Any


class Agent:
    """Keep this unit in place and leave targeting automatic."""

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation: Any) -> dict[str, int]:
        return {"path": 0, "target": 0}
