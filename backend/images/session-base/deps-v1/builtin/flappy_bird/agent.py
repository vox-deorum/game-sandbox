"""The frozen v1 built-in Flappy Bird agent."""

from __future__ import annotations

from typing import Any

from wcwidth import wcswidth

NAME = "hello-flappy"

NEXT_GAP_TOP = 4
NEXT_GAP_BOTTOM = 5
PLAYER_Y = 9

FLAP = 1
IDLE = 0


class Agent:
    """Flap when the bird is below the next gap's center, otherwise fall."""

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation: Any) -> int:
        gap_center = (observation[NEXT_GAP_TOP] + observation[NEXT_GAP_BOTTOM]) / 2.0
        return FLAP if observation[PLAYER_Y] > gap_center else IDLE


def display_width(text: str = NAME) -> int:
    """Display width of ``text``, computed via the frozen extra dependency."""
    return wcswidth(text)
