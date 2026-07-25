"""The Flappy Bird environment factory.

Wraps the local pygame-free simulation in the general-purpose
:class:`GymnasiumToAEC` adapter, so the harness sees a one-slot PettingZoo env. The gym env
itself still produces the library's normalized 12-feature vector internally (unused by us),
but the AEC-facing observation this module exposes is the OBJECT form the semantic contract
requires: the same unnormalized screen-pixel values the browser overlay reads, structured as
a player dict, an ordered tuple of pipe dicts (nearest-first), a pipes-passed counter, and the
screen dimensions. The action space is ``Discrete(2)`` (0 = idle, 1 = flap).

This module imports only third-party packages and sibling modules via relative imports, so it
is copied verbatim into the composed student template's ``sandbox/env/`` by ``scripts/compose.py``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, cast

from game_sandbox_harness.environment import int_parameter

if TYPE_CHECKING:
    from game_sandbox_harness.environment import ParameterValue

import numpy as np
from gymnasium import spaces

from .game import FlappyBirdGame
from .overlay import PIPE_KEYS, PLAYER_KEYS
from .single_agent import DEFAULT_AGENT_ID, GymnasiumToAEC

#: The player observation sub-space: four unnormalized float32 scalars.
_PLAYER_SPACE = spaces.Dict({k: spaces.Box(-np.inf, np.inf, shape=(), dtype=np.float32) for k in PLAYER_KEYS})
#: A single pipe's observation sub-space: three unnormalized float32 scalars.
_PIPE_SPACE = spaces.Dict({k: spaces.Box(-np.inf, np.inf, shape=(), dtype=np.float32) for k in PIPE_KEYS})
#: The flat object observation space (no ``{"observation","action_mask"}`` wrapper — Flappy has
#: no action mask).
OBS_SPACE = spaces.Dict(
    {
        "player": _PLAYER_SPACE,
        "pipes": spaces.Sequence(_PIPE_SPACE),
        "pipes_passed": spaces.Box(0, np.iinfo(np.int64).max, shape=(), dtype=np.int64),
        "width": spaces.Discrete(4096),
        "height": spaces.Discrete(4096),
    }
)


def make_env(parameters: Mapping[str, ParameterValue]) -> FlappyBirdEnv:
    """Create a fresh Flappy Bird AEC environment. The seed arrives at ``reset``."""
    pipe_gap = int_parameter(parameters, "pipe_gap")
    return FlappyBirdEnv(FlappyBirdGame(normalize_obs=True, pipe_gap=pipe_gap), name="flappy_bird_v0")


class FlappyBirdEnv(GymnasiumToAEC):
    """Flappy Bird's AEC wrapper, exposing the semantic object observation.

    The base :class:`GymnasiumToAEC` forwards the wrapped gym env's own observation space and
    ``observe`` (the raw 12-float vector). This subclass replaces both with the object contract:
    the observation space becomes :data:`OBS_SPACE`, and ``observe`` reads the same
    unnormalized state the browser overlay reads
    so agents see real screen pixels, not a normalized vector.
    """

    def __init__(
        self,
        gym_env: FlappyBirdGame,
        *,
        name: str = "flappy_bird_v0",
        agent_id: str = DEFAULT_AGENT_ID,
    ) -> None:
        super().__init__(gym_env, name=name, agent_id=agent_id)

        # Replace the inherited observation-space mapping so every accessor shares one truth: the flat
        # object Dict space here. The base class already sets action_spaces to the gym env's own
        # Discrete(2), which is correct as-is, so it is left untouched.
        self.observation_spaces = {self._agent_id: OBS_SPACE}

    def observe(self, agent: str) -> Any:
        game = cast("FlappyBirdGame", self.gym_env)
        state = game.state

        # Each continuous leaf is a 0-d array, not a bare np.float32/np.int64 scalar, so it is the
        # exact member type its shape=() Box publishes. gymnasium's Space.contains casts any
        # non-ndarray and warns while doing so, so a scalar leaf here makes PettingZoo's api_test
        # emit that cast warning on every leaf of every step. width/height stay plain ints for their
        # Discrete spaces, which accept Python ints without casting.
        return {
            "player": {k: np.array(getattr(state.player, k), dtype=np.float32) for k in PLAYER_KEYS},
            "pipes": tuple(
                {key: np.array(getattr(pipe, key), dtype=np.float32) for key in PIPE_KEYS}
                for pipe in state.pipes
            ),
            "pipes_passed": np.array(state.score, dtype=np.int64),
            "width": state.width,
            "height": state.height,
        }


def default_action(env: Any, player_id: str) -> int:
    """The legal default on every timeout path: do nothing (idle).

    Idle (integer ``0``) is always legal, so it is already a real ``Discrete(2)`` action; the
    env and player id are accepted only for the uniform two-argument hook.
    """
    return 0
