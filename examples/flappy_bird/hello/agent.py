"""The 'hello' example agent: a heuristic Flappy Bird player.

It overrides the template's placeholder ``agent.py``. The policy is one line of intuition —
flap whenever the bird has fallen below the center of the next gap — implemented over the
12-feature observation. It clearly outperforms doing nothing, which the example test asserts,
and it is the agent the harness CLI plays for the Stage 2 exit criterion.

It also uses the extra pinned dependency ``wcwidth`` (declared in ``requirements.extra.txt``)
in a trivial display helper, so the dependency-set extension path stays exercised end to end.
"""

from __future__ import annotations

from typing import Any

from sandbox.features import FLAP, IDLE, next_gap_center, player_y
from wcwidth import wcswidth

NAME = "hello-flappy"


class Agent:
    """Flap when the bird is below the next gap's center, otherwise fall."""

    def reset(self, seed: int) -> None:
        # Stateless heuristic: nothing to carry between or within episodes.
        pass

    def act(self, observation: Any) -> int:
        # y grows downward, so "below the center" (a larger y) means it is time to flap up.
        return FLAP if player_y(observation) > next_gap_center(observation) else IDLE


def display_width(text: str = NAME) -> int:
    """Display width of ``text``, computed via the extra dependency (wcwidth)."""
    return wcswidth(text)
