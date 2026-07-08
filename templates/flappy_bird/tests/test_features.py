"""Tests for the provided ``sandbox.features`` helpers.

These confirm the observation is the object shape the helpers assume (a ``player`` dict, a
``pipes`` tuple ordered nearest-first, and the screen size) and that the convenience readers agree
with the raw fields they name, so an agent can rely on them.
"""

from __future__ import annotations

from sandbox.env import make_env
from sandbox.features import (
    FLAP,
    IDLE,
    next_gap_center,
    next_pipe,
    player_velocity,
    player_x,
    player_y,
    screen_height,
    screen_width,
)


def test_actions_are_distinct():
    assert {IDLE, FLAP} == {0, 1}


def test_feature_readers_match_the_raw_observation():
    env = make_env(render_mode=None)
    try:
        env.reset(seed=0)
        observation = env.observe(env.agent_selection)

        assert set(observation) == {"player", "pipes", "pipes_passed", "width", "height"}

        assert player_x(observation) == float(observation["player"]["x"])
        assert player_y(observation) == float(observation["player"]["y"])
        assert player_velocity(observation) == float(observation["player"]["vel_y"])
        assert screen_width(observation) == float(observation["width"])
        assert screen_height(observation) == float(observation["height"])

        pipes = observation["pipes"]
        if pipes:
            # pipes are ordered nearest-first (ascending x).
            assert next_pipe(observation) == pipes[0]
            top = float(pipes[0]["gap_top"])
            bottom = float(pipes[0]["gap_bottom"])
            assert min(top, bottom) <= next_gap_center(observation) <= max(top, bottom)
            assert [float(p["x"]) for p in pipes] == sorted(float(p["x"]) for p in pipes)
        else:
            assert next_pipe(observation) is None
            assert next_gap_center(observation) == screen_height(observation) / 2.0
    finally:
        env.close()


def test_next_gap_center_falls_back_to_screen_middle_without_a_pipe():
    observation = {
        "player": {"x": 0.0, "y": 0.0, "vel_y": 0.0, "rot": 0.0},
        "pipes": (),
        "pipes_passed": 0,
        "width": 288,
        "height": 512,
    }
    assert next_pipe(observation) is None
    assert next_gap_center(observation) == 256.0
