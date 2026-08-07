"""Static types for the Flappy Bird observation.

TypedDicts mirroring the runtime shape ``FlappyBirdEnv.observe`` returns and the ``OBS_SPACE``
declared in ``env.py``: FlappyPlayer and FlappyPipe match the nested "player" and "pipes" dicts,
and FlappyObservation matches the whole object. Stdlib-only at runtime (numpy is imported only
for type checking), so sandbox.features may import it without dragging in numpy. Ships into the
student template as sandbox.observation_types, and also travels alongside env.py into the
composed sandbox's env/flappy_bird/ package so the environment code can import it directly.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    import numpy as np
    from numpy.typing import NDArray


class FlappyPlayer(TypedDict):
    """The bird's kinematic state, in real screen pixels; y grows downward."""

    x: NDArray[np.float32]  # 0-d array, the bird sprite's left edge
    y: NDArray[np.float32]  # 0-d array, the bird sprite's top edge
    vel_y: NDArray[np.float32]  # 0-d array, vertical velocity in pixels per step
    rot: NDArray[np.float32]  # 0-d array, visual tilt in degrees


class FlappyPipe(TypedDict):
    """One pipe still ahead of the bird, in real screen pixels."""

    x: NDArray[np.float32]  # 0-d array, the pipe's left edge
    gap_top: NDArray[np.float32]  # 0-d array, the y of the gap's upper edge
    gap_bottom: NDArray[np.float32]  # 0-d array, the y of the gap's lower edge


class FlappyObservation(TypedDict):
    """The full dict a Flappy Bird agent's act() receives. No action_mask: both actions are
    always legal."""

    player: FlappyPlayer
    pipes: tuple[FlappyPipe, ...]  # nearest-first (ascending x); may be empty
    pipes_passed: NDArray[np.int64]  # 0-d array, pipes cleared so far
    width: int
    height: int
