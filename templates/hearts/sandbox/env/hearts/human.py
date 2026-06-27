"""Mouse control for playing Hearts by hand.

Hearts is turn-based, so a human plays it by clicking a card when it is their turn: this
controller blocks until the human left-clicks a *legal* card, hit-testing the click against the
renderer's fanned hand (:meth:`HeartsRenderer.card_at_pos`) and accepting it only when the card
is legal (:meth:`HeartsRenderer.is_legal_card`). Illegal clicks are ignored; the window is kept
live with periodic re-renders while we wait. Closing the window sets :attr:`quit`, which the
play loop checks to stop.

The local play loops (the project's ``scripts/play.py`` and :mod:`hearts.demo`) discover this by
the uniform ``make_human_controller`` factory; the demo's interactive seat is built on it too.
"""

from __future__ import annotations

import time
from typing import Any

import pygame


class HeartsHumanController:
    """Block until the human clicks a legal card in their seat, then return that card."""

    def __init__(self, env: Any) -> None:
        self.env = env
        #: Set when the window is closed, so the play loop knows to stop.
        self.quit = False

    def act(self, slot_id: str, observation: Any, *, blocking: bool) -> int | None:
        """Wait for a legal card click and return it, or ``None`` if the window closed.

        ``blocking`` is accepted for a uniform controller interface; a turn-based seat always
        blocks for the human's move. The renderer is read from the env (populated by the play
        loop's render before our turn); its ``card_at_pos`` returns the front-most card under a
        pixel, and ``is_legal_card`` gates acceptance.
        """
        renderer = self.env._renderer
        while True:
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    self.quit = True
                    return None
                if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                    card = renderer.card_at_pos(event.pos)
                    if card is not None and renderer.is_legal_card(card):
                        return card
            self.env.render()
            time.sleep(0.02)


def make_human_controller(env: Any) -> HeartsHumanController:
    """Return the mouse controller for human Hearts play, bound to ``env``."""
    return HeartsHumanController(env)
