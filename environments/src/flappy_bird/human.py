"""Keyboard control for playing Flappy Bird by hand.

Flappy Bird is realtime (the env declares a ``pace_interval_ms``), so a human plays it by
tapping while the loop advances at a fixed cadence: this controller drains the pygame event
queue once per tick and flaps on a flap-key press or a click — it never blocks. A flap is a
discrete edge (``space``/``up`` ``KEYDOWN`` or a mouse click), not a held key: the wrapped
``flappy-bird-gymnasium`` env drains the event queue itself on every render, so polling the
held-key state (``pygame.key.get_pressed()``) is unreliable here; reading ``KEYDOWN`` edges is
what the library's own human-play reference does. Closing the window sets :attr:`quit`, which
the play loop checks to stop.

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
    """Drain input each tick: flap on a flap-key press or a click, otherwise idle."""

    def __init__(self) -> None:
        #: Set when the window is closed, so the play loop knows to stop.
        self.quit = False

    def act(self, slot_id: str, observation: Any, *, blocking: bool) -> int:
        """Return ``FLAP_ACTION`` if a flap edge arrived this tick, else ``NOOP_ACTION``.

        ``blocking`` is accepted for a uniform controller interface but ignored: a realtime
        game samples input non-blocking and advances regardless. We flap on a flap-key
        ``KEYDOWN`` (``space``/``up``) or a left-click ``MOUSEBUTTONDOWN`` — discrete edges
        rather than held state, because the env drains the event queue on every render, which
        makes ``pygame.key.get_pressed()`` miss presses. Draining here also lets a
        window-close be noticed promptly.
        """
        if not pygame.get_init():
            return NOOP_ACTION
        flap = False
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                self.quit = True
            elif (event.type == pygame.KEYDOWN and event.key in _FLAP_KEYS) or (
                event.type == pygame.MOUSEBUTTONDOWN and event.button == 1
            ):
                flap = True
        return FLAP_ACTION if flap else NOOP_ACTION


def make_human_controller(env: Any) -> FlappyHumanController:
    """Return the keyboard controller for human Flappy Bird play.

    Takes ``env`` for a uniform factory signature across environments; the keyboard controller
    needs nothing from it (input comes from the shared pygame window the env's renderer opens).
    """
    return FlappyHumanController()
