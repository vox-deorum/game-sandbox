"""Feature helpers for Flappy Bird agents: name the observation indices and the two actions.

You may import this module from your ``agent.py`` (``from sandbox import features``). It is the one
piece of ``sandbox/`` you are meant to use from your agent, and importing it stays cheap: it is
plain Python with no third-party dependencies. Import it at the top of ``agent.py``, not inside a
method.

The observation is a length-12 NumPy array of normalized numbers. The constants below name each
index so your agent can read ``observation[NEXT_PIPE_GAP_TOP]`` instead of a bare ``observation[4]``.
The three pipes are the most recently passed pipe, the next pipe the bird must clear, and the one
after that; each contributes its horizontal position and the top and bottom of its gap. The last
three features are the bird's own vertical position, its vertical velocity, and its rotation. Every
value is normalized, and y grows downward, so a larger y is lower on the screen. Positions use the
screen as their scale, but the raw velocity value is normalized by the bird's maximum fall speed
instead; ``player_velocity()`` converts it onto the position scale. The full table of indices and
scales, and everything else specific to Flappy Bird, is in ``environment.md``, shipped alongside
the template.
"""

from __future__ import annotations

from typing import Any

# The most recently passed pipe (behind the bird).
LAST_PIPE_X = 0
LAST_PIPE_GAP_TOP = 1
LAST_PIPE_GAP_BOTTOM = 2
# The next pipe, the one the bird must fly through now. Usually the useful one for a simple policy.
NEXT_PIPE_X = 3
NEXT_PIPE_GAP_TOP = 4
NEXT_PIPE_GAP_BOTTOM = 5
# The pipe after the next one.
NEXT_NEXT_PIPE_X = 6
NEXT_NEXT_PIPE_GAP_TOP = 7
NEXT_NEXT_PIPE_GAP_BOTTOM = 8
# The bird itself.
PLAYER_Y = 9
PLAYER_VELOCITY = 10
PLAYER_ROTATION = 11

#: The two actions: do nothing (fall under gravity) or flap (a small upward push).
IDLE = 0
FLAP = 1

#: How fast the pipes scroll left, in screen widths per step (4 pixels per step on the
#: 288-pixel-wide screen). Subtracting it from a pipe's X predicts where the pipe is next step.
PIPE_SPEED = 4.0 / 288.0

# Pixel quantities from the game, needed to convert velocity into screen units: the maximum
# fall speed the raw velocity is normalized by, and the screen height that normalizes PLAYER_Y.
_PLAYER_MAX_SPEED_PIXELS = 10.0
_SCREEN_HEIGHT_PIXELS = 512.0


def next_gap_center(observation: Any) -> float:
    """Return the vertical center of the next pipe's gap, the height the bird should aim for."""
    return (float(observation[NEXT_PIPE_GAP_TOP]) + float(observation[NEXT_PIPE_GAP_BOTTOM])) / 2.0


def player_y(observation: Any) -> float:
    """Return the bird's vertical position. Larger is lower on the screen, since y grows downward."""
    return float(observation[PLAYER_Y])


def player_velocity(observation: Any) -> float:
    """Return the bird's vertical velocity in screen heights per step, the same scale as
    player_y: the bird's next y is approximately player_y + player_velocity. Positive is
    downward; on an idle step gravity first adds about 0.002."""
    return float(observation[PLAYER_VELOCITY]) * _PLAYER_MAX_SPEED_PIXELS / _SCREEN_HEIGHT_PIXELS
