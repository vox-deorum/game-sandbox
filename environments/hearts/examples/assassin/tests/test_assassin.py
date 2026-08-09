"""Example-specific tests, added on top of the inherited template tests."""

from __future__ import annotations

import agent
from sandbox.cards import CLUBS, SPADES, play


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


def test_leads_a_spade_to_flush_the_queen():
    # Leading with the 2 of clubs and the 5 of spades both legal, the assassin leads the spade to
    # drag spades out, where the duck would lead its lowest card overall (2 of clubs).
    assassin = agent.Agent()
    assassin.reset(0, None)
    two_of_clubs = {"suit": CLUBS, "rank": 2}
    five_of_spades = {"suit": SPADES, "rank": 5}
    observation = _observation(legal=[two_of_clubs, five_of_spades], trick=[], led=4)
    chosen = assassin.act(observation)
    assert chosen == play(five_of_spades)
