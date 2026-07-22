"""Render-data extraction for Flappy Bird.

The browser renderer never sees pixels (see the interaction spec), so the per-step overlay
carries everything it needs to draw the frame. The observation and overlay are both built from
the public immutable snapshot published by the local simulation core.
"""

from __future__ import annotations

from typing import Any

#: Player feature order shared by ``observe`` and ``extract_overlay``.
PLAYER_KEYS = ("x", "y", "vel_y", "rot")
#: Pipe feature order shared by ``observe`` and ``extract_overlay``.
PIPE_KEYS = ("x", "gap_top", "gap_bottom")


def extract_overlay(env: Any) -> dict[str, Any]:
    """Return the per-step overlay dict from a live wrapped Flappy Bird env.

    ``env`` is the :class:`GymnasiumToAEC` wrapper; its ``gym_env.unwrapped`` is the raw
    ``FlappyBirdEnv`` whose internal state we read. Coordinates are unnormalized screen
    pixels: pipe ``x`` is the left edge, ``gap_top``/``gap_bottom`` are the y of the gap's
    upper and lower edges. Pipes are ordered nearest-first (ascending ``x``), matching the
    observation.
    """
    state = env.gym_env.state

    return {
        "player": {key: getattr(state.player, key) for key in PLAYER_KEYS},
        "pipes": [{key: getattr(pipe, key) for key in PIPE_KEYS} for pipe in state.pipes],
        "pipes_passed": state.score,
        "width": state.width,
        "height": state.height,
    }
