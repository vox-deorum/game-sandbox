"""Example-specific tests, added on top of the inherited template tests."""

from __future__ import annotations

import agent
from sandbox.env import make_env
from sandbox.play import play_episode

_SEEDS = [0, 1, 2, 3, 4, 5, 6, 7]


def test_extra_dependency_is_usable():
    # six comes from requirements.extra.txt; reaching the helper proves it composed in.
    assert agent.display_width("duck") == 4


class Baseline:
    """The built-in opponent's policy: the lowest legal card (by rank, then suit)."""

    def reset(self, seed, observation) -> None: ...

    def act(self, observation) -> int:
        mask = observation["action_mask"]
        legal = [card for card in range(52) if mask[card]]
        return min(legal, key=lambda card: (card % 13, card // 13))


def _mean_score(policy) -> float:
    # play_episode matches `policy` against three built-in opponents and returns its leaderboard
    # score (higher is better: the negated penalty total).
    scores: list[float] = []
    for seed in _SEEDS:
        env = make_env({"players": 4})
        try:
            scores.append(play_episode(policy, env, seed=seed))
        finally:
            env.close()
    return sum(scores) / len(scores)


def test_duck_takes_fewer_points_than_the_baseline():
    # Same deals, same opponents, only player 0 differs: the duck heuristic should out-score the
    # lowest-legal-card baseline it replaces (a higher leaderboard score means fewer points taken).
    assert _mean_score(agent.Agent()) > _mean_score(Baseline()) + 1.0
