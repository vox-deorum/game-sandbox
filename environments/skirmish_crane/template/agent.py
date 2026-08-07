"""A legal starting agent for Skirmish at Crane Reach.

The observation and action shapes are available as the SkirmishObservation and SkirmishAction
types, importable from ``sandbox.observation_types``, for editors and type checkers.
"""

from __future__ import annotations

from sandbox.observation_types import SkirmishAction, SkirmishObservation


class Agent:
    """Observe each turn, keep this unit in place, and leave targeting automatic."""

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation: SkirmishObservation) -> SkirmishAction:
        return {"path": 0, "target": 0}

    # Optional: receive messages addressed to this player and return messages to send.
    # Return nothing to stay silent.
    #
    # def chat(self, inbox: list[dict]) -> list[dict] | None:
    #     ...
