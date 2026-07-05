"""Example-specific tests: the nil bid and its broadcast, and a cover that depends on the warning.

Direct ``chat``/``act`` calls on synthetic observations pin the behaviour without a live harness; the
full-game smoke test proves the agent composes and plays a complete hand.
"""

from __future__ import annotations

from pathlib import Path

import agent
from sandbox.env import make_env
from sandbox.play import load_agent, play_episode

REPO_ROOT = Path(__file__).resolve().parent.parent

NIL_ACTION = 52  # bid_to_action(0)

# Card ids (card = suit * 13 + rank; clubs 0-12, diamonds 13-25, spades 26-38, hearts 39-51).
THREE_OF_HEARTS = 3 * 13 + 1  # 40
FIVE_OF_HEARTS = 3 * 13 + 3  # 42
ACE_OF_HEARTS = 3 * 13 + 12  # 51
ACE_OF_SPADES = 2 * 13 + 12  # 38

# A hand safe for nil: every card low (nothing queen-high), only two low spades.
QUALIFYING_HAND = [0, 1, 2, 3, 4, 5, 6, 7, 13, 14, 15, 26, 27]
# A hand far too strong for nil: the top spades and a couple of side aces.
STRONG_HAND = [ACE_OF_SPADES, 37, 36, 25, 12, 0, 1, 2, 3, 13, 14, 15, 16]


def _bidding_observation(hand: list[int], *, position: int = 0) -> dict:
    mask = [1 if 52 <= action < 66 else 0 for action in range(66)]
    hand_array = [1 if card in hand else 0 for card in range(52)]
    return {
        "action_mask": mask,
        "observation": {"phase": [0], "hand": hand_array, "position": [position]},
    }


def _following_observation(
    hand: list[int],
    legal: list[int],
    *,
    position: int = 2,
    leader: int = 1,
    leader_card: int = FIVE_OF_HEARTS,
) -> dict:
    """A play-phase observation where ``leader`` has already played ``leader_card`` and we follow."""
    trick = [-1, -1, -1, -1]
    trick[leader] = leader_card
    mask = [1 if card in legal else 0 for card in range(66)]
    hand_array = [1 if card in hand else 0 for card in range(52)]
    return {
        "action_mask": mask,
        "observation": {
            "phase": [1],
            "hand": hand_array,
            "position": [position],
            "trick": trick,
            "trick_leader": [leader],
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
    follow = _following_observation(legal, legal, position=2)

    # Warned by the partner's broadcast, it covers by winning the trick with the ace.
    covering = agent.Agent()
    covering.reset(0)
    covering.act(_bidding_observation(STRONG_HAND, position=2))  # a non-nil hand, so it can cover
    covering.chat([{"from": "player_0", "to": None, "text": "nil! cover me", "tick": 1}])
    assert covering.act(follow) == ACE_OF_HEARTS

    # With no warning, the same agent ducks with its lowest legal card.
    ducking = agent.Agent()
    ducking.reset(0)
    ducking.act(_bidding_observation(STRONG_HAND, position=2))
    ducking.chat([])
    assert ducking.act(follow) == THREE_OF_HEARTS


def test_ignores_a_nil_warning_from_an_opponent():
    # Seat 2's partner is seat 0; seat 1 is an opponent. An opponent shouting the same warning must
    # not steer the cover, so the agent still ducks with its lowest legal card.
    legal = [THREE_OF_HEARTS, ACE_OF_HEARTS]
    follow = _following_observation(legal, legal, position=2)

    a = agent.Agent()
    a.reset(0)
    a.act(_bidding_observation(STRONG_HAND, position=2))
    a.chat([{"from": "player_1", "to": None, "text": "nil! cover me", "tick": 1}])
    assert a.act(follow) == THREE_OF_HEARTS
