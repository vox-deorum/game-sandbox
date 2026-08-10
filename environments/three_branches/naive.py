"""A simple deterministic walking baseline for Days at Three Branches."""

from __future__ import annotations

import random
from typing import Any

_WALK_SPEED = 0.6
_INITIAL_STRAIGHT_TICKS = 14
_MIN_LEG_TICKS = 18
_MAX_LEG_TICKS = 48


class Agent:
    """Walk in seeded random directions without using props, emotes, or chat."""

    def reset(self, seed: int, observation: Any) -> None:
        """Prepare a reproducible walk that begins along the home's doorway axis."""
        self._rng = random.Random(f"{seed}:{observation['self']['id']}")
        self._heading = float(observation["self"]["heading"])
        self._next_turn_tick = int(observation["tick"]) + _INITIAL_STRAIGHT_TICKS
        self._last_commanded_speed = 0.0
        self._stalled_ticks = 0

    def act(self, observation: Any) -> dict[str, float | int]:
        """Walk straight at first, then take random legs and turn away from walls."""
        own = observation["self"]
        current_heading = float(own["heading"])
        tick = int(observation["tick"])
        if self._last_commanded_speed > 0.0 and float(own["moved"]) == 0.0:
            self._stalled_ticks += 1
        else:
            self._stalled_ticks = 0

        if self._stalled_ticks >= 2:
            self._heading = (current_heading + self._rng.choice((-135.0, -90.0, 90.0, 135.0, 180.0))) % 360.0
            self._next_turn_tick = tick + self._leg_ticks()
            self._stalled_ticks = 0
        elif tick >= self._next_turn_tick:
            self._heading = float(self._rng.randrange(360))
            self._next_turn_tick = tick + self._leg_ticks()

        self._last_commanded_speed = _WALK_SPEED
        return {"heading": self._heading, "speed": _WALK_SPEED, "action": 0}

    def _leg_ticks(self) -> int:
        return self._rng.randint(_MIN_LEG_TICKS, _MAX_LEG_TICKS)
