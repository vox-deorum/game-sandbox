"""The pygame renderer for four-player Hearts.

This module turns the per-step overlay from :func:`hearts.overlay.extract_overlay` into a frame
a human can watch and play: four seats laid out N/E/S/W with the human's seat at the bottom, the
in-progress trick growing in the centre, and the human's hand fanned across the bottom edge with
legal cards highlighted and illegal cards greyed. It never reaches into the live environment for
game facts — everything drawn comes from the overlay — so this renderer and the future browser
renderer stay in lockstep.

The table, seat badges, trick, hand, opponent rows, card primitives, and the human-mode card/trick
animations are the shared :class:`~local_play.render_cards.CardTableRenderer`; :class:`HeartsRenderer`
subclasses it and adds only what is specific to Hearts: the overlay source, the penalty-points seat
line, the two-row status strip with its legal-move hints, and the ``+N`` points pill above the winner.

Two render modes are supported. ``"rgb_array"`` draws only to an offscreen :class:`pygame.Surface`
and returns an ``(H, W, 3)`` uint8 array, so it works headless in CI with no display. ``"human"``
additionally opens a window and blits the same offscreen surface to it. Click-to-select is served
by :meth:`CardTableRenderer.card_at_pos`, which hit-tests a window pixel against the hand rects
recorded during the most recent render (front-most overlapping card wins).

When a trick completes in ``"human"`` mode the shared renderer plays a short sweep animation (the
winner's card pulses gold and the four cards slide into the winner's seat, so *who took the trick* is
unmistakable); Hearts contributes only the ``+N`` points pill that pops above the winner. The
animations are gated to ``"human"`` mode, so the headless ``"rgb_array"`` path stays a deterministic
single frame for CI and recordings.
"""

from __future__ import annotations

import importlib
from typing import TYPE_CHECKING, Any

import pygame

from . import rules
from .overlay import extract_overlay


def _shared_module(name: str) -> Any:
    """Return a shared local-play helper module under whichever name this file is running as.

    The shared renderers are one source synced verbatim into two layouts: inside the environments
    package they import as :mod:`local_play.render_cards` / :mod:`local_play.render_base`, while in a
    student's composed template they ship as ``sandbox.render_cards`` / ``sandbox.render_base``.
    Resolving by name (rather than a static import that only one layout could satisfy) keeps this
    single file importable in both, with no rewrite during the sync.

    A ``ModuleNotFoundError`` is only swallowed when it names *this candidate* (or its parent
    package) — i.e. that layout simply is not present. One that names a dependency the module pulls
    in (``pygame``, the sibling ``render_base``, ``hidpi``) means the module is there but broken, so
    it is re-raised rather than masked as a missing layout and reported as "no shared module found".
    """
    for candidate in (f"local_play.{name}", f"sandbox.{name}"):
        try:
            return importlib.import_module(candidate)
        except ModuleNotFoundError as exc:
            missing = exc.name or ""
            if missing == candidate or candidate.startswith(f"{missing}."):
                continue
            raise
    raise ModuleNotFoundError(f"no shared module found (tried local_play.{name}, sandbox.{name})")


if TYPE_CHECKING:  # pyright sees the real class; this branch never executes at runtime
    from local_play import render_cards as _cards
else:
    _cards = _shared_module("render_cards")

CardTableRenderer = _cards.CardTableRenderer

# Palette the status/seat code references directly, re-exported from the shared module so there is
# one source of truth for it.
GOLD = _cards.GOLD
GOLD_DIM = _cards.GOLD_DIM
WHITE = _cards.WHITE
DIM = _cards.DIM
RED_INK = _cards.RED_INK

#: Fixed window / frame dimensions in pixels (kept as module names for the harness and tests).
WIDTH, HEIGHT = CardTableRenderer.WIDTH, CardTableRenderer.HEIGHT

#: Human-readable suit names for the status-line hints, indexed by suit id.
SUIT_NAMES = {
    rules.CLUBS: "clubs",
    rules.DIAMONDS: "diamonds",
    rules.SPADES: "spades",
    rules.HEARTS: "hearts",
}
SUIT_SINGULAR = {rules.CLUBS: "club", rules.DIAMONDS: "diamond", rules.SPADES: "spade", rules.HEARTS: "heart"}

