"""Environment-layer full-episode coverage for the shared multi-player play loop."""

from __future__ import annotations

import shutil
import time
from pathlib import Path
from typing import Any

from sandbox import cards
from sandbox.env import make_env
from sandbox.play import REPO_ROOT, play_episode, run_headless

SEED = 17
RUNTIME_LIMIT_S = 5.0


class FirstLegalAgent:
    """A deterministic policy that trusts the environment-owned action mask."""

    def reset(self, seed, observation) -> None:
        pass

    def act(self, observation: Any) -> int:
        return next(action for action, legal in enumerate(observation["action_mask"]) if legal)


class LastLegalAgent:
    """A deterministic rival that plays the highest-indexed legal card."""

    def reset(self, seed, observation) -> None:
        pass

    def act(self, observation: Any) -> int:
        return max(action for action, legal in enumerate(observation["action_mask"]) if legal)


def test_cards_keeps_conversion_helpers_in_its_wildcard_api():
    assert {"card_from_obj", "card_to_obj"} <= set(cards.__all__)


def test_template_play_loop_completes_a_bounded_episode():
    env = make_env({"players": 4})
    started = time.monotonic()
    try:
        score = play_episode(FirstLegalAgent(), env, seed=SEED)
        assert not env.agents
        assert -26 <= score <= 0
    finally:
        env.close()
    assert time.monotonic() - started < RUNTIME_LIMIT_S


def test_play_episode_runs_named_rival_agents_to_completion():
    env = make_env({"players": 4})
    rivals = {f"player_{index}": LastLegalAgent() for index in (1, 2, 3)}
    try:
        score = play_episode(FirstLegalAgent(), env, seed=SEED, other_agents=rivals)
        assert not env.agents
        assert -26 <= score <= 0
    finally:
        env.close()


def test_run_headless_accepts_a_rival_snapshot(tmp_path: Path):
    rival = tmp_path / "v1"
    rival.mkdir()
    for name in ("agent.py", "manifest.json"):
        shutil.copy(REPO_ROOT / name, rival / name)

    score = run_headless(seed=SEED, max_steps=None, seat=0, vs=rival)

    assert -26 <= score <= 0
