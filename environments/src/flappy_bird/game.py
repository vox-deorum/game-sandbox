# Copyright (c) 2020 Gabriel Nogueira (Talendar)
# Copyright (c) 2023 Martin Kubovcik
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""Pygame-free Flappy Bird simulation adapted from upstream version 0.4.0.

Source: https://github.com/markub3327/flappy-bird-gymnasium. This module adapts
only its non-rendering simulation logic. See ``UPSTREAM_LICENSE.md`` for the
complete MIT notice and upstream acknowledgements.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum
from typing import Any

import gymnasium
import numpy as np

PIPE_VEL_X = -4
PLAYER_MAX_VEL_Y = 10
PLAYER_ACC_Y = 1
PLAYER_VEL_ROT = 3
PLAYER_FLAP_ACC = -9
PLAYER_WIDTH = 34
PLAYER_HEIGHT = 24
PIPE_WIDTH = 52
PIPE_HEIGHT = 320
BASE_WIDTH = 336
BACKGROUND_WIDTH = 288


class Actions(IntEnum):
    """The two actions accepted by the simulation."""

    IDLE, FLAP = 0, 1


@dataclass(frozen=True)
class PlayerState:
    """The bird's public screen-coordinate state."""

    x: float
    y: float
    vel_y: float
    rot: float


@dataclass(frozen=True)
class PipeState:
    """One pipe gap represented by its left edge and bounds."""

    x: float
    gap_top: float
    gap_bottom: float


@dataclass(frozen=True)
class FlappyBirdState:
    """Immutable state shared by observations and overlays."""

    player: PlayerState
    pipes: tuple[PipeState, ...]
    score: int
    width: int
    height: int