#: Hint-row ink (Hearts-specific; the shared palette lives in the card-table renderer).
HINT_INK = (210, 222, 216)


def _card_points(card: dict[str, int]) -> int:
    """Return the penalty points a semantic card object is worth: 13 for Q♠, 1 per heart, else 0.

    Mirrors :func:`hearts.rules.card_points`, which operates on the engine's integer encoding
    (queen index ``10``); overlay cards are ``{"suit","rank"}`` objects (face rank, queen ``12``), so
    this reads the object directly rather than round-tripping through ``card_from_obj``.
    """
    if card["suit"] == rules.SPADES and card["rank"] == 12:
        return 13
    if card["suit"] == rules.HEARTS:
        return 1
    return 0


class HeartsRenderer(CardTableRenderer):
    """Draw a Hearts hand to an offscreen surface (and optionally a window) from the overlay.

    The renderer is constructed once per environment and reused across steps. It inherits the shared
    card-table drawing and adds the Hearts overlay source, the penalty-points seat line, the status
    strip, and the human-mode animations. Pygame is initialized lazily on the first
    :meth:`~local_play.render_cards.CardTableRenderer.render`, so the module stays importable without
    a display, and a window opens only in ``"human"`` mode.
    """

    WINDOW_CAPTION = "Hearts"

    # -- overlay + hooks -----------------------------------------------------------------------

    def _extract_overlay(self, env: Any) -> dict[str, Any]:
        """Return the per-step Hearts overlay for ``env``."""
        return extract_overlay(env)

    # -- seat interior + status strip ----------------------------------------------------------

    def _draw_seat_content(
        self,
        surface: pygame.Surface,
        overlay: dict,
        seat: int,
        view_seat: int,
        badge: pygame.Rect,
        highlight: bool,
    ) -> None:
        """Draw the seat name and its running penalty-points line inside the badge."""
        cx, cy = badge.center
        scores = overlay["display_scores"]
        you = "  (you)" if seat == view_seat else ""
        label = self._font.render(f"P{seat}{you}", True, WHITE)
        surface.blit(label, label.get_rect(center=(cx, cy - self._s(11))))
        score = self._font_small.render(f"{scores[seat]} pts", True, GOLD if highlight else DIM)
        surface.blit(score, score.get_rect(center=(cx, cy + self._s(13))))

    def _draw_status(self, surface: pygame.Surface, overlay: dict, view_seat: int) -> None:
        """Draw the constant two-row status strip across the top of the table.

        Primary row: trick number, a drawn heart icon for the hearts-broken flag, and a state
        message (whose turn / who took the trick / game over). Hint row: a contextual hint that
        explains *why* the view seat has the legal options it has. The strip is always present.
        """
        w = self._s(WIDTH)
        strip_h = self._s(55)
        panel = pygame.Surface((w, strip_h), pygame.SRCALPHA)
        panel.fill((0, 0, 0, 104))
        surface.blit(panel, (0, 0))
        pygame.draw.line(surface, GOLD_DIM, (0, strip_h), (w, strip_h), max(1, self._s(1)))

        terminal = overlay["terminal"]
        row1_y = self._s(7)
        trick_txt = (
            "hand complete" if terminal else f"trick {overlay['tricks_played'] + 1}/{rules.NUM_TRICKS}"
        )
        t1 = self._font.render(trick_txt, True, WHITE)
        surface.blit(t1, (self._s(16), row1_y))

        # Hearts-broken indicator: a small drawn heart pip (red when broken, muted otherwise).
        broken = overlay["hearts_broken"]
        hx = self._s(16) + t1.get_width() + self._s(26)
        hy = row1_y + t1.get_height() // 2
        self._draw_suit(surface, rules.HEARTS, (hx, hy), self._s(15), RED_INK if broken else (92, 112, 102))
        hb = self._font_small.render(
            "hearts broken" if broken else "hearts intact", True, WHITE if broken else DIM
        )
        surface.blit(hb, (hx + self._s(14), row1_y + self._s(2)))

        # State message, right-aligned on the primary row.
        msg, msg_color = self._status_message(overlay, view_seat)
        m = self._font.render(msg, True, msg_color)
        surface.blit(m, m.get_rect(topright=(w - self._s(16), row1_y)))

        # Hint row: the contextual "why these options" line. It sits a little below the primary row so
        # the two rows sit evenly in the trimmed 52px strip. (The browser index.ts strip stays taller
        # because Pixi renders this text larger; the two are intentionally not pixel-identical.)
        hint = self._legal_hint(overlay, view_seat)
        if hint:
            h = self._font_small.render(hint, True, HINT_INK)
            surface.blit(h, (self._s(16), row1_y + t1.get_height() + self._s(8)))

    def _status_message(self, overlay: dict, view_seat: int) -> tuple[str, tuple[int, int, int]]:
        """Return the primary-row state message and its colour."""
        if overlay["terminal"]:
            return "Game over", GOLD
        # A trick that has been swept to its winner (human mode): name who took it and the points.
        if (
            self.render_mode == "human"
            and not overlay["current_trick"]
            and overlay["last_trick"] is not None
            and overlay["last_trick_winner"] is not None
            and overlay["tricks_played"] == self._animated_tricks
        ):
            winner = overlay["last_trick_winner"]
            points = sum(_card_points(entry["card"]) for entry in overlay["last_trick"])
            who = "You" if winner == view_seat else f"P{winner}"
            suffix = f" (+{points})" if points else ""
            return f"{who} took the trick{suffix}", GOLD
        turn = overlay["turn"]
        if turn == view_seat:
            return "Your turn", GOLD
        return f"P{turn}'s turn", WHITE

    def _legal_hint(self, overlay: dict, view_seat: int) -> str:
        """Return a short hint explaining the view seat's legal options (mirrors ``legal_moves``).

        On the view seat's turn this explains *why* the legal set is what it is — opening 2♣,
        follow-suit, void/discard, or the hearts-not-broken lead restriction — so a learning player
        understands the rule shaping their choices. When it is not their turn it gives light table
        context so the hint row is never empty.
        """
        if overlay["terminal"]:
            return ""
        turn = overlay["turn"]
        led = overlay["led_suit"]
        if turn != view_seat:
            if led is not None:
                return f"P{turn} to play  -  {SUIT_NAMES[led]} were led"
            return f"Waiting for P{turn} to lead"

        tricks_played = overlay["tricks_played"]
        if tricks_played == 0 and not overlay["current_trick"]:
            return "Opening lead  -  you must play the 2 of clubs"

        hand = overlay["hands"][view_seat]
        if led is not None:
            can_follow = any(card["suit"] == led for card in hand)
            if can_follow:
                hint = f"Follow suit  -  you must play a {SUIT_SINGULAR[led]}"
                if tricks_played == 0:
                    hint += "; no hearts or Queen of Spades on the first trick"
                return hint
            if tricks_played == 0:
                return f"No {SUIT_NAMES[led]}  -  discard anything except hearts or the Queen of Spades"
            return f"No {SUIT_NAMES[led]}  -  free to discard anything"

        # Leading, past the opening play.
        non_hearts = [card for card in hand if card["suit"] != rules.HEARTS]
        if not overlay["hearts_broken"] and non_hearts:
            return "Your lead  -  hearts aren't broken yet, so you can't lead a heart"
        if not non_hearts:
            return "Your lead  -  only hearts left, so you may lead them"
        return "Your lead  -  hearts are broken, lead any suit"

    # -- trick-won badge (the per-game flourish above the winner during the shared sweep) -------

    def _draw_trick_won_badge(
        self,
        surface: pygame.Surface,
        overlay: dict,
        winner: int,
        anchor: tuple[int, int],
        t: float,
        hold: float,
    ) -> None:
        """Pop the gold ``+N`` penalty-points pill above the winner's seat during the sweep."""
        points = sum(_card_points(entry["card"]) for entry in (overlay["last_trick"] or []))
        if points:
            self._draw_pill(surface, f"+{points}", anchor, t, hold)
