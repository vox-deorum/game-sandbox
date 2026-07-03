"""The pygame renderer for four-player partnership Spades.

This module turns the per-step overlay from :func:`spades.overlay.extract_overlay` into a frame a
human can watch and play. It reuses the Hearts table geometry (four seats laid out N/E/S/W with the
view seat at the bottom, the in-progress trick growing in the centre, and the view seat's hand
fanned across the bottom edge with legal cards highlighted and illegal cards greyed) and draws what
Spades adds on top: per-seat ``bid/won`` badges with a NIL marker, the two team scores styled so the
partnership reads at a glance, a spades-broken indicator, and a phase indicator. During the bidding
round it draws a clickable row of bid chips ``0..13`` (``0`` labelled "NIL") in the centre well.

It never reaches into the live environment for game facts; everything drawn comes from the overlay,
so this renderer and the future browser renderer stay in lockstep on legality (both grey from the
same emitted mask).

Two render modes are supported. ``"rgb_array"`` draws only to an offscreen :class:`pygame.Surface`
and returns an ``(H, W, 3)`` uint8 array, so it works headless in CI with no display. ``"human"``
additionally opens a window and blits the same offscreen surface to it. Click-to-select is served by
:meth:`SpadesRenderer.card_at_pos` (cards) and :meth:`SpadesRenderer.bid_action_at_pos` (bid chips),
which hit-test a window pixel against the rects recorded during the most recent render.
"""

from __future__ import annotations

import importlib
import math
from typing import TYPE_CHECKING, Any

import numpy as np
import pygame

from . import rules
from .overlay import extract_overlay

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .env import SpadesEnv


def _hidpi() -> Any:
    """Return the HiDPI shim module under whichever name this file is running as.

    This module is one source synced verbatim into two layouts: inside the environments package the
    shim is :mod:`local_play.hidpi`, while in a student's composed template it ships as
    :mod:`sandbox.hidpi`. Resolving it by name (rather than a static import that only one layout could
    satisfy) keeps the single file importable in both, with no rewrite during the sync.
    """
    for name in ("local_play.hidpi", "sandbox.hidpi"):
        try:
            return importlib.import_module(name)
        except ModuleNotFoundError:
            continue
    raise ModuleNotFoundError("no HiDPI shim found (tried local_play.hidpi, sandbox.hidpi)")


#: Fixed window / frame dimensions in pixels.
WIDTH, HEIGHT = 960, 720

#: Card-face dimensions for the view seat's fanned hand.
CARD_W, CARD_H = 64, 92
#: Smaller card-face dimensions for trick cards and revealed opponent hands.
SMALL_W, SMALL_H = 48, 70
#: How far (logical px) a hovered hand card lifts, so the human sees which card is under the cursor.
HOVER_LIFT = 8

#: Supersampling factor for suit pips: each pip is drawn this many times larger and smoothscaled
#: back down, so pygame's non-antialiased ``draw`` primitives still yield smooth edges.
SUIT_SS = 4
#: Padding (device px) added around a pip's scratch surface so its widest lobes never clip.
_SUIT_PAD = 2

#: Rank labels indexed by rank id ``0..12`` (``0`` is the 2, ``12`` the ace).
RANK_LABELS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"]

#: Colours (RGB).
FELT_TOP = (20, 116, 74)
FELT_BOTTOM = (7, 60, 38)
WELL_RING = (44, 150, 102)
GOLD = (236, 200, 112)
GOLD_DIM = (150, 124, 60)
CARD_FACE = (249, 247, 240)
CARD_EDGE = (208, 204, 192)
CARD_BACK = (32, 58, 130)
CARD_BACK_DARK = (20, 38, 92)
CARD_BACK_TRIM = (206, 214, 240)
CARD_BACK_GOLD = (208, 176, 96)
RED_INK = (196, 28, 38)
BLACK_INK = (26, 26, 32)
WHITE = (242, 242, 240)
DIM = (178, 190, 184)
BADGE_BG = (15, 58, 39)
BADGE_BG_YOU = (20, 76, 53)
BADGE_SHADOW = (3, 32, 21)
LEGAL_BORDER = (94, 226, 132)
WINNER_GLOW = GOLD
GREY_VEIL = (38, 50, 44, 168)
NIL_INK = (240, 176, 96)
#: The two partnership accent colours, so the team score line and badges read as two teams.
TEAM_TINT = {0: (108, 196, 236), 1: (236, 156, 120)}
CHIP_BG = (18, 66, 45)
CHIP_BG_HOVER = (30, 96, 66)
CHIP_EDGE = (120, 200, 150)


