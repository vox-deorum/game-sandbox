"""Example-specific tests: the nil bid and its broadcast, and a cover that depends on the warning.

Direct ``chat``/``act`` calls on synthetic observations pin the behaviour without a live harness; the
full-game smoke test proves the agent composes and plays a complete hand.
"""

from __future__ import annotations

from pathlib import Path

import agent
from sandbox.cards import make_card
from sandbox.cards import play as encode_play
from sandbox.env import make_env
from sandbox.play import load_agent, play_episode

REPO_ROOT = Path(__file__).resolve().parent.parent

NIL_ACTION = 52  # bid(0)

# Cards used across the play-phase tests (face-value ranks: jack 11, queen 12, king 13, ace 14).
THREE_OF_HEARTS = make_card(3, 3)
FIVE_OF_HEARTS = make_card(3, 5)
ACE_OF_HEARTS = make_card(3, 14)
ACE_OF_SPADES = make_card(2, 14)

# A hand safe for nil: every card low (nothing queen-high), only two low spades.
QUALIFYING_HAND = [
    make_card(0, 2),
    make_card(0, 3),
    make_card(0, 4),
    make_card(0, 5),
    make_card(0, 6),
    make_card(0, 7),
    make_card(0, 8),
    make_card(1, 2),
    make_card(1, 3),
    make_card(1, 4),
    make_card(2, 2),
    make_card(2, 3),
]
# A hand far too strong for nil: the top spades and a couple of side aces.
STRONG_HAND = [
    ACE_OF_SPADES,
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


def _bidding_observation(hand: list[dict[str, int]], *, seat: int = 0) -> dict:
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


def _following_observation(
    hand: list[dict[str, int]],
    legal: list[dict[str, int]],
    *,
    seat: int = 2,
    leader: int = 1,
    leader_card: dict[str, int] = FIVE_OF_HEARTS,
) -> dict:
    """A play-phase observation where ``leader`` has already played ``leader_card`` and we follow."""
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
            "current_trick": ({"seat": leader, "card": leader_card},),
            "last_trick": (),
            "last_trick_winner": 4,
            "trick_leader": leader,
            "led_suit": leader_card["suit"],
            "spades_broken": 0,
            "tricks_won": [0, 0, 0, 0],
        },
    }


def test_example_loads_through_loader_and_plays_a_full_game():
    loaded = load_agent(REPO_ROOT)
    env = make_env(render_mode=None)
    try:
        score = play_episode(loaded, env, seed=1236)
        assert not env.agents
    finally:
        env.close()
    assert isinstance(score, float)


def test_bids_nil_and_broadcasts_the_warning_on_a_qualifying_hand():
    a = agent.Agent()
    a.reset(0)
    assert a.act(_bidding_observation(QUALIFYING_HAND)) == NIL_ACTION
    assert a.chat([]) == [{"to": None, "text": "nil! cover me"}]


def test_never_bids_nil_on_a_strong_hand():
    a = agent.Agent()
    a.reset(0)
    action = a.act(_bidding_observation(STRONG_HAND))
    assert action != NIL_ACTION  # an honest count, never the nil action
    # A non-nil bidder does not warn the table.
    assert a.chat([]) == []


def test_cover_play_depends_on_the_partner_warning():
    legal = [THREE_OF_HEARTS, ACE_OF_HEARTS]
    hand = legal
    follow = _following_observation(hand, legal, seat=2)

    # Warned by the partner's broadcast, it covers by winning the trick with the ace.
    covering = agent.Agent()
    covering.reset(0)
    covering.act(_bidding_observation(STRONG_HAND, seat=2))  # a non-nil hand, so it can cover
    covering.chat([{"from": "player_0", "to": None, "text": "nil! cover me", "tick": 1}])
    assert covering.act(follow) == encode_play(ACE_OF_HEARTS)

    # With no warning, the same agent ducks with its lowest legal card.
    ducking = agent.Agent()
    ducking.reset(0)
    ducking.act(_bidding_observation(STRONG_HAND, seat=2))
    ducking.chat([])
    assert ducking.act(follow) == encode_play(THREE_OF_HEARTS)


def test_ignores_a_nil_warning_from_an_opponent():
    # Seat 2's partner is seat 0; seat 1 is an opponent. An opponent shouting the same warning must
    # not steer the cover, so the agent still ducks with its lowest legal card.
    legal = [THREE_OF_HEARTS, ACE_OF_HEARTS]
    follow = _following_observation(legal, legal, seat=2)

    a = agent.Agent()
    a.reset(0)
    a.act(_bidding_observation(STRONG_HAND, seat=2))
    a.chat([{"from": "player_1", "to": None, "text": "nil! cover me", "tick": 1}])
    assert a.act(follow) == encode_play(THREE_OF_HEARTS)
