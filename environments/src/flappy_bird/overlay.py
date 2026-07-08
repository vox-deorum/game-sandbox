"""Render-data extraction for Flappy Bird.

The renderer never sees pixels (see the interaction spec), so the per-step overlay must
carry everything Stage 4 needs to draw the frame. The observation and the overlay are both
built from the same unnormalized screen coordinates, so this module reaches into the wrapped
game's internal state directly. Reaching into a third-party package's internals is acceptable
only here — inside the environment's own wrapper, against the pinned
``flappy-bird-gymnasium==0.4.0`` — and is covered by a test asserting every overlay field
exists and is finite, so an upgrade that breaks the internals fails before the renderer does.

This module imports only the pinned third-party package, so it is copied verbatim into the
student template's ``sandbox/env/`` by the generate script.
"""

from __future__ import annotations

from typing import Any

from flappy_bird_gymnasium.envs.constants import PIPE_HEIGHT

#: Player feature order shared by ``observe`` and ``extract_overlay``.
PLAYER_KEYS = ("x", "y", "vel_y", "rot")
#: Pipe feature order shared by ``observe`` and ``extract_overlay``.
PIPE_KEYS = ("x", "gap_top", "gap_bottom")


def _read_state(
    game: Any,
) -> tuple[dict[str, float], list[tuple[float, float, float]], int, int, int]:
    """Read the wrapped game's unnormalized internal state, nearest-pipe-first.

    Returns ``(player, pipes, pipes_passed, width, height)`` where ``player`` maps
    :data:`PLAYER_KEYS` to plain floats and ``pipes`` is a list of ``(x, gap_top, gap_bottom)``
    tuples sorted by ascending ``x`` (nearest to the player first). Both :func:`extract_overlay`
    and ``FlappyBirdEnv.observe`` read this single helper so the two never disagree on order or
    values.
    """
    player = {
        "x": float(game._player_x),
        "y": float(game._player_y),
        "vel_y": float(game._player_vel_y),
        "rot": float(game._player_rot),
    }

    pipes = [
        (float(upper["x"]), float(upper["y"] + PIPE_HEIGHT), float(lower["y"]))
        for upper, lower in zip(game._upper_pipes, game._lower_pipes, strict=True)
    ]
    pipes.sort(key=lambda pipe: pipe[0])

    return player, pipes, int(game._score), int(game._screen_width), int(game._screen_height)


def extract_overlay(env: Any) -> dict[str, Any]:
    """Return the per-step overlay dict from a live wrapped Flappy Bird env.

    ``env`` is the :class:`GymnasiumToAEC` wrapper; its ``gym_env.unwrapped`` is the raw
    ``FlappyBirdEnv`` whose internal state we read. Coordinates are unnormalized screen
    pixels: pipe ``x`` is the left edge, ``gap_top``/``gap_bottom`` are the y of the gap's
    upper and lower edges. Pipes are ordered nearest-first (ascending ``x``), matching the
    observation.
    """
    game = env.gym_env.unwrapped
    player, pipes, pipes_passed, width, height = _read_state(game)

    return {
        "player": player,
        "pipes": [dict(zip(PIPE_KEYS, pipe, strict=True)) for pipe in pipes],
        "pipes_passed": pipes_passed,
        "width": width,
        "height": height,
    }
