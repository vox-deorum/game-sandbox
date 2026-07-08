"""Mouse control for playing Spades by hand.

Spades is turn-based across two kinds of turn, so a human plays it by clicking: a bid chip during
the bidding round, then a legal card during play. This controller blocks until the human left-clicks
a valid target, hit-testing the click against the renderer. During bidding it accepts a click on any
bid chip (:meth:`SpadesRenderer.bid_action_at_pos`, which returns the ``52 + k`` bid action); during
play it accepts a click on a *legal* card (:meth:`SpadesRenderer.card_at_pos` gated by
:meth:`SpadesRenderer.is_legal_card`). The chips are only drawn while bidding, so a single loop tries
a bid click first and a card click second without needing to know the phase itself. Illegal clicks
are ignored; the window is kept live with periodic re-renders while we wait. Closing the window sets
:attr:`quit`, which the play loop checks to stop.

The local play loops discover this by the uniform ``make_human_controller`` factory: the project's
``scripts/play.py`` and :mod:`spades.demo` in this repo, and the student template's ``sandbox`` play
CLI once this module is synced there.
"""

from __future__ import annotations

import importlib
import time
from typing import TYPE_CHECKING, Any

import pygame


def _shared_card_utils() -> Any:
    """Return the shared :mod:`card_utils` under whichever name this file runs as.

    One source syncs into two layouts: :mod:`local_play.card_utils` inside the environments package,
    ``sandbox.card_utils`` in a composed template. Mirrors the resolver in ``spades.rules`` /
    ``spades.overlay``.
    """
    for candidate in ("local_play.card_utils", "sandbox.card_utils"):
        try:
            return importlib.import_module(candidate)
        except ModuleNotFoundError as exc:
            missing = exc.name or ""
            if missing == candidate or candidate.startswith(f"{missing}."):
                continue
            raise
    raise ModuleNotFoundError("no shared card_utils found (tried local_play.card_utils, sandbox.card_utils)")


if TYPE_CHECKING:  # pyright sees the real module; this branch never executes at runtime
    from local_play import card_utils as _cu
else:
    _cu = _shared_card_utils()

card_from_obj = _cu.card_from_obj


class SpadesHumanController:
    """Block until the human clicks a bid chip (bidding) or a legal card (play), then return it."""

    def __init__(self, env: Any) -> None:
        self.env = env
        #: Set when the window is closed, so the play loop knows to stop.
        self.quit = False

    def act(self, slot_id: str, observation: Any, *, blocking: bool) -> int | None:
        """Wait for a valid click and return its action, or ``None`` if the window closed.

        ``blocking`` is accepted for a uniform controller interface; a turn-based seat always blocks
        for the human's move. The renderer is read from the env (populated by the play loop's render
        before our turn). ``bid_action_at_pos`` returns a bid action only while chips are drawn
        (bidding); ``card_at_pos`` gated by ``is_legal_card`` accepts a legal card during play.
        """
        renderer = self.env._renderer
        try:
            while True:
                for event in pygame.event.get():
                    if event.type == pygame.QUIT:
                        self.quit = True
                        return None
                    if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                        # Every bid 0..13 is always legal, so a chip click needs no legality gate;
                        # a card click does, so it is accepted only when the card is legal.
                        bid_action = renderer.bid_action_at_pos(event.pos)
                        if bid_action is not None:
                            return bid_action
                        card = renderer.card_at_pos(event.pos)
                        if card is not None and renderer.is_legal_card(card):
                            return card_from_obj(card)
                # Highlight the card under the cursor (hover feedback) before re-rendering. The rects
                # are recorded at rest, so the lift never moves the hit target out from under the mouse.
                renderer.set_hover(renderer.card_at_pos(pygame.mouse.get_pos()))
                self.env.render()
                time.sleep(0.02)
        finally:
            # Clear hover so it never lingers into the opponents' turns.
            renderer.set_hover(None)


def make_human_controller(env: Any) -> SpadesHumanController:
    """Return the mouse controller for human Spades play, bound to ``env``."""
    return SpadesHumanController(env)
