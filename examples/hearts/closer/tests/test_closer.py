"""Example-specific tests, added on top of the inherited template tests."""

from __future__ import annotations

from pathlib import Path

import agent
from sandbox.env import make_env
from sandbox.play import load_agent, play_episode

REPO_ROOT = Path(__file__).resolve().parent.parent


def _observation(*, legal: list[int], trick: list[int], led: int, leader: int = 0) -> dict:
    """Build the minimal observation the agent reads: the legal-move mask, the trick, the led suit.

    ``trick`` is indexed by seat (a card or ``-1``); ``led`` is the led suit or ``-1`` when leading.
    ``leader`` is the seat that led this trick, which the card helpers use to read the trick in play
    order (the synthetic tricks here fill seats from 0, so seat 0 leads).
    """
    mask = [1 if card in legal else 0 for card in range(52)]
    return {
        "action_mask": mask,
        "observation": {"led_suit": [led], "trick": list(trick), "trick_leader": [leader]},
    }


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


def test_dumps_high_when_forced_to_win_a_points_free_trick_last():
    # Clubs led; seats 0..2 played the 5, 6, 7 (cards 3, 4, 5), no point cards. We are last (seat 3)
    # and hold only the 9 and king of clubs (cards 7 and 11), both of which would win. Winning is
    # free here, so the closer dumps the king, where the duck would cling to the 9.
    closer = agent.Agent()
    closer.reset(0)
    observation = _observation(legal=[7, 11], trick=[3, 4, 5, -1], led=0)
    assert closer.act(observation) == 11
