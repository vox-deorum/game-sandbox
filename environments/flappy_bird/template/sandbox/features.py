"""Feature helpers for Flappy Bird agents: name the observation fields and the two actions.

You may import this module from your ``agent.py`` (``from sandbox import features``). It is the one
piece of ``sandbox/`` you are meant to use from your agent, and importing it stays cheap: it is
plain Python with no third-party dependencies. Import it at the top of ``agent.py``, not inside a
method.

The observation is an object: a ``player`` dict, a ``pipes`` tuple, a pipe count, and the screen
size. ``player`` has ``x``, ``y``, ``vel_y``, and ``rot``. ``pipes`` holds one entry per pipe still
ahead of the bird, each with ``x``, ``gap_top``, and ``gap_bottom``, ordered nearest-first (ascending
``x``); it may be empty. Every value is a real screen pixel, not a normalized number, and ``vel_y``
is already in pixels per step. ``y`` grows downward, so a larger ``y`` is lower on the screen. The
full shape, and everything else specific to Flappy Bird, is in ``environment.md``, shipped alongside
the template. The observation's shape is also available as the FlappyObservation type, importable
from this module, for editors and type checkers.
"""

from __future__ import annotations

from sandbox.observation_types import FlappyObservation, FlappyPipe

__all__ = [
    "FLAP",
    "FlappyObservation",
    "IDLE",
    "next_gap_center",
    "next_pipe",
    "player_velocity",
    "player_x",
    "player_y",
    "screen_height",
    "screen_width",
]

#: The two actions: do nothing (fall under gravity) or flap (a small upward push).
IDLE = 0
FLAP = 1


def player_x(observation: FlappyObservation) -> float:
    """Return the bird's horizontal position in screen pixels."""
    return float(observation["player"]["x"])


def player_y(observation: FlappyObservation) -> float:
    """Return the bird's vertical position in screen pixels. Larger is lower on the screen,
    since y grows downward."""
    return float(observation["player"]["y"])


def player_velocity(observation: FlappyObservation) -> float:
    """Return the bird's vertical velocity in pixels per step. Positive is downward; the
    bird's next y is approximately player_y + player_velocity."""
    return float(observation["player"]["vel_y"])


def next_pipe(observation: FlappyObservation) -> FlappyPipe | None:
    """Return the nearest pipe ahead of the bird (with x, gap_top, gap_bottom), or None if
    there currently isn't one."""
    pipes = observation["pipes"]
    return pipes[0] if pipes else None


def next_gap_center(observation: FlappyObservation) -> float:
    """Return the vertical center of the next pipe's gap, the height the bird should aim for.
    If there is no next pipe, fall back to the vertical middle of the screen."""
    pipe = next_pipe(observation)
    if pipe is None:
        return screen_height(observation) / 2.0
    return (float(pipe["gap_top"]) + float(pipe["gap_bottom"])) / 2.0


def screen_height(observation: FlappyObservation) -> float:
    """Return the screen height in pixels."""
    return float(observation["height"])


def screen_width(observation: FlappyObservation) -> float:
    """Return the screen width in pixels."""
    return float(observation["width"])
