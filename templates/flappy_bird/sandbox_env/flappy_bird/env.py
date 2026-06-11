"""The Flappy Bird environment factory.

Wraps ``flappy-bird-gymnasium``'s ``FlappyBird-v0`` (the 12-feature numerical observation,
``use_lidar=False``) in the general-purpose :class:`GymnasiumToAEC` adapter, so the harness
sees a one-slot PettingZoo env. The agent sees exactly the features it will see locally
against the template, and the action space is ``Discrete(2)`` (0 = idle, 1 = flap).

This module imports only third-party packages and the sibling adapter via a relative import,
so it is copied verbatim into the student template's ``sandbox_env/`` by the generate script.
"""

from __future__ import annotations

# Importing the package registers the ``FlappyBird-v0`` id with Gymnasium.
import flappy_bird_gymnasium  # noqa: F401
import gymnasium

from ..single_agent import GymnasiumToAEC

#: The action every Flappy Bird timeout path falls back to (idle / do nothing).
NOOP_ACTION = 0


def make_env(render_mode: str | None = None) -> GymnasiumToAEC:
    """Create a fresh Flappy Bird AEC environment. The seed arrives at ``reset``."""
    gym_env = gymnasium.make(
        "FlappyBird-v0",
        use_lidar=False,
        normalize_obs=True,
        render_mode=render_mode,
    )
    return GymnasiumToAEC(gym_env, name="flappy_bird_v0")
