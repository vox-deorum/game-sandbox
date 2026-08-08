"""Environment-level tests for Flappy Bird: API conformance, seeded determinism, the overlay
extractor, and metadata serialization.

The determinism test runs at the environment level — two resets with the same seed under the
same scripted action list must produce identical observation and overlay sequences — so an
environment-level seeding gap is caught here, at the wrapper, before the harness-level
recording determinism test ever runs and might misattribute it.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from flappy_bird import ENTRY
from flappy_bird.env import FlappyBirdEnv, default_action, make_env
from flappy_bird.game import PIPE_WIDTH, FlappyBirdGame
from flappy_bird.observation_types import FlappyObservation, FlappyPipe, FlappyPlayer
from flappy_bird.overlay import extract_overlay


@pytest.mark.parametrize(
    "parameters",
    [
        {},
        {"players": True, "pipe_gap": 100},
        {"players": 2, "pipe_gap": 100},
        {"players": 1},
        {"players": 1, "pipe_gap": True},
        {"players": 1, "pipe_gap": "100"},
        {"players": 1, "pipe_gap": 100.0},
        {"players": 1, "pipe_gap": 2**53},
    ],
)
def test_factory_rejects_invalid_integer_parameters(parameters):
    with pytest.raises(ValueError):
        make_env(parameters)


def test_factory_rejects_invalid_parameters_under_optimized_python():
    script = """
from flappy_bird.env import make_env

for parameters in ({"players": 2, "pipe_gap": 100}, {"players": 1, "pipe_gap": True}):
    try:
        make_env(parameters)
    except ValueError:
        pass
    else:
        raise SystemExit(f"Flappy Bird factory accepted invalid parameters: {parameters!r}")
