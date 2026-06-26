"""The pygame renderer for four-player Hearts.

This module turns the per-step overlay from :func:`hearts.overlay.extract_overlay` into a frame
a human can watch and play: four seats laid out N/E/S/W with the human's seat at the bottom, the
in-progress trick growing in the centre, and the human's hand fanned across the bottom edge with
legal cards highlighted and illegal cards greyed. It never reaches into the live environment for
game facts — everything drawn comes from the overlay — so this renderer and the future browser
renderer stay in lockstep.

Two render modes are supported. ``"rgb_array"`` draws only to an offscreen :class:`pygame.Surface`
and returns an ``(H, W, 3)`` uint8 array, so it works headless in CI with no display. ``"human"``
additionally opens a window and blits the same offscreen surface to it. Click-to-select is served
by :meth:`HeartsRenderer.card_at_pos`, which hit-tests a window pixel against the hand rects
recorded during the most recent render (front-most overlapping card wins).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np
import pygame

from local_play.hidpi import display_scale, enable_hidpi

from . import rules
from .overlay import extract_overlay

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .env import HeartsEnv

#: Fixed window / frame dimensions in pixels.
WIDTH, HEIGHT = 960, 720

#: Card-face dimensions for the view seat's fanned hand.
CARD_W, CARD_H = 64, 92
#: Smaller card-face dimensions for trick cards and revealed opponent hands.
SMALL_W, SMALL_H = 48, 70

#: Rank labels indexed by rank id ``0..12`` (``0`` is the 2, ``12`` the ace).
RANK_LABELS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"]

#: Colours (RGB).
FELT = (12, 92, 56)
FELT_DARK = (8, 70, 42)
CARD_FACE = (245, 245, 240)
CARD_BACK = (28, 52, 120)
CARD_BACK_TRIM = (200, 210, 240)
RED_INK = (190, 30, 40)
BLACK_INK = (20, 20, 24)
WHITE = (240, 240, 240)
DIM = (180, 188, 184)
TURN_GLOW = (255, 214, 70)
LEGAL_BORDER = (80, 220, 120)
WINNER_GLOW = (255, 150, 60)
GREY_VEIL = (60, 70, 64, 150)


class HeartsRenderer:
    """Draw a Hearts hand to an offscreen surface (and optionally a window) from the overlay.

    The renderer is constructed once per environment and reused across steps. It lazily
    initializes pygame on the first :meth:`render` so the module stays importable without a
    display, and only opens a window in ``"human"`` mode.
    """

    def __init__(self, render_mode: str) -> None:
        """Store ``render_mode`` (``"human"`` or ``"rgb_array"``); defer pygame init to render."""
        self.render_mode = render_mode
        self._inited = False
        #: Device-pixel scale for HiDPI native rendering; resolved in _ensure_init (1.0 headless).
        self.scale: float = 1.0
        self._screen: pygame.Surface | None = None
        self._surface: pygame.Surface | None = None
        # Fonts are bound in _ensure_init() (run at the top of every render); declared with their
        # concrete type rather than None-initialised so the draw helpers see Font, not Font | None.
        self._font: pygame.font.Font
        self._font_small: pygame.font.Font
        self._font_big: pygame.font.Font
        #: (card id, rect) for each drawn hand card, in draw order (left to right).
        self._hand_rects: list[tuple[int, pygame.Rect]] = []
        #: Legal card ids from the most recent render, for click acceptance.
        self._legal_cards: set[int] = set()

    # -- lifecycle -----------------------------------------------------------------------------

    def _ensure_init(self) -> None:
        """Initialize fonts and the offscreen surface once; needs no display for rgb_array."""
        if self._inited:
            return
        # A human window must be DPI-aware before it is created, so a HiDPI display renders it at
        # physical pixels instead of bitmap-stretching it (blurry); we then draw natively at
        # ``self.scale``. The headless rgb_array path stays at logical 1.0 so frames and recordings
        # are byte-identical across machines (and the existing renderer test is unaffected).
        enable_hidpi()
        self.scale = display_scale() if self.render_mode == "human" else 1.0
        # Only the font module is required for the headless rgb_array path; pygame.init() is
        # heavier and reserved for the human path where a display is wanted anyway.
        if not pygame.font.get_init():
            pygame.font.init()
        if self.render_mode == "human" and not pygame.get_init():
            pygame.init()
        self._surface = pygame.Surface((self._s(WIDTH), self._s(HEIGHT)))
        self._font = pygame.font.Font(None, self._s(26))
        self._font_small = pygame.font.Font(None, self._s(22))
        self._font_big = pygame.font.Font(None, self._s(34))
        self._inited = True

    def _s(self, value: float) -> int:
        """Scale a logical pixel length to device pixels for the current HiDPI render scale."""
        return round(value * self.scale)

    # -- public hit-testing helpers ------------------------------------------------------------

    def card_at_pos(self, pos: tuple[int, int]) -> int | None:
        """Return the view-seat card under window pixel ``pos``, or ``None`` if none.

        Hand cards overlap, so the rects are scanned in reverse draw order (the visually
        front-most / right-most card first) so the card a human sees on top wins. Legality is
        ignored here; the caller decides whether to accept the click.
        """
        for card, rect in reversed(self._hand_rects):
            if rect.collidepoint(pos):
                return card
        return None

    def card_rect(self, card: int) -> pygame.Rect | None:
        """Return the rect drawn for ``card`` in the view seat's hand, or ``None`` if absent."""
        for drawn_card, rect in self._hand_rects:
            if drawn_card == card:
                return rect
        return None

    def is_legal_card(self, card: int) -> bool:
        """Return whether ``card`` was legal in the most recently rendered frame."""
        return card in self._legal_cards

    # -- rendering -----------------------------------------------------------------------------

    def render(self, env: HeartsEnv) -> np.ndarray | None:
        """Draw the current state of ``env`` and return an rgb array (rgb_array) or ``None``.

        ``env.view_seat`` (default ``0``) is the seat shown at the bottom and the one whose hand
        is fanned and clickable. ``env.reveal_all`` (default ``False``) draws every seat's faces
        for spectating/replay; otherwise the three opponents are face-down.
        """
        self._ensure_init()
        overlay = extract_overlay(env)
        view_seat = int(getattr(env, "view_seat", 0))
        reveal_all = bool(getattr(env, "reveal_all", False))

        surface = self._surface
        assert surface is not None
        surface.fill(FELT)

        self._draw_seats(surface, overlay, view_seat)
        self._draw_trick(surface, overlay, view_seat)
        self._draw_opponents(surface, overlay, view_seat, reveal_all)
        self._draw_hand(surface, overlay, view_seat)
        self._draw_status(surface, overlay)

        if self.render_mode == "rgb_array":
            arr = pygame.surfarray.array3d(surface)
            return np.transpose(arr, (1, 0, 2)).astype(np.uint8)

        # human: open the window lazily, then mirror the offscreen surface onto it. Both are sized
        # at the device-pixel scale, so the blit is 1:1 and the frame stays crisp on a HiDPI display.
        if self._screen is None:
            self._screen = pygame.display.set_mode((self._s(WIDTH), self._s(HEIGHT)))
            pygame.display.set_caption("Hearts")
        self._screen.blit(surface, (0, 0))
        pygame.event.pump()
        pygame.display.flip()
        return None

    # -- drawing pieces ------------------------------------------------------------------------

    def _seat_anchor(self, slot: int) -> tuple[int, int]:
        """Return the (x, y) centre of the seat badge for a clockwise slot ``0=S..3=E``."""
        anchors = {
            0: (self._s(WIDTH // 2), self._s(HEIGHT - 150)),  # South (view seat)
            1: (self._s(130), self._s(HEIGHT // 2)),  # West
            2: (self._s(WIDTH // 2), self._s(70)),  # North
            3: (self._s(WIDTH - 130), self._s(HEIGHT // 2)),  # East
        }
        return anchors[slot]

    def _slot_of_seat(self, seat: int, view_seat: int) -> int:
        """Map an absolute ``seat`` to a screen slot (``0=S,1=W,2=N,3=E``) with view at South."""
        return (seat - view_seat) % rules.NUM_PLAYERS

    def _draw_seats(self, surface: pygame.Surface, overlay: dict, view_seat: int) -> None:
        """Draw each seat's label, penalty score, and a turn highlight on the active seat."""
        scores = overlay["display_scores"]
        turn = overlay["turn"]
        terminal = overlay["terminal"]
        for seat in range(rules.NUM_PLAYERS):
            slot = self._slot_of_seat(seat, view_seat)
            cx, cy = self._seat_anchor(slot)
            badge = pygame.Rect(0, 0, self._s(150), self._s(52))
            badge.center = (cx, cy)
            is_turn = (not terminal) and seat == turn
            if is_turn:
                glow = badge.inflate(self._s(10), self._s(10))
                pygame.draw.rect(surface, TURN_GLOW, glow, border_radius=self._s(10))
            pygame.draw.rect(surface, FELT_DARK, badge, border_radius=self._s(8))
            pygame.draw.rect(surface, WHITE, badge, width=max(1, self._s(2)), border_radius=self._s(8))
            you = " (you)" if seat == view_seat else ""
            label = self._font.render(f"P{seat}{you}", True, WHITE)
            surface.blit(label, label.get_rect(center=(cx, cy - self._s(10))))
            score = self._font_small.render(f"pts {scores[seat]}", True, WHITE)
            surface.blit(score, score.get_rect(center=(cx, cy + self._s(12))))

    def _trick_offset(self, slot: int) -> tuple[int, int]:
        """Return the centre offset (dx, dy) for a card played from screen ``slot``."""
        return {
            0: (0, self._s(80)),
            1: (self._s(-90), 0),
            2: (0, self._s(-80)),
            3: (self._s(90), 0),
        }[slot]

    def _draw_trick(self, surface: pygame.Surface, overlay: dict, view_seat: int) -> None:
        """Draw the in-progress trick, or the completed last trick if no trick is in progress."""
        center = (self._s(WIDTH // 2), self._s(HEIGHT // 2))
        trick = overlay["current_trick"]
        winner = None
        if not trick and overlay["last_trick"] is not None:
            trick = overlay["last_trick"]
            winner = overlay["last_trick_winner"]
        for seat, card in trick:
            slot = self._slot_of_seat(seat, view_seat)
            dx, dy = self._trick_offset(slot)
            rect = pygame.Rect(0, 0, self._s(SMALL_W), self._s(SMALL_H))
            rect.center = (center[0] + dx, center[1] + dy)
            highlight = WINNER_GLOW if winner is not None and seat == winner else None
            self._draw_card_face(surface, rect, card, self._font_small, border=highlight)

    def _draw_opponents(
        self, surface: pygame.Surface, overlay: dict, view_seat: int, reveal_all: bool
    ) -> None:
        """Draw the three non-view seats: face-down backs, or small faces when ``reveal_all``."""
        for seat in range(rules.NUM_PLAYERS):
            if seat == view_seat:
                continue
            slot = self._slot_of_seat(seat, view_seat)
            hand = overlay["hands"][seat]
            self._draw_opponent_row(surface, slot, hand, reveal_all)

    def _draw_opponent_row(
        self, surface: pygame.Surface, slot: int, hand: list[int], reveal_all: bool
    ) -> None:
        """Lay an opponent's cards out along their table edge (backs unless revealing)."""
        count = len(hand)
        if count == 0:
            return
        vertical = slot in (1, 3)  # West / East sit along the side edges.
        small_w, small_h = self._s(SMALL_W), self._s(SMALL_H)
        span = self._s(HEIGHT if vertical else WIDTH) - self._s(360)
        step = min(small_w - self._s(14), span // max(count, 1)) if count > 1 else 0
        run = step * (count - 1) + small_w
        if vertical:
            x = self._s(36) if slot == 1 else self._s(WIDTH) - self._s(36) - small_w
            start = (self._s(HEIGHT) - run) // 2
            positions = [(x, start + i * step) for i in range(count)]
        else:
            y = self._s(130)  # North row sits just under the top seat badge.
            start = (self._s(WIDTH) - run) // 2
            positions = [(start + i * step, y) for i in range(count)]
        for card, (x, y) in zip(hand, positions, strict=False):
            rect = pygame.Rect(x, y, small_w, small_h)
            if reveal_all:
                self._draw_card_face(surface, rect, card, self._font_small)
            else:
                self._draw_card_back(surface, rect)

    def _draw_hand(self, surface: pygame.Surface, overlay: dict, view_seat: int) -> None:
        """Fan the view seat's hand across the bottom, highlighting legal and greying illegal."""
        self._hand_rects = []
        hand = list(overlay["hands"][view_seat])
        self._legal_cards = set(overlay["legal_actions"])
        count = len(hand)
        if count == 0:
            return

        card_w, card_h = self._s(CARD_W), self._s(CARD_H)
        margin = self._s(40)
        avail = self._s(WIDTH) - 2 * margin
        # Overlap as needed so all cards fit within the available width.
        step = min(card_w + self._s(6), (avail - card_w) // (count - 1)) if count > 1 else 0
        run = step * (count - 1) + card_w
        start_x = (self._s(WIDTH) - run) // 2
        base_y = self._s(HEIGHT) - card_h - self._s(18)

        for i, card in enumerate(hand):
            legal = card in self._legal_cards
            x = start_x + i * step
            # Raise legal cards a few px so they read as selectable.
            y = base_y - (self._s(10) if legal else 0)
            rect = pygame.Rect(x, y, card_w, card_h)
            border = LEGAL_BORDER if legal else None
            self._draw_card_face(surface, rect, card, self._font, border=border, border_w=4)
            if not legal:
                veil = pygame.Surface((card_w, card_h), pygame.SRCALPHA)
                veil.fill(GREY_VEIL)
                surface.blit(veil, rect.topleft)
            self._hand_rects.append((card, rect))

    def _draw_status(self, surface: pygame.Surface, overlay: dict) -> None:
        """Draw the top-left status line: trick number, hearts-broken, turn or game-over."""
        terminal = overlay["terminal"]
        trick_txt = "trick done" if terminal else f"trick {overlay['tricks_played'] + 1}/{rules.NUM_TRICKS}"
        broken = "hearts broken" if overlay["hearts_broken"] else "hearts intact"

        line1 = self._font.render(f"{trick_txt}   {broken}", True, WHITE)
        surface.blit(line1, (self._s(16), self._s(14)))

        if terminal:
            scores = overlay["display_scores"]
            summary = "  ".join(f"P{s}:{scores[s]}" for s in range(rules.NUM_PLAYERS))
            over = self._font_big.render("Game over", True, TURN_GLOW)
            surface.blit(over, (self._s(16), self._s(44)))
            final = self._font.render(f"final  {summary}", True, WHITE)
            surface.blit(final, (self._s(16), self._s(80)))
        else:
            turn_txt = self._font.render(f"turn: P{overlay['turn']}", True, WHITE)
            surface.blit(turn_txt, (self._s(16), self._s(44)))

    # -- card primitives -----------------------------------------------------------------------

    def _draw_card_face(
        self,
        surface: pygame.Surface,
        rect: pygame.Rect,
        card: int,
        font: pygame.font.Font,
        *,
        border: tuple[int, int, int] | None = None,
        border_w: int = 3,
    ) -> None:
        """Draw a face-up card (rank + suit pip) into ``rect``, optionally with a glow border."""
        radius = self._s(6)
        pygame.draw.rect(surface, CARD_FACE, rect, border_radius=radius)
        pygame.draw.rect(surface, BLACK_INK, rect, width=max(1, self._s(1)), border_radius=radius)
        if border is not None:
            bw = max(1, self._s(border_w))
            pygame.draw.rect(surface, border, rect.inflate(bw, bw), width=bw, border_radius=radius)

        suit = rules.suit_of(card)
        ink = RED_INK if suit in (rules.DIAMONDS, rules.HEARTS) else BLACK_INK
        rank_str = RANK_LABELS[rules.rank_of(card)]

        rank_img = font.render(rank_str, True, ink)
        surface.blit(rank_img, (rect.x + self._s(5), rect.y + self._s(4)))
        # The suit is drawn from primitives, not a font glyph: the default pygame font has no
        # card-suit characters, so font.render("♥") would draw a missing-glyph box.
        self._draw_suit(surface, suit, rect.center, round(rect.width * 0.5), ink)
        # Mirror the rank in the bottom-right corner for a card-like read.
        small = self._font_small.render(rank_str, True, ink)
        surface.blit(
            small, small.get_rect(bottomright=(rect.right - self._s(5), rect.bottom - self._s(4)))
        )

    def _draw_suit(
        self,
        surface: pygame.Surface,
        suit: int,
        center: tuple[int, int],
        size: int,
        ink: tuple[int, int, int],
    ) -> None:
        """Draw a suit pip centred at ``center`` within a ``size``-pixel box, in colour ``ink``.

        Built from pygame primitives so it needs no font glyph and scales with the card (``size``
        is already in device pixels). Diamonds/hearts use one or two lobes plus a point; spades and
        clubs add a small stem at the base.
        """
        cx, cy = int(center[0]), int(center[1])
        half = size / 2.0

        if suit == rules.DIAMONDS:
            hw, hh = size * 0.36, size * 0.5
            pygame.draw.polygon(
                surface,
                ink,
                [(cx, int(cy - hh)), (int(cx + hw), cy), (cx, int(cy + hh)), (int(cx - hw), cy)],
            )
            return

        if suit == rules.HEARTS:
            r = size * 0.25
            lobe_y = cy - size * 0.10
            pygame.draw.circle(surface, ink, (int(cx - r), int(lobe_y)), int(r))
            pygame.draw.circle(surface, ink, (int(cx + r), int(lobe_y)), int(r))
            pygame.draw.polygon(
                surface,
                ink,
                [(int(cx - 2 * r), int(lobe_y)), (int(cx + 2 * r), int(lobe_y)), (cx, int(cy + half))],
            )
            return

        if suit == rules.SPADES:
            r = size * 0.25
            lobe_y = cy + size * 0.10
            pygame.draw.circle(surface, ink, (int(cx - r), int(lobe_y)), int(r))
            pygame.draw.circle(surface, ink, (int(cx + r), int(lobe_y)), int(r))
            pygame.draw.polygon(
                surface,
                ink,
                [(int(cx - 2 * r), int(lobe_y)), (int(cx + 2 * r), int(lobe_y)), (cx, int(cy - half))],
            )
            self._draw_suit_stem(surface, (cx, cy), size, ink)
            return

        # Clubs: a trefoil of three circles plus a stem.
        r = size * 0.22
        pygame.draw.circle(surface, ink, (cx, int(cy - size * 0.16)), int(r))
        pygame.draw.circle(surface, ink, (int(cx - size * 0.22), int(cy + size * 0.10)), int(r))
        pygame.draw.circle(surface, ink, (int(cx + size * 0.22), int(cy + size * 0.10)), int(r))
        self._draw_suit_stem(surface, (cx, cy), size, ink)

    @staticmethod
    def _draw_suit_stem(
        surface: pygame.Surface, center: tuple[int, int], size: float, ink: tuple[int, int, int]
    ) -> None:
        """Draw the little trapezoid stem shared by the spade and club pips."""
        cx, cy = center
        pygame.draw.polygon(
            surface,
            ink,
            [
                (int(cx - size * 0.16), int(cy + size * 0.48)),
                (int(cx + size * 0.16), int(cy + size * 0.48)),
                (int(cx + size * 0.06), int(cy + size * 0.10)),
                (int(cx - size * 0.06), int(cy + size * 0.10)),
            ],
        )

    def _draw_card_back(self, surface: pygame.Surface, rect: pygame.Rect) -> None:
        """Draw a face-down card back (patterned rect) into ``rect``."""
        pygame.draw.rect(surface, CARD_BACK, rect, border_radius=self._s(6))
        pygame.draw.rect(surface, CARD_BACK_TRIM, rect, width=max(1, self._s(2)), border_radius=self._s(6))
        inner = rect.inflate(self._s(-12), self._s(-16))
        pygame.draw.rect(surface, CARD_BACK_TRIM, inner, width=max(1, self._s(1)), border_radius=self._s(4))

    # -- teardown ------------------------------------------------------------------------------

    def close(self) -> None:
        """Close the window if one was opened. Idempotent; never global-quits pygame.

        Only :func:`pygame.display.quit` is called — a global :func:`pygame.quit` would de-init
        the font module and break other envs/tests sharing the process.
        """
        if self._screen is not None:
            pygame.display.quit()
            self._screen = None
