"""Example-specific tests: the exact signal sent, and a play that provably depends on it.

These call ``chat`` and ``act`` directly with synthetic observations, so the behavioural dependence
on a message is pinned without a live harness.
"""

from __future__ import annotations

import agent
from sandbox.cards import make_card
from sandbox.cards import play as encode_play

# Cards under the object encoding (face-value ranks: jack 11, queen 12, king 13, ace 14).
TWO_OF_CLUBS = make_card(0, 2)
TWO_OF_DIAMONDS = make_card(1, 2)
ACE_OF_HEARTS = make_card(3, 14)
ACE_OF_DIAMONDS = make_card(1, 14)


def _bidding_observation(hand: list[dict[str, int]], *, seat: int = 0) -> dict:
    """A bidding-phase observation carrying ``hand`` at ``seat``: every bid legal, no card."""
    mask = [1 if 52 <= action < 66 else 0 for action in range(66)]
    return {
        "action_mask": mask,
        "observation": {
            "seat": seat,
            "partner_seat": (seat + 2) % 4,
            "phase": 0,
            "hand": tuple(hand),
            "bids": (14, 14, 14, 14),
            "team_scores": [0, 0],
            "current_trick": (),
            "last_trick": (),
            "last_trick_winner": 4,
            "trick_leader": 0,
            "led_suit": 4,
            "spades_broken": 0,
            "tricks_won": [0, 0, 0, 0],
        },
    }


def _leading_observation(hand: list[dict[str, int]], legal: list[dict[str, int]], *, seat: int = 0) -> dict:
    """A play-phase observation where ``seat`` is on lead (no card down yet)."""
    legal_ids = {encode_play(c) for c in legal}
    mask = [1 if action in legal_ids else 0 for action in range(66)]
    return {
        "action_mask": mask,
        "observation": {
            "seat": seat,
            "partner_seat": (seat + 2) % 4,
            "phase": 1,
            "hand": tuple(hand),
            "bids": (5, 5, 5, 5),
            "team_scores": [0, 0],
            "current_trick": (),  # nobody has played: this seat is leading
            "last_trick": (),
            "last_trick_winner": 4,
            "trick_leader": seat,
            "led_suit": 4,
            "spades_broken": 0,
            "tricks_won": [0, 0, 0, 0],
        },
    }


def test_signals_its_strong_side_suit_to_its_partner():
    # Seat 0 holds the ace of hearts, so its strong side suit is hearts, and its partner is seat 2.
    hand = [
        ACE_OF_HEARTS,
        make_card(3, 4),
        make_card(3, 5),
        make_card(3, 6),
        make_card(3, 7),
        make_card(3, 8),
        make_card(3, 9),
        make_card(3, 10),
        make_card(3, 11),
        make_card(0, 2),
        make_card(0, 3),
        make_card(0, 4),
        TWO_OF_DIAMONDS,
    ]
    a = agent.Agent()
    a.reset(0)
    a.act(_bidding_observation(hand, seat=0))  # stamps partner seat and hand
    assert a.chat([]) == [{"to": "player_2", "text": "strong:hearts"}]


def test_lead_changes_when_the_partner_signal_arrives():
    hand = [TWO_OF_CLUBS, TWO_OF_DIAMONDS]
    legal = [TWO_OF_CLUBS, TWO_OF_DIAMONDS]
    lead_obs = _leading_observation(hand, legal, seat=0)

    # With a partner signal naming diamonds, the agent leads the 2 of diamonds.
    informed = agent.Agent()
    informed.reset(0)
    informed.act(_bidding_observation(hand, seat=0))  # stamp seat 0 first
    informed.chat([{"from": "player_2", "to": "player_0", "text": "strong:diamonds", "tick": 1}])
    assert informed.act(lead_obs) == encode_play(TWO_OF_DIAMONDS)

    # The same agent with no signal falls back to the lowest legal card (2 of clubs).
    uninformed = agent.Agent()
    uninformed.reset(0)
    uninformed.act(_bidding_observation(hand, seat=0))
    uninformed.chat([])
    assert uninformed.act(lead_obs) == encode_play(TWO_OF_CLUBS)


def test_stays_silent_without_a_side_ace():
    # No non-spade ace in hand: nothing to signal, so chat sends nothing.
    hand = [
        TWO_OF_CLUBS,
        TWO_OF_DIAMONDS,
        make_card(0, 3),
        make_card(0, 4),
        make_card(0, 5),
        make_card(0, 6),
        make_card(0, 7),
        make_card(0, 8),
        make_card(0, 9),
        make_card(0, 10),
        make_card(0, 11),
        make_card(0, 13),
        make_card(1, 3),
    ]
    a = agent.Agent()
    a.reset(0)
    a.act(_bidding_observation(hand, seat=0))
    assert a.chat([]) == []
