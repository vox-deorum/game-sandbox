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

from flappy_bird import ENTRY
from flappy_bird.env import default_action, make_env
from flappy_bird.overlay import extract_overlay


def test_passes_pettingzoo_api_test():
    api_test(make_env(), num_cycles=100)


def _snapshot(observed: dict) -> dict:
    """Return a plain (JSON/equality-friendly) copy of an ``observe()`` result for comparison."""
    pipe_keys = ("x", "gap_top", "gap_bottom")
    return {
        "player": {k: float(v) for k, v in observed["player"].items()},
        "pipes": tuple(tuple(float(pipe[k]) for k in pipe_keys) for pipe in observed["pipes"]),
        "pipes_passed": int(observed["pipes_passed"]),
        "width": int(observed["width"]),
        "height": int(observed["height"]),
    }


def _rollout(seed: int, actions: list[int]) -> tuple[list, list]:
    env = make_env()
    env.reset(seed=seed)
    observations: list = []
    overlays: list = []
    for action in actions:
        _obs, _r, term, trunc, _i = env.last()
        if term or trunc:
            break
        observations.append(_snapshot(env.observe("player_0")))
        overlays.append(extract_overlay(env))
        env.step(action)
    env.close()
    return observations, overlays


def test_same_seed_produces_identical_observation_and_overlay_sequences():
    actions = [0, 1, 0, 0, 1, 0, 1, 1, 0, 0]
    obs_a, ov_a = _rollout(123, actions)
    obs_b, ov_b = _rollout(123, actions)
    assert len(obs_a) == len(obs_b)
    assert obs_a == obs_b
    assert json.dumps(ov_a, sort_keys=True) == json.dumps(ov_b, sort_keys=True)


def test_different_seeds_diverge():
    actions = [0] * 10
    _obs_a, ov_a = _rollout(1, actions)
    _obs_b, ov_b = _rollout(2, actions)
    # Different seeds place pipes differently, so the overlays must differ somewhere.
    assert ov_a != ov_b


def test_observation_is_flat_object_with_no_action_mask_and_nearest_first_pipes():
    # Flappy's observation is a flat Dict (no {"observation","action_mask"} wrapper — there is no
    # mask) with player/pipes/pipes_passed/width/height, and pipes are ordered nearest-first.
    env = make_env()
    env.reset(seed=7)
    observed = env.observe("player_0")

    assert set(observed) == {"player", "pipes", "pipes_passed", "width", "height"}
    assert set(observed["player"]) == {"x", "y", "vel_y", "rot"}
    for value in observed["player"].values():
        assert isinstance(value, np.float32)
    assert isinstance(observed["pipes"], tuple)
    assert observed["pipes"], "expected at least one pipe"
    for pipe in observed["pipes"]:
        assert set(pipe) == {"x", "gap_top", "gap_bottom"}
        for value in pipe.values():
            assert isinstance(value, np.float32)
    xs = [float(pipe["x"]) for pipe in observed["pipes"]]
    assert xs == sorted(xs)  # nearest-first: ascending x

    assert isinstance(observed["pipes_passed"], np.int64)
    assert isinstance(observed["width"], int)
    assert isinstance(observed["height"], int)

    # Matches the space published for the sole agent.
    space = env.observation_space("player_0")
    assert space.contains(observed)
    env.close()


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
    xs = [pipe["x"] for pipe in overlay["pipes"]]
    assert xs == sorted(xs)  # nearest-first, matching the observation order
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
    # The two-argument hook takes the live env and slot id; idle (integer 0) is always legal on a
    # live turn, so it is already the real action applied on a timeout — no sentinel resolution.
    # default_action is a module-level function in env.py and is the same callable as ENTRY.default_action.
    env = make_env()
    env.reset(seed=0)
    assert ENTRY.default_action is default_action
    assert ENTRY.default_action(env, "player_0") == 0
    assert default_action(env, "player_0") == 0
