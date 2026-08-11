"""Example-specific tests, added on top of the inherited template tests."""

from __future__ import annotations

import agent
from sandbox.env.flappy_bird.env import make_env
from sandbox.play import play_episode

_SEEDS = [0, 1, 2, 3, 4]


def test_extra_dependency_is_usable():
    # six comes from requirements.extra.txt; reaching the helper proves it composed in.
    assert agent.display_width("hello") == 5


def _mean_score(policy) -> float:
    scores: list[float] = []
    for seed in _SEEDS:
        env = make_env({"players": 1, "pipe_gap": 100})
        try:
            scores.append(play_episode(policy, env, seed=seed))
        finally:
            env.close()
    return sum(scores) / len(scores)


def test_heuristic_clearly_outperforms_noop():
    class Noop:
        def reset(self, seed, observation) -> None: ...

        def act(self, observation) -> int:
            return 0

    assert _mean_score(agent.Agent()) > _mean_score(Noop()) + 1.0
