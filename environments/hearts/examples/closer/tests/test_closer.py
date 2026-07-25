"""Example-specific tests, added on top of the inherited template tests."""

from __future__ import annotations

import agent
from sandbox.cards import CLUBS, play


def _observation(
    *, legal: list[dict[str, int]], trick: list[dict[str, int]], led: int, leader: int = 0
) -> dict:
    """Build the minimal observation the agent reads: the legal-move mask, the trick, the led suit.

    ``legal`` is the list of card objects the action mask should mark playable. ``trick`` holds the
    card objects already played this trick, in play order, starting at player ``leader`` and filling
    players clockwise (mirroring how the real environment lays out ``current_trick``). ``led`` is the
    led suit (``0..3``) or ``4`` when leading (no card down yet).
    """
    mask = [0] * 52
    for card in legal:
        mask[play(card)] = 1
    current_trick = tuple({"player": (leader + i) % 4, "card": card} for i, card in enumerate(trick))
    return {
        "action_mask": mask,
        "observation": {
            "player": (leader + len(trick)) % 4,
            "hand": tuple(legal),
            "current_trick": current_trick,
            "trick_leader": leader,
            "led_suit": led,
            "hearts_broken": 0,
            "scores": [0, 0, 0, 0],
        },
    }


def test_dumps_high_when_forced_to_win_a_points_free_trick_last():
    # Clubs led; players 0..2 played the 5, 6, 7 of clubs, no point cards. We are last (player 3) and
    # hold only the 9 and king of clubs, both of which would win. Winning is free here, so the
    # closer dumps the king, where the duck would cling to the 9.
    closer = agent.Agent()
    closer.reset(0)
    trick = [{"suit": CLUBS, "rank": 5}, {"suit": CLUBS, "rank": 6}, {"suit": CLUBS, "rank": 7}]
    legal = [{"suit": CLUBS, "rank": 9}, {"suit": CLUBS, "rank": 13}]
    observation = _observation(legal=legal, trick=trick, led=CLUBS)
    assert closer.act(observation) == play({"suit": CLUBS, "rank": 13})