"""
    subprocess.run([sys.executable, "-O", "-c", script], check=True)


def _is_scalar_array(value: object, dtype: type) -> bool:
    """A 0-d NumPy array of exactly ``dtype`` — the member a ``shape=()`` Box publishes, so
    ``Space.contains`` accepts each leaf without casting a bare scalar (which api_test warns on)."""
    return isinstance(value, np.ndarray) and value.shape == () and value.dtype == dtype


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


def _golden_snapshot(observed: dict) -> dict:
    """Return the JSON shape committed from the upstream 0.4.0 wrapper."""
    return {
        "player": {key: float(value) for key, value in observed["player"].items()},
        "pipes": [{key: float(value) for key, value in pipe.items()} for pipe in observed["pipes"]],
        "pipes_passed": int(observed["pipes_passed"]),
        "width": int(observed["width"]),
        "height": int(observed["height"]),
    }


def _agent_visible_pipes(observation: dict) -> list[dict]:
    """Return the pipes that remain relevant to the agent from an upstream raw snapshot."""
    player_x = observation["player"]["x"]
    return [pipe for pipe in observation["pipes"] if pipe["x"] + PIPE_WIDTH > player_x]


def test_local_core_reproduces_upstream_golden_traces():
    fixture_path = Path(__file__).parent / "fixtures" / "flappy_bird_golden_traces.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    assert fixture["upstream"] == "flappy-bird-gymnasium 0.4.0"

    for name, trace in fixture["traces"].items():
        env = FlappyBirdEnv(FlappyBirdGame(score_limit=trace["score_limit"]))
        env.reset(seed=trace["seed"])
        recycled = False
        previous_xs: list[float] | None = None
        for frame in trace["frames"]:
            observed, reward, terminated, truncated, info = env.last()
            overlay = extract_overlay(env)
            expected_observation = dict(frame["observation"])
            expected_observation["pipes"] = _agent_visible_pipes(expected_observation)
            assert _golden_snapshot(env.observe("player_0")) == expected_observation, (name, frame["tick"])
            assert overlay == frame["overlay"], (name, frame["tick"])
            assert float(reward) == frame["reward"], (name, frame["tick"])
            assert bool(terminated) is frame["terminated"], (name, frame["tick"])
            assert bool(truncated) is frame["truncated"], (name, frame["tick"])
            assert int(info["score"]) == frame["score"], (name, frame["tick"])
            xs = [pipe["x"] for pipe in overlay["pipes"]]
            if previous_xs and any(x > prior for x, prior in zip(xs, previous_xs, strict=True)):
                recycled = True
            previous_xs = xs
            if frame["action"] is not None:
                env.step(frame["action"])
        if name == "scoring_recycle_pipe_crash":
            assert recycled
        env.close()


def test_aabb_collision_matches_pygame_edge_behavior():
    # Pygame Rect.colliderect treats a shared edge as non-overlapping, but a one-pixel overlap as
    # a collision. The local numeric helper deliberately preserves those boundaries.
    rect = {"x": 34.0, "y": 20.0}
    assert not FlappyBirdGame._aabb_overlaps(0, 34, 20, 44, rect)
    assert FlappyBirdGame._aabb_overlaps(0, 35, 20, 44, rect)
    assert not FlappyBirdGame._aabb_overlaps(52, 86, 20, 44, {"x": 0.0, "y": 20.0})
    vertical_rect = {"x": 0.0, "y": 20.0}
    assert not FlappyBirdGame._aabb_overlaps(0, 34, -300, 20, vertical_rect)
    assert FlappyBirdGame._aabb_overlaps(0, 34, -299, 21, vertical_rect)


def _rollout(seed: int, actions: list[int]) -> tuple[list, list]:
    env = make_env({"players": 1, "pipe_gap": 100})
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


def test_different_seeds_diverge():
    actions = [0] * 10
    _obs_a, ov_a = _rollout(1, actions)
    _obs_b, ov_b = _rollout(2, actions)
    # Different seeds place pipes differently, so the overlays must differ somewhere.
    assert ov_a != ov_b


def test_observation_is_flat_object_with_no_action_mask_and_nearest_first_pipes():
    # Flappy's observation is a flat Dict (no {"observation","action_mask"} wrapper — there is no
    # mask) with player/pipes/pipes_passed/width/height, and pipes are ordered nearest-first.
    env = make_env({"players": 1, "pipe_gap": 100})
    env.reset(seed=7)
    observed = env.observe("player_0")

    assert set(observed) == {"player", "pipes", "pipes_passed", "width", "height"}
    assert set(observed["player"]) == {"x", "y", "vel_y", "rot"}
    # Drift guard: the runtime dict keys must match the FlappyObservation TypedDicts exactly.
    assert set(observed) == set(FlappyObservation.__annotations__)
    assert set(observed["player"]) == set(FlappyPlayer.__annotations__)
    # Continuous leaves are the 0-d float32 arrays their shape=() Box spaces publish (not bare
    # np.float32 scalars), so Space.contains accepts them without a per-leaf cast warning.
    for value in observed["player"].values():
        assert _is_scalar_array(value, np.float32)
    assert isinstance(observed["pipes"], tuple)
    assert observed["pipes"], "expected at least one pipe"
    for pipe in observed["pipes"]:
        assert set(pipe) == {"x", "gap_top", "gap_bottom"}
        assert set(pipe) == set(FlappyPipe.__annotations__)
        for value in pipe.values():
            assert _is_scalar_array(value, np.float32)
    xs = [float(pipe["x"]) for pipe in observed["pipes"]]
    assert xs == sorted(xs)  # nearest-first: ascending x

    assert _is_scalar_array(observed["pipes_passed"], np.int64)
    assert isinstance(observed["width"], int)
    assert isinstance(observed["height"], int)

    # Matches the space published for the sole agent.
    space = env.observation_space("player_0")
    assert space.contains(observed)
    env.close()


def test_observation_omits_only_pipes_fully_behind_the_bird():
    env = make_env({"players": 1, "pipe_gap": 100})
    env.reset(seed=7)
    game = env.gym_env
    game._player_x = 57
    game._upper_pipes = [
        {"x": 5.0, "y": -200.0},  # Its right edge is at 57, touching the bird's left edge.
        {"x": 6.0, "y": -200.0},  # It overlaps the bird by one pixel and remains relevant.
        {"x": 120.0, "y": -200.0},
    ]
    game._lower_pipes = [
        {"x": 5.0, "y": 200.0},
        {"x": 6.0, "y": 200.0},
        {"x": 120.0, "y": 200.0},
    ]

    observed = env.observe("player_0")
    overlay = extract_overlay(env)

    assert [float(pipe["x"]) for pipe in observed["pipes"]] == [6.0, 120.0]
    assert [pipe["x"] for pipe in overlay["pipes"]] == [5.0, 6.0, 120.0]
    env.close()


def test_default_action_is_noop():
    # The two-argument hook takes the live env and player id; idle (integer 0) is always legal on a
    # live turn, so it is already the real action applied on a timeout — no sentinel resolution.
    # default_action is a module-level function in env.py and is the same callable as ENTRY.default_action.
    env = make_env({"players": 1, "pipe_gap": 100})
    env.reset(seed=0)
    assert ENTRY.default_action is default_action
    assert ENTRY.default_action(env, "player_0") == 0
    assert default_action(env, "player_0") == 0


@pytest.mark.parametrize(("action", "expected_velocity"), [(0, -8.0), (1, -9.0)])
def test_step_accepts_each_discrete_action(action, expected_velocity):
    env = make_env({"players": 1, "pipe_gap": 100})
    env.reset(seed=0)

    env.step(action)

    assert env.gym_env.state.player.vel_y == expected_velocity
    env.close()


@pytest.mark.parametrize("action", [-1, 2, "flap"])
def test_step_rejects_actions_outside_its_discrete_space(action):
    env = make_env({"players": 1, "pipe_gap": 100})
    env.reset(seed=0)
    before = _snapshot(env.observe("player_0"))

    with pytest.raises(ValueError, match="outside its action space"):
        env.step(action)

    assert _snapshot(env.observe("player_0")) == before
    env.close()


def test_factory_uses_the_resolved_pipe_gap():
    env = make_env({"players": 1, "pipe_gap": 90})
    try:
        assert env.gym_env._pipe_gap == 90
    finally:
        env.close()
