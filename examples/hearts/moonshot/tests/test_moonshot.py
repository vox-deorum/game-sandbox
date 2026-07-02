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


def test_takes_a_winnable_trick_by_following_high():
    # Clubs are led with the 5 (card 3) winning so far; we hold the 3 (card 1) and the king
    # (card 11). The moonshot wants the points, so it plays the king to take the trick, where the
    # duck would shed the 3 and stay out of it.
    moonshot = agent.Agent()
    moonshot.reset(0)
    observation = _observation(legal=[1, 11], trick=[3, -1, -1, -1], led=0)
    assert moonshot.act(observation) == 11
