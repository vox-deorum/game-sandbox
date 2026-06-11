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

from wcwidth import wcswidth

NAME = "hello-flappy"

# Observation indices (12-feature, normalized): the "next" pipe the bird must clear is the
# middle of the three reported pipes; its gap spans indices 4 (top) and 5 (bottom), and the
# bird's own vertical position is index 9. All three share the same screen-height scale, so
# they compare directly.
NEXT_GAP_TOP = 4
NEXT_GAP_BOTTOM = 5
PLAYER_Y = 9

FLAP = 1
IDLE = 0


class Agent:
    """Flap when the bird is below the next gap's center, otherwise fall."""

    def reset(self, seed: int) -> None:
        # Stateless heuristic: nothing to carry between or within episodes.
        pass

    def act(self, observation: Any) -> int:
        gap_center = (observation[NEXT_GAP_TOP] + observation[NEXT_GAP_BOTTOM]) / 2.0
        # y grows downward, so "below the center" means a larger y.
        return FLAP if observation[PLAYER_Y] > gap_center else IDLE


def display_width(text: str = NAME) -> int:
    """Display width of ``text``, computed via the extra dependency (wcwidth)."""
    return wcswidth(text)
