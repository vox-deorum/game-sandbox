"""Example-specific tests, added on top of the inherited template tests."""

from __future__ import annotations

import agent
from sandbox.cards import make_card

NO_TRICK: tuple = ()


def _bidding_observation(hand: list[dict[str, int]]) -> dict:
    """Build a bidding-phase observation carrying ``hand``: every bid is legal, no card is.

    ``phase`` is ``0`` (bidding) and the action mask flags the fourteen bid actions ``52..65``, which
    is what ``is_bidding`` and ``legal_bids`` read. ``hand`` is the tuple of card objects the honest-
    bid count walks.
    """
    mask = [1 if 52 <= action < 66 else 0 for action in range(66)]
    return {
        "action_mask": mask,
        "observation": {
            "player": 0,
            "partner_player": 2,
            "phase": 0,
            "hand": tuple(hand),
            "bids": (14, 14, 14, 14),
            "team_scores": [0, 0],
            "current_trick": NO_TRICK,
            "last_trick": NO_TRICK,
            "last_trick_winner": 4,
            "trick_leader": 0,
            "led_suit": 4,
            "spades_broken": 0,
            "tricks_won": [0, 0, 0, 0],
        },
    }


def test_bids_high_spades_plus_side_aces():
    # Hand: A/K/Q of spades -> 3 high spades; ace of diamonds and ace of clubs -> 2 side aces; the
    # rest low filler. The honest count is 5, encoded as 52 + 5 = 57.
    hand = [
        make_card(2, 14),  # ace of spades
        make_card(2, 13),  # king of spades
        make_card(2, 12),  # queen of spades
        make_card(1, 14),  # ace of diamonds
        make_card(0, 14),  # ace of clubs
        make_card(0, 2),
        make_card(0, 3),
        make_card(0, 4),
        make_card(0, 5),
        make_card(1, 2),
        make_card(1, 3),
        make_card(1, 4),
        make_card(1, 5),
    ]
    counter = agent.Agent()
    counter.reset(0)
    assert counter.act(_bidding_observation(hand)) == 57


def test_never_bids_nil_on_a_thin_hand():
    # No high spades and no side aces: the raw count is 0, but the counter never gambles on nil, so
    # it floors the bid at 1 (action 53), not the nil action 52.
    hand = [
        make_card(2, 2),
        make_card(2, 3),
        make_card(2, 4),
        make_card(2, 5),
        make_card(0, 2),
        make_card(0, 3),
        make_card(0, 4),
        make_card(0, 5),
        make_card(0, 6),
        make_card(1, 2),
        make_card(1, 3),
        make_card(1, 4),
        make_card(1, 5),
    ]
    counter = agent.Agent()
    counter.reset(0)
    assert counter.act(_bidding_observation(hand)) == 53
