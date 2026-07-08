"""The frozen v1 built-in Flappy Bird agent.

It reads the semantic Flappy observation object — a ``player`` dict and a nearest-first ``pipes``
sequence of ``{"x", "gap_top", "gap_bottom"}`` in real screen pixels (y grows downward) — so it needs
no dependency beyond the standard library (plus the frozen ``wcwidth`` extra the image pins).
"""

from __future__ import annotations

from typing import Any

from wcwidth import wcswidth

NAME = "hello-flappy"

FLAP = 1
IDLE = 0


class Agent:
    """Flap when the bird is below the next gap's center, otherwise fall."""

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation: Any) -> int:
        pipes = observation["pipes"]
        # Aim for the nearest pipe's gap center; with no pipe in view, hold mid-screen.
        if pipes:
            gap_center = (pipes[0]["gap_top"] + pipes[0]["gap_bottom"]) / 2.0
        else:
            gap_center = observation["height"] / 2.0
        return FLAP if observation["player"]["y"] > gap_center else IDLE


def display_width(text: str = NAME) -> int:
    """Display width of ``text``, computed via the frozen extra dependency."""
    return wcswidth(text)
