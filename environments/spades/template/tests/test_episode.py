"""Environment-layer full-episode coverage for the shared multi-player play loop."""

from __future__ import annotations

import time
from typing import Any

from sandbox import cards
from sandbox.env import META, make_env
from sandbox.harness.environment import resolve_parameters
from sandbox.play import play_episode, rival_player_ids

SEED = 23
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
    env = make_env({"seat_plan": "partnership"})
    started = time.monotonic()
    try:
        score = play_episode(FirstLegalAgent(), env, seed=SEED)
        assert not env.agents
        assert -260 <= score <= 260
    finally:
        env.close()
    assert time.monotonic() - started < RUNTIME_LIMIT_S


def test_rival_players_cover_only_the_opposing_partnership():
    parameters = resolve_parameters(META)

    assert rival_player_ids("player_0", parameters) == {"player_1", "player_3"}
    assert rival_player_ids("player_1", parameters) == {"player_0", "player_2"}
