"""Keyboard control for playing Flappy Bird by hand.

Flappy Bird is realtime (the env declares a ``pace_interval_ms``), so a human plays it by
holding or tapping a key while the loop advances at a fixed cadence: this controller samples
the current key state once per tick and returns flap or idle — it never blocks. ``space`` or
``up`` flaps; anything else falls. Closing the window sets :attr:`quit`, which the play loop
checks to stop.

The local play loops (the project's ``scripts/play.py`` and the student template's
``sandbox`` CLI) discover this by the uniform ``make_human_controller`` factory. This module
imports only ``pygame`` and the sibling ``env`` constants, so it is copied verbatim into the
student template's ``sandbox/env/`` by the generate script.
"""

from __future__ import annotations

from typing import Any

import pygame

from .env import NOOP_ACTION

#: The flap action (the env's action space is ``Discrete(2)``: 0 = idle, 1 = flap).
FLAP_ACTION = 1
#: Keys that flap; either is accepted so the control is discoverable.
_FLAP_KEYS = (pygame.K_SPACE, pygame.K_UP)


class FlappyHumanController:
    """Sample the keyboard each tick: flap while a flap key is held, otherwise idle."""

    def __init__(self) -> None:
        #: Set when the window is closed, so the play loop knows to stop.
        self.quit = False

    def act(self, slot_id: str, observation: Any, *, blocking: bool) -> int:
        """Return ``FLAP_ACTION`` if a flap key is down this tick, else ``NOOP_ACTION``.

        ``blocking`` is accepted for a uniform controller interface but ignored: a realtime
        game samples input non-blocking and advances regardless. Draining the event queue here
        both updates the key state and lets a window-close be noticed promptly.
        """
        if not pygame.get_init():
            return NOOP_ACTION
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                self.quit = True
        keys = pygame.key.get_pressed()
        return FLAP_ACTION if any(keys[key] for key in _FLAP_KEYS) else NOOP_ACTION


def make_human_controller(env: Any) -> FlappyHumanController:
    """Return the keyboard controller for human Flappy Bird play.

    Takes ``env`` for a uniform factory signature across environments; the keyboard controller
    needs nothing from it (input comes from the shared pygame window the env's renderer opens).
    """
    return FlappyHumanController()
