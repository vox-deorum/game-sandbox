"""Example-specific tests, added on top of the inherited template tests."""

from __future__ import annotations

from pathlib import Path

import agent
from sandbox.env import make_env
from sandbox.play import load_agent, play_episode

REPO_ROOT = Path(__file__).resolve().parent.parent


def _bidding_observation(hand: list[int]) -> dict:
    """Build a bidding-phase observation carrying ``hand``: every bid is legal, no card is.

    ``phase`` is ``0`` (bidding) and the action mask flags the fourteen bid actions ``52..65``, which
    is what ``is_bidding`` and ``legal_bids`` read. ``hand`` is the 52-long membership array the
    honest-bid count walks.
    """
    mask = [1 if 52 <= action < 66 else 0 for action in range(66)]
    hand_array = [1 if card in hand else 0 for card in range(52)]
    return {"action_mask": mask, "observation": {"phase": [0], "hand": hand_array}}


def test_example_loads_through_loader_and_plays_a_full_game():
    # The loader mirrors the server harness: read manifest.json, import the class, instantiate it.
    loaded = load_agent(REPO_ROOT)
    env = make_env(render_mode=None)
    try:
        score = play_episode(loaded, env, seed=0)
        # A complete hand: every seat has been dead-stepped, so the agent list has drained.
        assert not env.agents
    finally:
        env.close()
    assert isinstance(score, float)


def test_bids_high_spades_plus_side_aces():
    # Hand: A/K/Q of spades (cards 38, 37, 36) -> 3 high spades; ace of diamonds (25) and ace of
    # clubs (12) -> 2 side aces; the rest low filler. The honest count is 5, encoded as 52 + 5 = 57.
    hand = [38, 37, 36, 25, 12, 0, 1, 2, 3, 13, 14, 15, 16]
    counter = agent.Agent()
    counter.reset(0)
    assert counter.act(_bidding_observation(hand)) == 57


def test_never_bids_nil_on_a_thin_hand():
    # No high spades and no side aces: the raw count is 0, but the counter never gambles on nil, so
    # it floors the bid at 1 (action 53), not the nil action 52.
    hand = [26, 27, 28, 29, 0, 1, 2, 3, 4, 13, 14, 15, 16]
    counter = agent.Agent()
    counter.reset(0)
    assert counter.act(_bidding_observation(hand)) == 53
