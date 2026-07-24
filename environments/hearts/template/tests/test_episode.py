"""Environment-layer full-episode coverage for the shared multi-seat play loop."""

from __future__ import annotations

import time
from typing import Any

from sandbox import cards
from sandbox.env import make_env
from sandbox.play import play_episode

SEED = 17
RUNTIME_LIMIT_S = 5.0


class FirstLegalAgent:
    """A deterministic policy that trusts the environment-owned action mask."""

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation: Any) -> int:
        return next(action for action, legal in enumerate(observation["action_mask"]) if legal)


def test_cards_keeps_conversion_helpers_in_its_wildcard_api():
    assert {"card_from_obj", "card_to_obj"} <= set(cards.__all__)


def test_template_play_loop_completes_a_bounded_episode():
    env = make_env({"seats": 4})
    started = time.monotonic()
    try:
        score = play_episode(FirstLegalAgent(), env, seed=SEED)
        assert not env.agents
        assert -26 <= score <= 0
    finally:
        env.close()
    assert time.monotonic() - started < RUNTIME_LIMIT_S
