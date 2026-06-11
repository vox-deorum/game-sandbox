"""Render-data extraction for Flappy Bird.

The renderer never sees pixels (see the interaction spec), so the per-step overlay must
carry everything Stage 4 needs to draw the frame. The normalized 12-feature observation is
not enough to reconstruct a frame, so this module reaches into the wrapped game's internal
state to read unnormalized screen coordinates. Reaching into a third-party package's
internals is acceptable only here — inside the environment's own wrapper, against the pinned
``flappy-bird-gymnasium==0.4.0`` — and is covered by a test asserting every overlay field
exists and is finite, so an upgrade that breaks the internals fails before the renderer does.

This module imports only the pinned third-party package, so it is copied verbatim into the
student template's ``sandbox_env/`` by the generate script.
"""

from __future__ import annotations

from typing import Any

from flappy_bird_gymnasium.envs.constants import PIPE_HEIGHT


def extract_overlay(env: Any) -> dict[str, Any]:
    """Return the per-step overlay dict from a live wrapped Flappy Bird env.

    ``env`` is the :class:`GymnasiumToAEC` wrapper; its ``gym_env.unwrapped`` is the raw
    ``FlappyBirdEnv`` whose internal state we read. Coordinates are unnormalized screen
    pixels: pipe ``x`` is the left edge, ``gap_top``/``gap_bottom`` are the y of the gap's
    upper and lower edges.
    """
    game = env.gym_env.unwrapped

    pipes: list[dict[str, float]] = []
    for upper, lower in zip(game._upper_pipes, game._lower_pipes, strict=True):
        pipes.append(
            {
                "x": float(upper["x"]),
                "gap_top": float(upper["y"] + PIPE_HEIGHT),
                "gap_bottom": float(lower["y"]),
            }
        )

    return {
        "player": {
            "x": float(game._player_x),
            "y": float(game._player_y),
            "vel_y": float(game._player_vel_y),
            "rot": float(game._player_rot),
        },
        "pipes": pipes,
        "pipes_passed": int(game._score),
        "width": int(game._screen_width),
        "height": int(game._screen_height),
    }