class SpadesRenderer:
    """Draw a Spades hand to an offscreen surface (and optionally a window) from the overlay.

    The renderer is constructed once per environment and reused across steps. It lazily initializes
    pygame on the first :meth:`render` so the module stays importable without a display, and only
    opens a window in ``"human"`` mode.
    """

    def __init__(self, render_mode: str) -> None:
        """Store ``render_mode`` (``"human"`` or ``"rgb_array"``); defer pygame init to render."""
        self.render_mode = render_mode
        self._inited = False
        #: Device-pixel scale for HiDPI native rendering; resolved in _ensure_init (1.0 headless).
        self.scale: float = 1.0
        self._screen: pygame.Surface | None = None
        self._surface: pygame.Surface | None = None
        #: Cached opaque table background (gradient + vignette + central well); built once.
        self._bg: pygame.Surface | None = None
        # Fonts are bound in _ensure_init() (run at the top of every render); declared with their
        # concrete type rather than None-initialised so the draw helpers see Font, not Font | None.
        self._font: pygame.font.Font
        self._font_small: pygame.font.Font
        #: (card id, rect) for each drawn hand card, in draw order (left to right).
        self._hand_rects: list[tuple[int, pygame.Rect]] = []
        #: Legal card ids from the most recent render, for click acceptance (play phase).
        self._legal_cards: set[int] = set()
        #: (bid value, rect) for each drawn bid chip, or empty when not in the bidding phase.
        self._bid_rects: list[tuple[int, pygame.Rect]] = []
        #: The hand card to highlight on the next render (human hover feedback), or None. Stays None
        #: in rgb_array mode, so headless frames are byte-identical.
        self._hovered_card: int | None = None
        #: Cache of antialiased suit pips keyed by (suit, size, ink).
        self._pip_cache: dict[tuple[int, int, tuple[int, int, int]], pygame.Surface] = {}

    # -- lifecycle -----------------------------------------------------------------------------

    def _ensure_init(self) -> None:
        """Initialize fonts and the offscreen surface once; needs no display for rgb_array."""
        if self._inited:
            return
        hidpi = _hidpi()
        hidpi.enable_hidpi()
        self.scale = hidpi.display_scale() if self.render_mode == "human" else 1.0
        if not pygame.font.get_init():
            pygame.font.init()
        if self.render_mode == "human" and not pygame.get_init():
            pygame.init()
        self._surface = pygame.Surface((self._s(WIDTH), self._s(HEIGHT)))
        self._font = pygame.font.Font(None, self._s(26))
        self._font_small = pygame.font.Font(None, self._s(22))
        self._inited = True

    def _s(self, value: float) -> int:
        """Scale a logical pixel length to device pixels for the current HiDPI render scale."""
        return round(value * self.scale)

    # -- small math helpers --------------------------------------------------------------------

    def _pulse(self, period_ms: float, phase: float = 0.0) -> float:
        """Return a smooth ``0..1`` pulse keyed to the wall clock, for breathing highlights.

        In ``"human"`` mode the value sweeps over ``period_ms`` so a highlight breathes across the
        human-wait re-renders. In ``"rgb_array"`` mode it is a fixed ``1.0`` so headless frames are
        deterministic (no wall-clock dependence).
        """
        if self.render_mode != "human":
            return 1.0
        t = pygame.time.get_ticks()
        return 0.5 + 0.5 * math.sin((t / period_ms) * math.tau + phase)

    @staticmethod
    def _lerp_color(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
        """Linearly interpolate between two RGB colours at fraction ``t``."""
        return (
            round(a[0] + (b[0] - a[0]) * t),
            round(a[1] + (b[1] - a[1]) * t),
            round(a[2] + (b[2] - a[2]) * t),
        )

    # -- public hit-testing helpers ------------------------------------------------------------

    def card_at_pos(self, pos: tuple[int, int]) -> int | None:
        """Return the view-seat card under window pixel ``pos``, or ``None`` if none.

        Hand cards overlap, so the rects are scanned in reverse draw order (the visually front-most /
        right-most card first) so the card a human sees on top wins. Legality is ignored here; the
        caller decides whether to accept the click.
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

    def bid_action_at_pos(self, pos: tuple[int, int]) -> int | None:
        """Return the *action* (``52 + k``) of the bid chip under ``pos``, or ``None`` if none.

        The chips are only drawn during the bidding phase, so this returns ``None`` throughout play,
        which lets the human controller try a bid click and a card click without knowing the phase.
        """
        for bid, rect in self._bid_rects:
            if rect.collidepoint(pos):
                return rules.bid_to_action(bid)
        return None

    def bid_rect(self, bid: int) -> pygame.Rect | None:
        """Return the rect drawn for bid chip ``bid`` (``0..13``), or ``None`` if not drawn."""
        for drawn_bid, rect in self._bid_rects:
            if drawn_bid == bid:
                return rect
        return None

    def set_hover(self, card: int | None) -> None:
        """Set the hand card to highlight on the next render (human hover feedback), or ``None``."""
        self._hovered_card = card

    # -- rendering -----------------------------------------------------------------------------

    def render(self, env: SpadesEnv) -> np.ndarray | None:
        """Draw the current state of ``env`` and return an rgb array (rgb_array) or ``None``.

        ``env.view_seat`` (default ``0``) is the seat shown at the bottom and the one whose hand is
        fanned and clickable. ``env.reveal_all`` (default ``False``) draws every seat's faces for
        spectating/replay; otherwise the three opponents are face-down. In the bidding phase the
        centre well shows the clickable bid chips instead of a trick.
        """
        self._ensure_init()
        overlay = extract_overlay(env)
        view_seat = int(getattr(env, "view_seat", 0))
        reveal_all = bool(getattr(env, "reveal_all", False))

        surface = self._surface
        assert surface is not None

        self._draw_table(surface)
        self._draw_seats(surface, overlay, view_seat)
        if overlay["phase"] == "bidding":
            self._draw_bid_chips(surface, overlay, view_seat)
        else:
            self._bid_rects = []
            self._draw_trick(surface, overlay, view_seat)
        self._draw_opponents(surface, overlay, view_seat, reveal_all)
        self._draw_hand(surface, overlay, view_seat)
        self._draw_status(surface, overlay, view_seat)

        if self.render_mode == "rgb_array":
            arr = pygame.surfarray.array3d(surface)
            return np.transpose(arr, (1, 0, 2)).astype(np.uint8)

        self._ensure_window()
        assert self._screen is not None
        self._screen.blit(surface, (0, 0))
        pygame.event.pump()
        pygame.display.flip()
        return None

    def _ensure_window(self) -> None:
        """Open the human window once, sized to the device-pixel frame. No-op if already open."""
        if self._screen is None:
            self._screen = pygame.display.set_mode((self._s(WIDTH), self._s(HEIGHT)))
            pygame.display.set_caption("Spades")

    # -- table background ----------------------------------------------------------------------

    def _draw_table(self, surface: pygame.Surface) -> None:
        """Blit the cached felt background (built once), which doubles as the per-frame clear."""
        if self._bg is None:
            self._bg = self._build_background()
        surface.blit(self._bg, (0, 0))

    def _build_background(self) -> pygame.Surface:
        """Build the opaque table: a vertical felt gradient, a radial vignette, and a centre well."""
        w, h = self._s(WIDTH), self._s(HEIGHT)
        bg = pygame.Surface((w, h))
        for y in range(h):
            bg.fill(self._lerp_color(FELT_TOP, FELT_BOTTOM, y / max(1, h - 1)), (0, y, w, 1))

        # Radial vignette: darken toward the edges so the table reads as a lit oval.
        yy, xx = np.mgrid[0:h, 0:w]
        dist = np.sqrt(((xx - w / 2.0) / (w * 0.62)) ** 2 + ((yy - h / 2.0) / (h * 0.60)) ** 2)
        alpha = (np.clip((dist - 0.5) / 0.7, 0.0, 1.0) * 165).astype(np.uint8)
        vignette = pygame.Surface((w, h), pygame.SRCALPHA)
        alpha_view = pygame.surfarray.pixels_alpha(vignette)
        alpha_view[:, :] = alpha.T  # surfarray is (w, h); our field is (h, w)
        del alpha_view  # release the surface lock before blitting
        bg.blit(vignette, (0, 0))

        # Central play "well": a soft darkened oval with a faint gold ring marks the trick area.
        well = pygame.Rect(0, 0, self._s(474), self._s(332))
        well.center = (w // 2, h // 2)
        shade = pygame.Surface((well.width, well.height), pygame.SRCALPHA)
        pygame.draw.ellipse(shade, (0, 0, 0, 58), shade.get_rect())
        bg.blit(shade, well.topleft)
        pygame.draw.ellipse(bg, WELL_RING, well, width=max(1, self._s(2)))
        return bg

    # -- seat badges ---------------------------------------------------------------------------

    def _seat_anchor(self, slot: int) -> tuple[int, int]:
        """Return the (x, y) centre of the seat badge for a clockwise slot ``0=S..3=E``."""
        anchors = {
            0: (self._s(WIDTH // 2), self._s(HEIGHT - 150)),  # South (view seat)
            1: (self._s(130), self._s(HEIGHT // 2)),  # West
            2: (self._s(WIDTH // 2), self._s(112)),  # North (below the status strip)
            3: (self._s(WIDTH - 130), self._s(HEIGHT // 2)),  # East
        }
        return anchors[slot]

    def _slot_of_seat(self, seat: int, view_seat: int) -> int:
        """Map an absolute ``seat`` to a screen slot (``0=S,1=W,2=N,3=E``) with view at South."""
        return (seat - view_seat) % rules.NUM_PLAYERS

    def _draw_seats(self, surface: pygame.Surface, overlay: dict, view_seat: int) -> None:
        """Draw each seat's badge: name, partnership tint, ``bid/won`` line, and an active glow.

        The active seat's halo breathes (a gold pulse) in human mode. Before a seat has bid its line
        reads "waiting to bid"; after, it shows "NIL" for a nil bid else the number, with the
        tricks-won count beside it.
        """
        turn = overlay["turn"]
        terminal = overlay["terminal"]
        bids = overlay["bids"]
        tricks_won = overlay["tricks_won"]
        for seat in range(rules.NUM_PLAYERS):
            slot = self._slot_of_seat(seat, view_seat)
            cx, cy = self._seat_anchor(slot)
            badge = pygame.Rect(0, 0, self._s(168), self._s(62))
            badge.center = (cx, cy)
            is_turn = (not terminal) and seat == turn

            if is_turn:
                pulse = self._pulse(950)
                glow_a = int(110 + 120 * pulse)
                spread = self._s(7) + round(self._s(6) * pulse)
                halo = badge.inflate(spread * 1.1, spread * 1.1)
                halo_surf = pygame.Surface((halo.width, halo.height), pygame.SRCALPHA)
                pygame.draw.rect(halo_surf, (*GOLD, glow_a), halo_surf.get_rect(), border_radius=self._s(16))
                surface.blit(halo_surf, halo.topleft)

            shadow = badge.move(self._s(1), self._s(3))
            pygame.draw.rect(surface, BADGE_SHADOW, shadow, border_radius=self._s(11))
            body = BADGE_BG_YOU if seat == view_seat else BADGE_BG
            pygame.draw.rect(surface, body, badge, border_radius=self._s(11))
            pygame.draw.rect(
                surface,
                GOLD if is_turn else WHITE,
                badge,
                width=max(1, self._s(2)),
                border_radius=self._s(11),
            )
            # A short partnership tab down the badge's left edge, so the two teams read at a glance.
            tint = TEAM_TINT[rules.team_of(seat)]
            tab = pygame.Rect(
                badge.left + self._s(5), badge.top + self._s(9), self._s(4), badge.height - self._s(18)
            )
            pygame.draw.rect(surface, tint, tab, border_radius=self._s(2))

            you = "  (you)" if seat == view_seat else ""
            label = self._font.render(f"P{seat}{you}", True, WHITE)
            surface.blit(label, label.get_rect(center=(cx, cy - self._s(12))))
            self._draw_bid_won(surface, seat, bids[seat], tricks_won[seat], (cx, cy + self._s(14)), is_turn)

    def _draw_bid_won(
        self,
        surface: pygame.Surface,
        seat: int,
        bid: int,
        won: int,
        center: tuple[int, int],
        highlight: bool,
    ) -> None:
        """Draw a seat's ``bid · won`` line (a waiting note before a bid, NIL for nil)."""
        cx, cy = center
        if bid < 0:
            text = "waiting to bid"
            img = self._font_small.render(text, True, DIM)
            surface.blit(img, img.get_rect(center=(cx, cy)))
            return
        bid_str = "NIL" if bid == rules.NIL_BID else str(bid)
        bid_color = NIL_INK if bid == rules.NIL_BID else (GOLD if highlight else WHITE)
        bid_img = self._font_small.render(f"bid {bid_str}", True, bid_color)
        won_img = self._font_small.render(f"  ·  won {won}", True, DIM)
        total_w = bid_img.get_width() + won_img.get_width()
        x = cx - total_w // 2
        surface.blit(bid_img, bid_img.get_rect(midleft=(x, cy)))
        surface.blit(won_img, won_img.get_rect(midleft=(x + bid_img.get_width(), cy)))

    # -- bid chips (bidding phase) -------------------------------------------------------------

    def _draw_bid_chips(self, surface: pygame.Surface, overlay: dict, view_seat: int) -> None:
        """Draw the clickable row of bid chips ``0..13`` in the centre well (``0`` labelled NIL).

        The chips are the view seat's affordance during bidding; their rects are recorded for
        hit-testing. When it is not the view seat's turn the chips still draw (so the table reads),
        but the human controller only accepts a click on its own turn.
        """
        self._bid_rects = []
        center_y = self._s(HEIGHT // 2)
        chip_w, chip_h = self._s(50), self._s(52)
        gap = self._s(4)
        count = rules.NUM_BIDS
        run = count * chip_w + (count - 1) * gap
        start_x = (self._s(WIDTH) - run) // 2
        view_turn = overlay["turn"] == view_seat and not overlay["terminal"]

        prompt = "Choose your bid" if view_turn else f"P{overlay['turn']} is bidding"
        p_img = self._font.render(prompt, True, GOLD if view_turn else WHITE)
        surface.blit(p_img, p_img.get_rect(center=(self._s(WIDTH // 2), center_y - self._s(52))))

        mouse = pygame.mouse.get_pos() if self.render_mode == "human" else (-1, -1)
        for bid in range(count):
            rect = pygame.Rect(start_x + bid * (chip_w + gap), center_y - chip_h // 2, chip_w, chip_h)
            self._bid_rects.append((bid, rect))
            hovered = view_turn and rect.collidepoint(mouse)
            pygame.draw.rect(surface, CHIP_BG_HOVER if hovered else CHIP_BG, rect, border_radius=self._s(8))
            pygame.draw.rect(
                surface,
                GOLD if hovered else CHIP_EDGE,
                rect,
                width=max(1, self._s(2 if hovered else 1)),
                border_radius=self._s(8),
            )
            is_nil = bid == rules.NIL_BID
            label = "NIL" if is_nil else str(bid)
            font = self._font_small if is_nil else self._font
            img = font.render(label, True, NIL_INK if is_nil else WHITE)
            surface.blit(img, img.get_rect(center=rect.center))

    # -- trick (play phase) --------------------------------------------------------------------

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
        if not trick:
            if overlay["last_trick"] is None:
                return
            trick = overlay["last_trick"]
            winner = overlay["last_trick_winner"]
        for seat, card in trick:
            slot = self._slot_of_seat(seat, view_seat)
            dx, dy = self._trick_offset(slot)
            rect = pygame.Rect(0, 0, self._s(SMALL_W), self._s(SMALL_H))
            rect.center = (center[0] + dx, center[1] + dy)
            highlight = WINNER_GLOW if winner is not None and seat == winner else None
            self._draw_card_face(surface, rect, card, self._font_small, border=highlight, border_w=4)

    # -- card layout (fan / opponent rows) -----------------------------------------------------

    def _hand_layout(self, hand: list[int], legal_cards: set[int]) -> list[tuple[int, pygame.Rect]]:
        """Resting rect of every card in the view seat's fanned hand, in draw order (no hover lift).

        Legal cards sit a few px higher (a selectable cue). The one place the bottom fan's geometry
        is computed, reused by :meth:`_draw_hand` for drawing and the ``_hand_rects`` it records.
        """
        count = len(hand)
        if count == 0:
            return []
        card_w, card_h = self._s(CARD_W), self._s(CARD_H)
        margin = self._s(40)
        avail = self._s(WIDTH) - 2 * margin
        step = min(card_w + self._s(6), (avail - card_w) // (count - 1)) if count > 1 else 0
        run = step * (count - 1) + card_w
        start_x = (self._s(WIDTH) - run) // 2
        base_y = self._s(HEIGHT) - card_h - self._s(18)
        layout: list[tuple[int, pygame.Rect]] = []
        for i, card in enumerate(hand):
            x = start_x + i * step
            y = base_y - (self._s(10) if card in legal_cards else 0)
            layout.append((card, pygame.Rect(x, y, card_w, card_h)))
        return layout

    def _opponent_row_layout(self, slot: int, hand: list[int]) -> list[tuple[int, pygame.Rect]]:
        """Rect of every card in an opponent's row along their table edge, in deal order."""
        count = len(hand)
        if count == 0:
            return []
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
            y = self._s(166)  # North row sits just under the top seat badge.
            start = (self._s(WIDTH) - run) // 2
            positions = [(start + i * step, y) for i in range(count)]
        return [
            (card, pygame.Rect(px, py, small_w, small_h))
            for card, (px, py) in zip(hand, positions, strict=False)
        ]

    def _draw_opponents(
        self, surface: pygame.Surface, overlay: dict, view_seat: int, reveal_all: bool
    ) -> None:
        """Draw the three non-view seats: face-down backs, or small faces when ``reveal_all``."""
        for seat in range(rules.NUM_PLAYERS):
            if seat == view_seat:
                continue
            slot = self._slot_of_seat(seat, view_seat)
            hand = overlay["hands"][seat]
            for card, rect in self._opponent_row_layout(slot, hand):
                if reveal_all:
                    self._draw_card_face(surface, rect, card, self._font_small)
                else:
                    self._draw_card_back(surface, rect)

    def _draw_hand(self, surface: pygame.Surface, overlay: dict, view_seat: int) -> None:
        """Fan the view seat's hand across the bottom, highlighting legal and greying illegal.

        ``legal_actions`` in the overlay names cards only during play; during the bidding phase it
        names bid actions (``>= 52``), so no hand card is legal and every card greys, which is the
        correct read: you cannot play a card until you have bid.
        """
        self._hand_rects = []
        # Only card actions (0..51) count as legal cards; bid actions are filtered out.
        self._legal_cards = {a for a in overlay["legal_actions"] if a < rules.NUM_CARDS}
        for card, rect in self._hand_layout(list(overlay["hands"][view_seat]), self._legal_cards):
            self._hand_rects.append((card, rect))
            legal = card in self._legal_cards
            hovered = self._hovered_card is not None and card == self._hovered_card
            draw_rect = rect.move(0, -self._s(HOVER_LIFT)) if hovered else rect
            border = LEGAL_BORDER if legal else None
            self._draw_card_face(surface, draw_rect, card, self._font, border=border, border_w=4)
            if not legal:
                veil = pygame.Surface((rect.width, rect.height), pygame.SRCALPHA)
                veil.fill(GREY_VEIL)
                surface.blit(veil, draw_rect.topleft)
            if hovered:
                self._draw_glow_border(surface, draw_rect, GOLD, 4, 1.0)

    # -- status strip --------------------------------------------------------------------------

    def _draw_status(self, surface: pygame.Surface, overlay: dict, view_seat: int) -> None:
        """Draw the constant two-row status strip across the top of the table.

        Primary row: the phase / trick number, a spade pip for the spades-broken flag, and a state
        message (whose turn / who took the trick / game over). Second row: the two team scores,
        styled by partnership. The strip is always present.
        """
        w = self._s(WIDTH)
        strip_h = self._s(62)
        panel = pygame.Surface((w, strip_h), pygame.SRCALPHA)
        panel.fill((0, 0, 0, 104))
        surface.blit(panel, (0, 0))
        pygame.draw.line(surface, GOLD_DIM, (0, strip_h), (w, strip_h), max(1, self._s(1)))

        terminal = overlay["terminal"]
        bidding = overlay["phase"] == "bidding"
        row1_y = self._s(8)
        if terminal:
            phase_txt = "hand complete"
        elif bidding:
            phase_txt = "bidding"
        else:
            phase_txt = f"trick {overlay['tricks_played'] + 1}/{rules.NUM_TRICKS}"
        t1 = self._font.render(phase_txt, True, WHITE)
        surface.blit(t1, (self._s(16), row1_y))

        # Spades-broken indicator: a small drawn spade pip (gold when broken, muted otherwise).
        broken = overlay["spades_broken"]
        hx = self._s(16) + t1.get_width() + self._s(26)
        hy = row1_y + t1.get_height() // 2
        self._draw_suit(surface, rules.SPADES, (hx, hy), self._s(15), GOLD if broken else (92, 112, 102))
        sb = self._font_small.render(
            "spades broken" if broken else "spades intact", True, WHITE if broken else DIM
        )
        surface.blit(sb, (hx + self._s(14), row1_y + self._s(2)))

        # State message, right-aligned on the primary row.
        msg, msg_color = self._status_message(overlay, view_seat)
        m = self._font.render(msg, True, msg_color)
        surface.blit(m, m.get_rect(topright=(w - self._s(16), row1_y)))

        # Second row: the two team scores, each tinted with its partnership colour.
        self._draw_team_scores(surface, overlay, view_seat, row1_y + t1.get_height() + self._s(2))

    def _draw_team_scores(self, surface: pygame.Surface, overlay: dict, view_seat: int, y: int) -> None:
        """Draw the two team score readouts on the status strip's second row, tinted by team."""
        team_scores = overlay["team_scores"]
        x = self._s(16)
        for team in range(2):
            a, b = rules.team_seats(team)
            mine = " (you)" if view_seat in (a, b) else ""
            text = f"P{a}+P{b}{mine}: {team_scores[team]}"
            img = self._font_small.render(text, True, TEAM_TINT[team])
            surface.blit(img, (x, y))
            x += img.get_width() + self._s(28)

    def _status_message(self, overlay: dict, view_seat: int) -> tuple[str, tuple[int, int, int]]:
        """Return the primary-row state message and its colour."""
        if overlay["terminal"]:
            return "Game over", GOLD
        turn = overlay["turn"]
        verb = "to bid" if overlay["phase"] == "bidding" else "to play"
        if turn == view_seat:
            return ("Your bid" if overlay["phase"] == "bidding" else "Your turn"), GOLD
        return f"P{turn} {verb}", WHITE

    # -- card primitives -----------------------------------------------------------------------

    def _draw_card_shadow(self, surface: pygame.Surface, rect: pygame.Rect) -> None:
        """Drop a soft translucent shadow just below/right of a card rect, for lift."""
        pad = self._s(4)
        shadow = pygame.Surface((rect.width + pad * 2, rect.height + pad * 2), pygame.SRCALPHA)
        pygame.draw.rect(
            shadow, (0, 0, 0, 78), shadow.get_rect().inflate(-pad, -pad), border_radius=self._s(7)
        )
        surface.blit(shadow, (rect.x - pad + self._s(2), rect.y - pad + self._s(3)))

    def _draw_glow_border(
        self,
        surface: pygame.Surface,
        rect: pygame.Rect,
        color: tuple[int, int, int],
        width: int,
        intensity: float,
    ) -> None:
        """Draw a soft layered glow around ``rect`` plus a crisp inner stroke, in ``color``."""
        radius = self._s(7)
        for spread, base_a in ((3, 55), (2, 95), (1, 150)):
            a = max(0, min(255, int(base_a * intensity)))
            ring = rect.inflate(self._s((width + spread) * 2), self._s((width + spread) * 2))
            halo = pygame.Surface((ring.width, ring.height), pygame.SRCALPHA)
            pygame.draw.rect(
                halo,
                (*color, a),
                halo.get_rect(),
                width=max(1, self._s(2)),
                border_radius=radius + self._s(spread + width),
            )
            surface.blit(halo, ring.topleft)
        pygame.draw.rect(
            surface,
            color,
            rect.inflate(self._s(2), self._s(2)),
            width=max(1, self._s(2)),
            border_radius=radius,
        )

    def _draw_card_face(
        self,
        surface: pygame.Surface,
        rect: pygame.Rect,
        card: int,
        font: pygame.font.Font,
        *,
        border: tuple[int, int, int] | None = None,
        border_w: int = 3,
        glow_intensity: float = 1.0,
        shadow: bool = True,
    ) -> None:
        """Draw a face-up card (corner indices + centre pip) into ``rect``, optionally glowing."""
        radius = self._s(7)
        if shadow:
            self._draw_card_shadow(surface, rect)
        pygame.draw.rect(surface, CARD_FACE, rect, border_radius=radius)
        pygame.draw.rect(surface, CARD_EDGE, rect, width=max(1, self._s(1)), border_radius=radius)
        if border is not None:
            self._draw_glow_border(surface, rect, border, border_w, glow_intensity)

        suit = rules.suit_of(card)
        ink = RED_INK if suit in (rules.DIAMONDS, rules.HEARTS) else BLACK_INK
        rank_str = RANK_LABELS[rules.rank_of(card)]
        self._draw_corner_index(surface, rect, rank_str, suit, ink, font)
        # The suit is drawn from primitives, not a font glyph: the default pygame font has no
        # card-suit characters, so font.render("♠") would draw a missing-glyph box.
        self._draw_suit(surface, suit, rect.center, round(rect.width * 0.5), ink)

    def _draw_corner_index(
        self,
        surface: pygame.Surface,
        rect: pygame.Rect,
        rank_str: str,
        suit: int,
        ink: tuple[int, int, int],
        font: pygame.font.Font,
    ) -> None:
        """Draw the rank + small suit pip in the top-left corner and a rotated rank bottom-right."""
        rank_img = font.render(rank_str, True, ink)
        surface.blit(rank_img, (rect.x + self._s(5), rect.y + self._s(3)))
        pip_size = max(self._s(7), round(rect.width * 0.17))
        pip_cx = rect.x + self._s(5) + min(rank_img.get_width(), self._s(12)) // 2
        pip_cy = rect.y + self._s(4) + rank_img.get_height() + pip_size // 2
        self._draw_suit(surface, suit, (pip_cx, pip_cy), pip_size, ink)
        rotated = pygame.transform.rotate(rank_img, 180)
        surface.blit(
            rotated, rotated.get_rect(bottomright=(rect.right - self._s(5), rect.bottom - self._s(3)))
        )

    def _draw_suit(
        self,
        surface: pygame.Surface,
        suit: int,
        center: tuple[int, int],
        size: int,
        ink: tuple[int, int, int],
    ) -> None:
        """Draw an antialiased suit pip centred at ``center`` within a ``size``-pixel box.

        pygame's plain ``draw`` primitives are not antialiased, so we render the pip at
        :data:`SUIT_SS`x resolution onto a throwaway surface and smoothscale it down, smoothing every
        edge in one pass. Results are cached by (suit, size, ink); only a few combinations recur.
        """
        size = max(1, int(round(size)))
        key = (suit, size, ink)
        scaled = self._pip_cache.get(key)
        if scaled is None:
            out = size + 2 * _SUIT_PAD
            big = out * SUIT_SS
            pip = pygame.Surface((big, big), pygame.SRCALPHA)
            pip.fill((*ink, 0))
            self._draw_suit_shapes(pip, suit, (big // 2, big // 2), size * SUIT_SS, ink)
            scaled = pygame.transform.smoothscale(pip, (out, out))
            self._pip_cache[key] = scaled
        surface.blit(scaled, scaled.get_rect(center=(int(center[0]), int(center[1]))))

    def _draw_suit_shapes(
        self,
        surface: pygame.Surface,
        suit: int,
        center: tuple[int, int],
        size: float,
        ink: tuple[int, int, int],
    ) -> None:
        """Draw the raw (un-antialiased) suit primitives for ``suit`` onto a supersampled surface."""
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
        """Draw a face-down card back: a gold lattice on deep blue with a gold rim and shadow."""
        radius = self._s(6)
        self._draw_card_shadow(surface, rect)
        pygame.draw.rect(surface, CARD_BACK, rect, border_radius=radius)
        inner = rect.inflate(self._s(-8), self._s(-10))
        pygame.draw.rect(surface, CARD_BACK_DARK, inner, border_radius=self._s(4))

        prev_clip = surface.get_clip()
        surface.set_clip(inner)
        spacing = self._s(11)
        line_w = max(1, self._s(1))
        x = inner.left - inner.height
        while x < inner.right + inner.height:
            pygame.draw.line(
                surface, CARD_BACK_GOLD, (x, inner.top), (x + inner.height, inner.bottom), line_w
            )
            pygame.draw.line(
                surface, CARD_BACK_GOLD, (x, inner.bottom), (x + inner.height, inner.top), line_w
            )
            x += spacing
        surface.set_clip(prev_clip)

        pygame.draw.rect(surface, CARD_BACK_TRIM, inner, width=max(1, self._s(1)), border_radius=self._s(4))
        pygame.draw.rect(surface, CARD_BACK_GOLD, rect, width=max(1, self._s(2)), border_radius=radius)

    # -- teardown ------------------------------------------------------------------------------

    def close(self) -> None:
        """Close the window if one was opened. Idempotent; never global-quits pygame."""
        if self._screen is not None:
            pygame.display.quit()
            self._screen = None
