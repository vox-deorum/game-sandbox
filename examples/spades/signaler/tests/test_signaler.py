"""Example-specific tests: the exact signal sent, and a play that provably depends on it.

These call ``chat`` and ``act`` directly with synthetic observations, so the behavioural dependence
on a message is pinned without a live harness. The full-game smoke test (inherited pattern) proves
the agent composes and plays a complete hand.
"""

from __future__ import annotations

from pathlib import Path

import agent
from sandbox.env import make_env
from sandbox.play import load_agent, play_episode

REPO_ROOT = Path(__file__).resolve().parent.parent

# Card ids under the fixed encoding (card = suit * 13 + rank; rank 12 is the ace).
TWO_OF_CLUBS = 0
TWO_OF_DIAMONDS = 13
ACE_OF_HEARTS = 3 * 13 + 12  # 51
ACE_OF_DIAMONDS = 1 * 13 + 12  # 25


def _bidding_observation(hand: list[int], *, position: int = 0) -> dict:
    """A bidding-phase observation carrying ``hand`` at seat ``position``: every bid legal, no card."""
    mask = [1 if 52 <= action < 66 else 0 for action in range(66)]
    hand_array = [1 if card in hand else 0 for card in range(52)]
    return {
        "action_mask": mask,
        "observation": {"phase": [0], "hand": hand_array, "position": [position]},
    }


def _leading_observation(hand: list[int], legal: list[int], *, position: int = 0) -> dict:
    """A play-phase observation where ``position`` is on lead (no card down yet)."""
    mask = [1 if card in legal else 0 for card in range(66)]
    hand_array = [1 if card in hand else 0 for card in range(52)]
    return {
        "action_mask": mask,
        "observation": {
            "phase": [1],
            "hand": hand_array,
            "position": [position],
            "trick": [-1, -1, -1, -1],  # nobody has played: this seat is leading
            "trick_leader": [position],
        },
    }


def test_example_loads_through_loader_and_plays_a_full_game():
    loaded = load_agent(REPO_ROOT)
    env = make_env(render_mode=None)
    try:
        score = play_episode(loaded, env, seed=0)
        assert not env.agents  # a complete hand: every seat has been dead-stepped
    finally:
        env.close()
    assert isinstance(score, float)


def test_signals_its_strong_side_suit_to_its_partner():
    # Seat 0 holds the ace of hearts, so its strong side suit is hearts, and its partner is seat 2.
    hand = [ACE_OF_HEARTS, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1, 2, TWO_OF_DIAMONDS]
    a = agent.Agent()
    a.reset(0)
    a.act(_bidding_observation(hand, position=0))  # stamps seat and hand
    assert a.chat([]) == [{"to": "player_2", "text": "strong:hearts"}]


def test_lead_changes_when_the_partner_signal_arrives():
    hand = [TWO_OF_CLUBS, TWO_OF_DIAMONDS]
    legal = [TWO_OF_CLUBS, TWO_OF_DIAMONDS]
    lead_obs = _leading_observation(hand, legal, position=0)

    # With a partner signal naming diamonds, the agent leads the 2 of diamonds.
    informed = agent.Agent()
    informed.reset(0)
    informed.act(_bidding_observation(hand, position=0))  # stamp seat 0 first
    informed.chat([{"from": "player_2", "to": "player_0", "text": "strong:diamonds", "tick": 1}])
    assert informed.act(lead_obs) == TWO_OF_DIAMONDS

    # The same agent with no signal falls back to the lowest legal card (2 of clubs).
    uninformed = agent.Agent()
    uninformed.reset(0)
    uninformed.act(_bidding_observation(hand, position=0))
    uninformed.chat([])
    assert uninformed.act(lead_obs) == TWO_OF_CLUBS


def test_stays_silent_without_a_side_ace():
    # No non-spade ace in hand: nothing to signal, so chat sends nothing.
    hand = [TWO_OF_CLUBS, TWO_OF_DIAMONDS, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    a = agent.Agent()
    a.reset(0)
    a.act(_bidding_observation(hand, position=0))
    assert a.chat([]) == []