class FlappyBirdGame(gymnasium.Env):
    """The upstream 0.4.0 dynamics without rendering or asset dependencies."""

    metadata: dict[str, object] = {}

    def __init__(
        self,
        screen_size: tuple[int, int] = (288, 512),
        normalize_obs: bool = True,
        pipe_gap: int = 100,
        score_limit: int | None = None,
    ) -> None:
        self.action_space = gymnasium.spaces.Discrete(2)
        self.observation_space = gymnasium.spaces.Box(
            -1.0 if normalize_obs else -np.inf,
            1.0 if normalize_obs else np.inf,
            shape=(12,),
            dtype=np.float64,
        )
        self._screen_width, self._screen_height = screen_size
        self._normalize_obs = normalize_obs
        self._pipe_gap = pipe_gap
        self._score_limit = score_limit
        self._ground_y = self._screen_height * 0.79
        self._base_shift = BASE_WIDTH - BACKGROUND_WIDTH
        self._upper_pipes: list[dict[str, float]] = []
        self._lower_pipes: list[dict[str, float]] = []

    @property
    def state(self) -> FlappyBirdState:
        """Return the current semantic state without leaking mutable storage."""
        pipes = tuple(
            sorted(
                (
                    PipeState(
                        float(upper["x"]),
                        float(upper["y"] + PIPE_HEIGHT),
                        float(lower["y"]),
                    )
                    for upper, lower in zip(self._upper_pipes, self._lower_pipes, strict=True)
                ),
                key=lambda pipe: pipe.x,
            )
        )
        return FlappyBirdState(
            PlayerState(
                float(self._player_x),
                float(self._player_y),
                float(self._player_vel_y),
                float(self._player_rot),
            ),
            pipes,
            int(self._score),
            self._screen_width,
            self._screen_height,
        )

    def reset(self, *, seed: int | None = None, options: dict[str, Any] | None = None):
        super().reset(seed=seed)
        self._player_x = int(self._screen_width * 0.2)
        self._player_y = int((self._screen_height - PLAYER_HEIGHT) / 2)
        self._player_vel_y = -9
        self._player_rot = 45
        self._player_flapped = False
        self._loop_iter = 0
        self._score = 0
        self._ground_x = 0
        new_pipes = [self._get_random_pipe() for _ in range(3)]
        self._upper_pipes = [
            {"x": self._screen_width + index * (self._screen_width / 2), "y": pipe[0]["y"]}
            for index, pipe in enumerate(new_pipes)
        ]
        self._lower_pipes = [
            {"x": self._screen_width + index * (self._screen_width / 2), "y": pipe[1]["y"]}
            for index, pipe in enumerate(new_pipes)
        ]
        return self._get_observation(), {"score": self._score}

    def step(self, action: Actions | int):
        reward: float | None = None
        if action == Actions.FLAP and self._player_y > -2 * PLAYER_HEIGHT:
            self._player_vel_y = PLAYER_FLAP_ACC
            self._player_flapped = True
        player_mid_pos = self._player_x + PLAYER_WIDTH / 2
        for pipe in self._upper_pipes:
            pipe_mid_pos = pipe["x"] + PIPE_WIDTH / 2
            if pipe_mid_pos <= player_mid_pos < pipe_mid_pos + 4:
                self._score += 1
                reward = 1.0
        self._loop_iter = (self._loop_iter + 1) % 30
        self._ground_x = -((-self._ground_x + 100) % self._base_shift)
        if self._player_rot > -90:
            self._player_rot -= PLAYER_VEL_ROT
        if self._player_vel_y < PLAYER_MAX_VEL_Y and not self._player_flapped:
            self._player_vel_y += PLAYER_ACC_Y
        if self._player_flapped:
            self._player_flapped = False
            self._player_rot = 45
        self._player_y += min(
            self._player_vel_y,
            self._ground_y - self._player_y - PLAYER_HEIGHT,
        )
        for upper, lower in zip(self._upper_pipes, self._lower_pipes, strict=True):
            upper["x"] += PIPE_VEL_X
            lower["x"] += PIPE_VEL_X
            if upper["x"] < -PIPE_WIDTH:
                new_upper, new_lower = self._get_random_pipe()
                upper.update(new_upper)
                lower.update(new_lower)
        observation = self._get_observation()
        if reward is None:
            reward = 0.1
        if self._player_y < 0:
            reward = -0.5
        terminated = self._check_crash()
        if terminated:
            reward = -1.0
            self._player_vel_y = 0
        return (
            observation,
            reward,
            terminated,
            self._score_limit is not None and self._score >= self._score_limit,
            {"score": self._score},
        )

    def _get_random_pipe(self) -> tuple[dict[str, float], dict[str, float]]:
        gap_y = [20, 30, 40, 50, 60, 70, 80, 90][self.np_random.integers(0, 8)]
        gap_y += int(self._ground_y * 0.2)
        pipe_x = self._screen_width + PIPE_WIDTH + (self._screen_width * 0.2)
        return ({"x": pipe_x, "y": gap_y - PIPE_HEIGHT}, {"x": pipe_x, "y": gap_y + self._pipe_gap})

    def _check_crash(self) -> bool:
        if self._player_y + PLAYER_HEIGHT >= self._ground_y - 1:
            return True
        left, top = self._player_x, self._player_y
        for upper, lower in zip(self._upper_pipes, self._lower_pipes, strict=True):
            if self._aabb_overlaps(left, left + PLAYER_WIDTH, top, top + PLAYER_HEIGHT, upper):
                return True
            if self._aabb_overlaps(left, left + PLAYER_WIDTH, top, top + PLAYER_HEIGHT, lower):
                return True
        return False

    @staticmethod
    def _aabb_overlaps(left: float, right: float, top: float, bottom: float, rect: dict[str, float]) -> bool:
        return (
            left < rect["x"] + PIPE_WIDTH
            and right > rect["x"]
            and top < rect["y"] + PIPE_HEIGHT
            and bottom > rect["y"]
        )

    def _get_observation(self) -> np.ndarray:
        pipes = []
        for upper, lower in zip(self._upper_pipes, self._lower_pipes, strict=True):
            pipes.append(
                (self._screen_width, 0, self._screen_height)
                if lower["x"] > self._screen_width
                else (lower["x"], upper["y"] + PIPE_HEIGHT, lower["y"])
            )
        pipes.sort(key=lambda pipe: pipe[0])
        pos_y, vel_y, rot = self._player_y, self._player_vel_y, self._player_rot
        if self._normalize_obs:
            pipes = [
                (x / self._screen_width, top / self._screen_height, bottom / self._screen_height)
                for x, top, bottom in pipes
            ]
            pos_y /= self._screen_height
            vel_y /= PLAYER_MAX_VEL_Y
            rot /= 90
        return np.array([*pipes[0], *pipes[1], *pipes[2], pos_y, vel_y, rot])
