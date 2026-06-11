"""Environment-level tests for Flappy Bird: API conformance, seeded determinism, the overlay
extractor, and metadata serialization.

The determinism test runs at the environment level — two resets with the same seed under the
same scripted action list must produce identical observation and overlay sequences — so an
environment-level seeding gap is caught here, at the wrapper, before the harness-level
recording determinism test ever runs and might misattribute it.
"""

from __future__ import annotations

import json
import math

import numpy as np
from pettingzoo.test import api_test

from game_sandbox_environments.flappy_bird import ENTRY
from game_sandbox_environments.flappy_bird.env import make_env
from game_sandbox_environments.flappy_bird.overlay import extract_overlay


def test_passes_pettingzoo_api_test():
    api_test(make_env(), num_cycles=100)


def _rollout(seed: int, actions: list[int]) -> tuple[list, list]:
    env = make_env()
    env.reset(seed=seed)
    observations: list = []
    overlays: list = []
    for action in actions:
        _obs, _r, term, trunc, _i = env.last()
        if term or trunc:
            break
        observations.append(np.array(env.observe("player_0"), copy=True))
        overlays.append(extract_overlay(env))
        env.step(action)
    env.close()
    return observations, overlays


def test_same_seed_produces_identical_observation_and_overlay_sequences():
    actions = [0, 1, 0, 0, 1, 0, 1, 1, 0, 0]
    obs_a, ov_a = _rollout(123, actions)
    obs_b, ov_b = _rollout(123, actions)
    assert len(obs_a) == len(obs_b)
    for a, b in zip(obs_a, obs_b, strict=True):
        assert np.array_equal(a, b)
    assert json.dumps(ov_a, sort_keys=True) == json.dumps(ov_b, sort_keys=True)


def test_different_seeds_diverge():
    actions = [0] * 10
    _obs_a, ov_a = _rollout(1, actions)
    _obs_b, ov_b = _rollout(2, actions)
    # Different seeds place pipes differently, so the overlays must differ somewhere.
    assert ov_a != ov_b


def test_overlay_has_every_field_and_all_finite():
    env = make_env()
    env.reset(seed=7)
    overlay = extract_overlay(env)
    assert set(overlay) == {"player", "pipes", "pipes_passed", "width", "height"}
    player = overlay["player"]
    assert set(player) == {"x", "y", "vel_y", "rot"}
    for value in player.values():
        assert math.isfinite(value)
    assert overlay["pipes"], "expected at least one pipe"
    for pipe in overlay["pipes"]:
        assert set(pipe) == {"x", "gap_top", "gap_bottom"}
        for value in pipe.values():
            assert math.isfinite(value)
    assert isinstance(overlay["pipes_passed"], int)
    assert overlay["width"] > 0 and overlay["height"] > 0
    env.close()


def test_entry_metadata_round_trips_through_json():
    blob = json.dumps(ENTRY.meta.to_json())
    parsed = json.loads(blob)
    assert parsed["env_id"] == "flappy_bird"
    assert parsed["renderer"] == "flappy-bird"
    assert parsed["min_slots"] == parsed["max_slots"] == 1


def test_default_action_is_noop():
    assert ENTRY.default_action("player_0") == 0
