"""Tests for the provided ``sandbox.features`` helpers.

These confirm the observation is the length-12 array the helpers assume and that the two
convenience readers agree with the raw indices they name, so an agent can rely on them.
"""

from __future__ import annotations

import pytest
from sandbox.env import make_env
from sandbox.features import (
    FLAP,
    IDLE,
    NEXT_PIPE_GAP_BOTTOM,
    NEXT_PIPE_GAP_TOP,
    PIPE_SPEED,
    PLAYER_VELOCITY,
    PLAYER_Y,
    next_gap_center,
    player_velocity,
    player_y,
)


def test_actions_are_distinct():
    assert {IDLE, FLAP} == {0, 1}


def test_feature_readers_match_the_raw_observation():
    env = make_env(render_mode=None)
    try:
        env.reset(seed=0)
        observation = env.observe(env.agent_selection)

        assert len(observation) == 12

        # The gap center sits between the two gap edges the helper reads.
        top = float(observation[NEXT_PIPE_GAP_TOP])
        bottom = float(observation[NEXT_PIPE_GAP_BOTTOM])
        assert min(top, bottom) <= next_gap_center(observation) <= max(top, bottom)

        assert player_y(observation) == float(observation[PLAYER_Y])

        # player_velocity converts the raw value (normalized by the 10-pixel maximum fall
        # speed) into screen heights per step (the 512-pixel screen height).
        expected = float(observation[PLAYER_VELOCITY]) * 10 / 512
        assert player_velocity(observation) == pytest.approx(expected)
    finally:
        env.close()


def test_pipe_speed_is_screen_widths_per_step():
    # The pipes scroll 4 pixels per step across the 288-pixel-wide screen.
    assert pytest.approx(4 / 288) == PIPE_SPEED
