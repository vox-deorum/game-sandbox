"""Example-specific tests, added on top of the inherited template tests."""

from __future__ import annotations

from pathlib import Path

import agent
from sandbox.env import make_env
from sandbox.play import load_agent, play_episode

REPO_ROOT = Path(__file__).resolve().parent.parent

SPADES = 2


def _observation(*, legal: list[int], trick: list[int], led: int) -> dict:
    """Build the minimal observation the agent reads: the legal-move mask, the trick, the led suit.

    ``trick`` is indexed by seat (a card or ``-1``); ``led`` is the led suit or ``-1`` when leading.
    """
    mask = [1 if card in legal else 0 for card in range(52)]
    return {"action_mask": mask, "observation": {"led_suit": [led], "trick": list(trick)}}


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


def test_leads_a_spade_to_flush_the_queen():
    # Leading with the 2 of clubs (card 0) and the 5 of spades (card 29) both legal, the assassin
    # leads the spade to drag spades out, where the duck would lead its lowest card overall (2♣).
    assassin = agent.Agent()
    assassin.reset(0)
    observation = _observation(legal=[0, 29], trick=[-1, -1, -1, -1], led=-1)
    chosen = assassin.act(observation)
    assert chosen == 29
    assert chosen // 13 == SPADES
