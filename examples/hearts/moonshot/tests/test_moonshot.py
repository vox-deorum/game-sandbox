"""Example-specific tests, added on top of the inherited template tests."""

from __future__ import annotations

from pathlib import Path

import agent
from sandbox.cards import CLUBS, play
from sandbox.env import make_env
from sandbox.play import load_agent, play_episode

REPO_ROOT = Path(__file__).resolve().parent.parent


def _observation(
    *, legal: list[dict[str, int]], trick: list[dict[str, int]], led: int, leader: int = 0
) -> dict:
    """Build the minimal observation the agent reads: the legal-move mask, the trick, the led suit.

    ``legal`` is the list of card objects the action mask should mark playable. ``trick`` holds the
    card objects already played this trick, in play order, starting at seat ``leader`` and filling
    seats clockwise (mirroring how the real environment lays out ``current_trick``). ``led`` is the
    led suit (``0..3``) or ``4`` when leading (no card down yet).
    """
    mask = [0] * 52
    for card in legal:
        mask[play(card)] = 1
    current_trick = tuple({"seat": (leader + i) % 4, "card": card} for i, card in enumerate(trick))
    return {
        "action_mask": mask,
        "observation": {
            "seat": (leader + len(trick)) % 4,
            "hand": tuple(legal),
            "current_trick": current_trick,
            "trick_leader": leader,
            "led_suit": led,
            "hearts_broken": 0,
            "scores": [0, 0, 0, 0],
        },
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
    # Clubs are led with the 5 winning so far; we hold the 3 and the king. The moonshot wants the
    # points, so it plays the king to take the trick, where the duck would shed the 3 and stay out
    # of it.
    moonshot = agent.Agent()
    moonshot.reset(0)
    trick = [{"suit": CLUBS, "rank": 5}]
    legal = [{"suit": CLUBS, "rank": 3}, {"suit": CLUBS, "rank": 13}]
    observation = _observation(legal=legal, trick=trick, led=CLUBS)
    assert moonshot.act(observation) == play({"suit": CLUBS, "rank": 13})
