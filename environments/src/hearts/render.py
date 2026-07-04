"""The pygame renderer for four-player Hearts.

This module turns the per-step overlay from :func:`hearts.overlay.extract_overlay` into a frame
a human can watch and play: four seats laid out N/E/S/W with the human's seat at the bottom, the
in-progress trick growing in the centre, and the human's hand fanned across the bottom edge with
legal cards highlighted and illegal cards greyed. It never reaches into the live environment for
game facts — everything drawn comes from the overlay — so this renderer and the future browser
renderer stay in lockstep.

The table, seat badges, trick, hand, opponent rows, and card primitives are the shared
:class:`~local_play.render_cards.CardTableRenderer`; :class:`HeartsRenderer` subclasses it and adds
only what is specific to Hearts: the overlay source, the penalty-points seat line, the two-row
status strip with its legal-move hints, and the human-mode card/trick-sweep animations.

Two render modes are supported. ``"rgb_array"`` draws only to an offscreen :class:`pygame.Surface`
and returns an ``(H, W, 3)`` uint8 array, so it works headless in CI with no display. ``"human"``
additionally opens a window and blits the same offscreen surface to it. Click-to-select is served
by :meth:`CardTableRenderer.card_at_pos`, which hit-tests a window pixel against the hand rects
recorded during the most recent render (front-most overlapping card wins).

When a trick completes in ``"human"`` mode the renderer plays a short, self-contained sweep
animation (:meth:`_animate_trick_won`): the winner's card pulses gold and the four cards slide and
shrink into the winner's seat, so *who took the trick* is unmistakable. The animation is driven by
the wall clock and is gated to ``"human"`` mode only, so the headless ``"rgb_array"`` path stays a
deterministic single frame for CI and recordings.
"""

from __future__ import annotations

import importlib
import math
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

# Palette and card sizes the animation/status code still references directly, re-exported from the
# shared module so there is one source of truth for them.
GOLD = _cards.GOLD
GOLD_DIM = _cards.GOLD_DIM
WHITE = _cards.WHITE
DIM = _cards.DIM
RED_INK = _cards.RED_INK
WINNER_GLOW = _cards.WINNER_GLOW
SMALL_W, SMALL_H = _cards.SMALL_W, _cards.SMALL_H

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


