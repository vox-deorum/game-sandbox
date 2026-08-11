"""The 'hello' example agent: a heuristic Flappy Bird player.

It overrides the template's starting ``agent.py`` and picks up where the environment page's
"Your first improvement" leaves off. That improvement aims the bird at the center of the next gap
(``player_y > next_gap_center``); this agent goes one step further and reacts to where the bird will
be on the next step, not where it is now, by adding its velocity before the comparison. It clearly
outperforms doing nothing, which the example test asserts.

It also uses the extra pinned dependency ``six`` (declared in ``requirements.extra.txt``) in a
trivial display helper, so the dependency-set extension path stays exercised end to end.
"""

from __future__ import annotations

from sandbox.features import FLAP, IDLE, FlappyObservation, next_gap_center, player_velocity, player_y
from six import text_type
from wcwidth import wcswidth

NAME = "hello-flappy"


class Agent:
    """Flap when the bird will be below the next gap's center next step, otherwise fall."""

    def reset(self, seed, observation) -> None:
        # Stateless heuristic: nothing to carry between or within episodes.
        pass

    def act(self, observation: FlappyObservation) -> int:
        # Start from the gap-center target of the environment page's first improvement, then add one
        # idea: react to where the bird will be, not where it is. player_velocity is in screen heights
        # per step (the same scale as y), so y + velocity estimates the next position. y grows
        # downward, so a larger sum means the bird is dropping below the gap center and it is time to
        # flap up.
        predicted_y = player_y(observation) + player_velocity(observation)
        return FLAP if predicted_y > next_gap_center(observation) else IDLE


def display_width(text: str = NAME) -> int:
    """Display width of ``text``, normalized through the extra dependency (six)."""
    return wcswidth(text_type(text))