class HeartsRenderer(CardTableRenderer):
    """Draw a Hearts hand to an offscreen surface (and optionally a window) from the overlay.

    The renderer is constructed once per environment and reused across steps. It inherits the shared
    card-table drawing and adds the Hearts overlay source, the penalty-points seat line, the status
    strip, and the human-mode animations. Pygame is initialized lazily on the first
    :meth:`~local_play.render_cards.CardTableRenderer.render`, so the module stays importable without
    a display, and a window opens only in ``"human"`` mode.
    """

    WINDOW_CAPTION = "Hearts"

    def __init__(self, render_mode: str) -> None:
        """Store ``render_mode`` (``"human"`` or ``"rgb_array"``); defer pygame init to render."""
        super().__init__(render_mode)
        # Bound in _ensure_init(); declared here with its concrete type (not None) so the pill draw
        # helper sees Font, not Font | None.
        self._font_big: pygame.font.Font
        #: Count of completed tricks whose win animation has already played (human mode only).
        self._animated_tricks: int = 0
        #: The previously rendered overlay (human mode only), so the card fly-in knows where each card
        #: was last drawn. The Python twin of the browser renderer's `lastState`.
        self._prev_overlay: dict[str, Any] | None = None

    def _ensure_init(self) -> None:
        """Initialize the shared fonts/surface plus the big font used by the points pill."""
        if self._inited:
            return
        super()._ensure_init()
        self._font_big = pygame.font.Font(None, self._s(34))

    # -- overlay + hooks -----------------------------------------------------------------------

    def _extract_overlay(self, env: Any) -> dict[str, Any]:
        """Return the per-step Hearts overlay for ``env``."""
        return extract_overlay(env)

    def _before_draw(self, env: Any, overlay: dict, view_seat: int, reveal_all: bool) -> None:
        """Reset the animation state on a fresh deal, then (human mode) animate the move from the
        previous overlay before the static frame and remember this overlay for the next diff.

        A card fly-in runs for the just-played card, chaining into the trick-won sweep when it was a
        trick's fourth card. The headless ``rgb_array`` path animates nothing and stays a single
        deterministic frame (the twin of ``index.ts`` setting ``lastState`` each update).
        """
        tricks_played = overlay["tricks_played"]
        if tricks_played < self._animated_tricks:
            self._animated_tricks = 0  # a fresh deal rewound the trick count
            self._prev_overlay = None  # ...and there is no prior frame to animate from
        if self.render_mode == "human":
            self._animate_transition(overlay, view_seat, reveal_all, tricks_played)
            self._prev_overlay = overlay

    def _suppress_completed_trick(self, overlay: dict) -> bool:
        """Keep the centre clear once a completed trick has been swept to its winner (human mode).

        The cards are "with" the winner now, so the centre stays clear through the post-trick pause.
        The headless rgb_array path never suppresses, so it always shows the completed trick.
        """
        return self.render_mode == "human" and overlay["tricks_played"] == self._animated_tricks

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
        strip_h = self._s(60)
        panel = pygame.Surface((w, strip_h), pygame.SRCALPHA)
        panel.fill((0, 0, 0, 104))
        surface.blit(panel, (0, 0))
        pygame.draw.line(surface, GOLD_DIM, (0, strip_h), (w, strip_h), max(1, self._s(1)))

        terminal = overlay["terminal"]
        row1_y = self._s(9)
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

        # Hint row: the contextual "why these options" line. The small +2 gap keeps it inside the
        # 60px strip (the lockstep twin of index.ts).
        hint = self._legal_hint(overlay, view_seat)
        if hint:
            h = self._font_small.render(hint, True, HINT_INK)
            surface.blit(h, (self._s(16), row1_y + t1.get_height() + self._s(2)))

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
            points = sum(rules.card_points(card) for _, card in overlay["last_trick"])
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
            can_follow = any(rules.suit_of(card) == led for card in hand)
            if can_follow:
                hint = f"Follow suit  -  you must play a {SUIT_SINGULAR[led]}"
                if tricks_played == 0:
                    hint += "; no hearts or Queen of Spades on the first trick"
                return hint
            if tricks_played == 0:
                return f"No {SUIT_NAMES[led]}  -  discard anything except hearts or the Queen of Spades"
            return f"No {SUIT_NAMES[led]}  -  free to discard anything"

        # Leading, past the opening play.
        non_hearts = [card for card in hand if rules.suit_of(card) != rules.HEARTS]
        if not overlay["hearts_broken"] and non_hearts:
            return "Your lead  -  hearts aren't broken yet, so you can't lead a heart"
        if not non_hearts:
            return "Your lead  -  only hearts left, so you may lead them"
        return "Your lead  -  hearts are broken, lead any suit"

    # -- card-play and trick-won animations (human mode only) ----------------------------------

    @staticmethod
    def _smoothstep(t: float) -> float:
        """Clamp ``t`` to ``[0, 1]`` and apply the classic smoothstep ease."""
        t = max(0.0, min(1.0, t))
        return t * t * (3.0 - 2.0 * t)

    def _animate_transition(
        self, overlay: dict, view_seat: int, reveal_all: bool, tricks_played: int
    ) -> None:
        """Animate the move from the previous overlay to this one (human mode), mirroring index.ts.

        A card fly-in runs for the just-played card; when that play was a trick's fourth card it
        resolves the trick in the same step (see ``rules.play``), so the fly-in chains into the
        trick-won sweep. Either piece is a no-op when not applicable, so a fresh deal or a repeated
        frame animates nothing.
        """
        play = self._detect_play(overlay)
        newly_completed = (
            not overlay["current_trick"]
            and overlay["last_trick"] is not None
            and tricks_played > self._animated_tricks
        )
        if play is not None:
            self._ensure_window()
            self._animate_card_played(overlay, view_seat, reveal_all, play)
        if newly_completed:
            self._ensure_window()
            self._animate_trick_won(overlay, view_seat, reveal_all)
            self._animated_tricks = tricks_played

    def _detect_play(self, overlay: dict) -> tuple[int, int, list[tuple[int, int]]] | None:
        """Return ``(seat, card, resting_pairs)`` for the card just played versus the previous overlay,
        or ``None``. The pure twin of scene.ts ``detectPlay``: either one new pair was appended to the
        in-progress trick (cards 1–3), or the trick count went up and the new card shows only in the
        completed ``last_trick`` (the fourth card). Whether that play *completed* the trick — and so
        chains into the sweep — is decided separately by :meth:`_animate_transition` (``newly_completed``),
        so it is not carried here.
        """
        prev = self._prev_overlay
        if prev is None:
            return None
        p_trick = prev["current_trick"]
        n_trick = overlay["current_trick"]
        p_tricks = prev["tricks_played"]
        n_tricks = overlay["tricks_played"]
        if n_tricks == p_tricks and len(n_trick) == len(p_trick) + 1:
            seat, card = n_trick[-1]
            return int(seat), int(card), [(int(s), int(c)) for s, c in p_trick]
        if not n_trick and overlay["last_trick"] is not None and n_tricks == p_tricks + 1:
            resting = {int(c) for _, c in p_trick}
            played = [pair for pair in overlay["last_trick"] if int(pair[1]) not in resting]
            if not played:
                return None
            seat, card = played[0]
            return int(seat), int(card), [(int(s), int(c)) for s, c in p_trick]
        return None

    def _play_source(self, prev: dict, view_seat: int, seat: int, card: int) -> tuple[int, int, int, int]:
        """Device-pixel centre and size ``(cx, cy, w, h)`` of ``card`` as it was drawn for ``seat`` in
        the previous overlay: the view seat's fanned hand, or an opponent row. Reuses the shared layout
        helpers (:meth:`_hand_layout` / :meth:`_opponent_row_layout`) so the source matches the actual
        draw to the pixel — the twin of scene.ts ``playSource`` reusing ``buildHand``/``buildOpponents``.
        Falls back to the seat badge if the card can't be located (defensive).
        """
        if seat == view_seat:
            layout = self._hand_layout(list(prev["hands"][view_seat]), set(prev["legal_actions"]))
        else:
            slot = self._slot_of_seat(seat, view_seat)
            layout = self._opponent_row_layout(slot, list(prev["hands"][seat]))
        for drawn_card, rect in layout:
            if drawn_card == card:
                return rect.centerx, rect.centery, rect.width, rect.height
        ax, ay = self._seat_anchor(self._slot_of_seat(seat, view_seat))
        return ax, ay, self._s(SMALL_W), self._s(SMALL_H)

    def _animate_card_played(
        self,
        overlay: dict,
        view_seat: int,
        reveal_all: bool,
        play: tuple[int, int, list[tuple[int, int]]],
    ) -> None:
        """Play the ~0.48 s fly-in: the played card holds (gold-ringed) where it left the hand, then
        slides into its trick spot, shrinking to trick size. The cards already in the centre sit
        static beneath it. Human mode only; drives its own frame loop and flips, like the sweep.
        """
        surface = self._surface
        screen = self._screen
        prev = self._prev_overlay
        if surface is None or screen is None or prev is None:
            return
        seat, card, resting_pairs = play

        sx, sy, sw, sh = self._play_source(prev, view_seat, seat, card)
        center = (self._s(WIDTH // 2), self._s(HEIGHT // 2))
        dx, dy = self._trick_offset(self._slot_of_seat(seat, view_seat))
        tx, ty = center[0] + dx, center[1] + dy
        end_scale = self._s(SMALL_W) / sw

        duration_ms = 480.0
        hold = 0.30  # fraction spent holding + highlighting before the slide begins
        clock = pygame.time.Clock()
        start = pygame.time.get_ticks()
        while True:
            elapsed = pygame.time.get_ticks() - start
            t = elapsed / duration_ms
            if t >= 1.0:
                break
            move = 0.0 if t < hold else self._smoothstep((t - hold) / (1.0 - hold))

            # Base frame, minus the in-progress trick (we draw the resting cards + the flyer ourselves).
            # The hand and opponent rows are drawn from the *previous* overlay with the flying card
            # hidden, so the source row holds its layout (a placeholder gap where the card was) instead
            # of re-packing while one card flies out. Seats and status reflect the new state.
            self._draw_table(surface)
            self._draw_seats(surface, overlay, view_seat)
            self._draw_opponents(surface, prev, view_seat, reveal_all, hidden_card=card)
            self._draw_hand(surface, prev, view_seat, hidden_card=card)
            self._draw_status(surface, overlay, view_seat)

            for r_seat, r_card in resting_pairs:
                r_dx, r_dy = self._trick_offset(self._slot_of_seat(r_seat, view_seat))
                r_rect = pygame.Rect(0, 0, self._s(SMALL_W), self._s(SMALL_H))
                r_rect.center = (center[0] + r_dx, center[1] + r_dy)
                self._draw_card_face(surface, r_rect, r_card, self._font_small)

            scale = 1.0 + (end_scale - 1.0) * move
            cw = max(1, round(sw * scale))
            ch = max(1, round(sh * scale))
            rect = pygame.Rect(0, 0, cw, ch)
            rect.center = (round(sx + (tx - sx) * move), round(sy + (ty - sy) * move))
            # Held at the source the flyer wears a gold "selected" ring (distinct from the green legal
            # border); once it slides the ring drops, so it reads as "this is the card going out".
            border = GOLD if t < hold else None
            self._draw_card_face(surface, rect, card, self._font_small, border=border, border_w=4)

            screen.blit(surface, (0, 0))
            pygame.event.pump()
            pygame.display.flip()
            clock.tick(60)

    def _animate_trick_won(self, overlay: dict, view_seat: int, reveal_all: bool) -> None:
        """Play the ~0.9 s sweep: the winner's card pulses gold, then the four cards slide and
        shrink into the winner's seat. Human mode only; drives its own frame loop and flips.
        """
        surface = self._surface
        screen = self._screen
        if surface is None or screen is None:
            return
        winner = overlay["last_trick_winner"]
        trick = overlay["last_trick"]
        if winner is None or not trick:
            return

        center = (self._s(WIDTH // 2), self._s(HEIGHT // 2))
        win_anchor = self._seat_anchor(self._slot_of_seat(winner, view_seat))
        cards: list[tuple[int, int, tuple[int, int]]] = []
        for seat, card in trick:
            dx, dy = self._trick_offset(self._slot_of_seat(seat, view_seat))
            cards.append((seat, card, (center[0] + dx, center[1] + dy)))
        points = sum(rules.card_points(card) for _, card in trick)

        duration_ms = 900.0
        hold = 0.34  # fraction spent holding + pulsing before the sweep begins
        clock = pygame.time.Clock()
        start = pygame.time.get_ticks()
        while True:
            elapsed = pygame.time.get_ticks() - start
            t = elapsed / duration_ms
            if t >= 1.0:
                break

            # Base frame, minus the static trick (we draw the moving cards ourselves).
            self._draw_table(surface)
            self._draw_seats(surface, overlay, view_seat, winner_flash=winner if t >= hold else None)
            self._draw_opponents(surface, overlay, view_seat, reveal_all)
            self._draw_hand(surface, overlay, view_seat)
            self._draw_status(surface, overlay, view_seat)

            if t < hold:
                move = 0.0
                shimmer = 0.5 + 0.5 * math.sin(elapsed / 150.0)
            else:
                move = self._smoothstep((t - hold) / (1.0 - hold))
                shimmer = 1.0

            for seat, card, (sx, sy) in cards:
                cx = round(sx + (win_anchor[0] - sx) * move)
                cy = round(sy + (win_anchor[1] - sy) * move)
                scale = 1.0 - 0.7 * move
                cw = max(1, round(self._s(SMALL_W) * scale))
                ch = max(1, round(self._s(SMALL_H) * scale))
                rect = pygame.Rect(0, 0, cw, ch)
                rect.center = (cx, cy)
                if seat == winner:
                    self._draw_card_face(
                        surface,
                        rect,
                        card,
                        self._font_small,
                        border=WINNER_GLOW,
                        border_w=5,
                        glow_intensity=0.55 + 0.7 * shimmer,
                    )
                else:
                    self._draw_card_face(surface, rect, card, self._font_small)

            if points:
                self._draw_points_pill(surface, win_anchor, points, t, hold)

            screen.blit(surface, (0, 0))
            pygame.event.pump()
            pygame.display.flip()
            clock.tick(60)

    def _draw_points_pill(
        self, surface: pygame.Surface, anchor: tuple[int, int], points: int, t: float, hold: float
    ) -> None:
        """Draw the gold ``+N`` points pill above the winner's seat; it scales in during the hold."""
        text = self._font_big.render(f"+{points}", True, (32, 24, 18))
        pad = self._s(13)
        pill = pygame.Surface((text.get_width() + pad * 2, text.get_height() + self._s(8)), pygame.SRCALPHA)
        rrect = pill.get_rect()
        radius = rrect.height // 2
        pygame.draw.rect(pill, (*GOLD, 236), rrect, border_radius=radius)
        pygame.draw.rect(pill, (255, 244, 206), rrect, width=max(1, self._s(2)), border_radius=radius)
        pill.blit(text, text.get_rect(center=rrect.center))

        appear = self._smoothstep(t / hold) if t < hold else 1.0
        if appear < 1.0:
            pill = pygame.transform.rotozoom(pill, 0, 0.6 + 0.4 * appear)
        surface.blit(pill, pill.get_rect(center=(anchor[0], anchor[1] - self._s(56))))
