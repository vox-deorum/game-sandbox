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

import numpy as np
import pygame

from . import rules
from .overlay import extract_overlay

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .env import HeartsEnv


def _hidpi() -> Any:
    """Return the HiDPI shim module under whichever name this file is running as.

    This module is one source synced verbatim into two layouts: inside the environments package
    the shim is :mod:`local_play.hidpi`, while in a student's composed template it ships as
    :mod:`sandbox.hidpi`. Resolving it by name (rather than a static import that only one layout
    could satisfy) keeps the single file importable in both, with no rewrite during the sync.
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

#: Supersampling factor for suit pips: each pip is drawn this many times larger and smoothscaled
#: back down, so pygame's non-antialiased ``draw`` primitives still yield smooth edges. 4x is the
#: sweet spot — visibly smooth without paying for a much larger scratch surface.
SUIT_SS = 4
#: Padding (device px) added around a pip's scratch surface so its widest lobes never clip.
_SUIT_PAD = 2

#: Rank labels indexed by rank id ``0..12`` (``0`` is the 2, ``12`` the ace).
RANK_LABELS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"]

#: Human-readable suit names for the status-line hints, indexed by suit id.
SUIT_NAMES = {
    rules.CLUBS: "clubs",
    rules.DIAMONDS: "diamonds",
    rules.SPADES: "spades",
    rules.HEARTS: "hearts",
}
SUIT_SINGULAR = {rules.CLUBS: "club", rules.DIAMONDS: "diamond", rules.SPADES: "spade", rules.HEARTS: "heart"}

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
HINT_INK = (210, 222, 216)
BADGE_BG = (15, 58, 39)
BADGE_BG_YOU = (20, 76, 53)
BADGE_SHADOW = (3, 32, 21)
LEGAL_BORDER = (94, 226, 132)
WINNER_GLOW = GOLD
GREY_VEIL = (38, 50, 44, 168)


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
        #: Cached opaque table background (gradient + vignette + central well); built once.
        self._bg: pygame.Surface | None = None
        # Fonts are bound in _ensure_init() (run at the top of every render); declared with their
        # concrete type rather than None-initialised so the draw helpers see Font, not Font | None.
        self._font: pygame.font.Font
        self._font_small: pygame.font.Font
        self._font_big: pygame.font.Font
        #: (card id, rect) for each drawn hand card, in draw order (left to right).
        self._hand_rects: list[tuple[int, pygame.Rect]] = []
        #: Legal card ids from the most recent render, for click acceptance.
        self._legal_cards: set[int] = set()
        #: Count of completed tricks whose win animation has already played (human mode only).
        self._animated_tricks: int = 0
        #: Cache of antialiased suit pips keyed by (suit, size, ink); a handful of distinct sizes
        #: and inks recur every frame, so this turns the per-pip supersample into a one-time cost.
        self._pip_cache: dict[tuple[int, int, tuple[int, int, int]], pygame.Surface] = {}

    # -- lifecycle -----------------------------------------------------------------------------

    def _ensure_init(self) -> None:
        """Initialize fonts and the offscreen surface once; needs no display for rgb_array."""
        if self._inited:
            return
        # A human window must be DPI-aware before it is created, so a HiDPI display renders it at
        # physical pixels instead of bitmap-stretching it (blurry); we then draw natively at
        # ``self.scale``. The headless rgb_array path stays at logical 1.0 so frames and recordings
        # are byte-identical across machines (and the existing renderer test is unaffected).
        hidpi = _hidpi()
        hidpi.enable_hidpi()
        self.scale = hidpi.display_scale() if self.render_mode == "human" else 1.0
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
    def _smoothstep(t: float) -> float:
        """Clamp ``t`` to ``[0, 1]`` and apply the classic smoothstep ease."""
        t = max(0.0, min(1.0, t))
        return t * t * (3.0 - 2.0 * t)

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

        In ``"human"`` mode, a just-completed trick triggers the sweep animation *before* the
        static frame is drawn, so the static frame that follows leaves the centre clear (the cards
        have gone to the winner).
        """
        self._ensure_init()
        overlay = extract_overlay(env)
        view_seat = int(getattr(env, "view_seat", 0))
        reveal_all = bool(getattr(env, "reveal_all", False))

        surface = self._surface
        assert surface is not None

        tricks_played = overlay["tricks_played"]
        if tricks_played < self._animated_tricks:
            self._animated_tricks = 0  # a fresh deal rewound the trick count

        newly_completed = (
            self.render_mode == "human"
            and not overlay["current_trick"]
            and overlay["last_trick"] is not None
            and tricks_played > self._animated_tricks
        )
        if newly_completed:
            self._ensure_window()
            self._animate_trick_won(overlay, view_seat, reveal_all)
            self._animated_tricks = tricks_played

        self._draw_table(surface)
        self._draw_seats(surface, overlay, view_seat)
        self._draw_trick(surface, overlay, view_seat)
        self._draw_opponents(surface, overlay, view_seat, reveal_all)
        self._draw_hand(surface, overlay, view_seat)
        self._draw_status(surface, overlay, view_seat)

        if self.render_mode == "rgb_array":
            arr = pygame.surfarray.array3d(surface)
            return np.transpose(arr, (1, 0, 2)).astype(np.uint8)

        # human: open the window lazily, then mirror the offscreen surface onto it. Both are sized
        # at the device-pixel scale, so the blit is 1:1 and the frame stays crisp on a HiDPI display.
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
            pygame.display.set_caption("Hearts")

    # -- table background ----------------------------------------------------------------------

    def _draw_table(self, surface: pygame.Surface) -> None:
        """Blit the cached felt background (built once), which doubles as the per-frame clear."""
        if self._bg is None:
            self._bg = self._build_background()
        surface.blit(self._bg, (0, 0))

    def _build_background(self) -> pygame.Surface:
        """Build the opaque table: a vertical felt gradient, a radial vignette, and a centre well.

        Done once and cached — the gradient is filled row by row and the vignette is a one-time
        numpy distance field, so there is zero per-frame cost. Works headless (no display needed).
        """
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

    # -- drawing pieces ------------------------------------------------------------------------

    def _seat_anchor(self, slot: int) -> tuple[int, int]:
        """Return the (x, y) centre of the seat badge for a clockwise slot ``0=S..3=E``."""
        anchors = {
            0: (self._s(WIDTH // 2), self._s(HEIGHT - 150)),  # South (view seat)
            1: (self._s(130), self._s(HEIGHT // 2)),  # West
            2: (self._s(WIDTH // 2), self._s(96)),  # North (below the status strip)
            3: (self._s(WIDTH - 130), self._s(HEIGHT // 2)),  # East
        }
        return anchors[slot]

    def _slot_of_seat(self, seat: int, view_seat: int) -> int:
        """Map an absolute ``seat`` to a screen slot (``0=S,1=W,2=N,3=E``) with view at South."""
        return (seat - view_seat) % rules.NUM_PLAYERS

    def _draw_seats(
        self, surface: pygame.Surface, overlay: dict, view_seat: int, winner_flash: int | None = None
    ) -> None:
        """Draw each seat's badge, penalty score, and a glow on the active seat.

        The active seat's halo breathes (a gold pulse) in human mode. ``winner_flash`` is set by
        the sweep animation to flash the trick winner's badge at full intensity.
        """
        scores = overlay["display_scores"]
        turn = overlay["turn"]
        terminal = overlay["terminal"]
        for seat in range(rules.NUM_PLAYERS):
            slot = self._slot_of_seat(seat, view_seat)
            cx, cy = self._seat_anchor(slot)
            badge = pygame.Rect(0, 0, self._s(158), self._s(56))
            badge.center = (cx, cy)
            is_turn = (not terminal) and seat == turn
            flashing = winner_flash is not None and seat == winner_flash
            highlight = is_turn or flashing

            if highlight:
                pulse = 1.0 if flashing else self._pulse(950)
                glow_a = 230 if flashing else int(110 + 120 * pulse)
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
                GOLD if highlight else WHITE,
                badge,
                width=max(1, self._s(2)),
                border_radius=self._s(11),
            )

            you = "  (you)" if seat == view_seat else ""
            label = self._font.render(f"P{seat}{you}", True, WHITE)
            surface.blit(label, label.get_rect(center=(cx, cy - self._s(11))))
            score = self._font_small.render(f"{scores[seat]} pts", True, GOLD if highlight else DIM)
            surface.blit(score, score.get_rect(center=(cx, cy + self._s(13))))

    def _trick_offset(self, slot: int) -> tuple[int, int]:
        """Return the centre offset (dx, dy) for a card played from screen ``slot``."""
        return {
            0: (0, self._s(80)),
            1: (self._s(-90), 0),
            2: (0, self._s(-80)),
            3: (self._s(90), 0),
        }[slot]

    def _draw_trick(self, surface: pygame.Surface, overlay: dict, view_seat: int) -> None:
        """Draw the in-progress trick, or the completed last trick if no trick is in progress.

        Once a completed trick has been swept to its winner by the animation (human mode), it is
        not redrawn in the centre — the cards are "with" the winner now, so the centre stays clear
        through the post-trick pause. The headless rgb_array path always shows the completed trick.
        """
        center = (self._s(WIDTH // 2), self._s(HEIGHT // 2))
        trick = overlay["current_trick"]
        winner = None
        if not trick:
            if overlay["last_trick"] is None:
                return
            if self.render_mode == "human" and overlay["tricks_played"] == self._animated_tricks:
                return  # already swept to the winner; keep the centre clear
            trick = overlay["last_trick"]
            winner = overlay["last_trick_winner"]
        for seat, card in trick:
            slot = self._slot_of_seat(seat, view_seat)
            dx, dy = self._trick_offset(slot)
            rect = pygame.Rect(0, 0, self._s(SMALL_W), self._s(SMALL_H))
            rect.center = (center[0] + dx, center[1] + dy)
            highlight = WINNER_GLOW if winner is not None and seat == winner else None
            self._draw_card_face(surface, rect, card, self._font_small, border=highlight, border_w=4)

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
            y = self._s(150)  # North row sits just under the top seat badge.
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

    # -- status line ---------------------------------------------------------------------------

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

        # Hint row: the contextual "why these options" line.
        hint = self._legal_hint(overlay, view_seat)
        if hint:
            h = self._font_small.render(hint, True, HINT_INK)
            surface.blit(h, (self._s(16), row1_y + t1.get_height() + self._s(6)))

        if terminal:
            scores = overlay["display_scores"]
            ranking = sorted(range(rules.NUM_PLAYERS), key=lambda s: scores[s])
            summary = "    ".join(f"P{s}: {scores[s]}" for s in ranking)
            over = self._font_big.render("Game over", True, GOLD)
            surface.blit(over, over.get_rect(center=(w // 2, self._s(HEIGHT) // 2 - self._s(34))))
            final = self._font.render(summary, True, WHITE)
            surface.blit(final, final.get_rect(center=(w // 2, self._s(HEIGHT) // 2 + self._s(6))))

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

    # -- trick-won animation -------------------------------------------------------------------

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
        # card-suit characters, so font.render("♥") would draw a missing-glyph box.
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
        # Mirror the rank in the bottom-right corner, rotated 180°, for a real-card read.
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

        pygame's plain ``draw`` primitives are not antialiased, so the curved lobes of the
        hearts/clubs/spades and the diamond's diagonals come out jagged when drawn straight to the
        frame. We instead render the pip at :data:`SUIT_SS`x resolution onto a throwaway surface and
        :func:`pygame.transform.smoothscale` it down, which smooths every edge in one pass. The
        scratch surface is pre-filled with ``ink`` at zero alpha (so only the *alpha* varies across
        the pip), which means the downscale blends alpha alone and leaves no dark fringe around the
        shape. ``size`` is already in device pixels, so the pip stays crisp at the current HiDPI
        scale. Results are cached by (suit, size, ink) — only a few combinations recur per frame.
        """
        size = max(1, int(round(size)))
        key = (suit, size, ink)
        scaled = self._pip_cache.get(key)
        if scaled is None:
            out = size + 2 * _SUIT_PAD  # final box, with room so the widest lobes never clip
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
        """Draw the raw (un-antialiased) suit primitives for ``suit`` into ``surface``.

        Called only by :meth:`_draw_suit` on its supersampled scratch surface — never straight to
        the frame. Built from pygame primitives so it needs no font glyph: diamonds/hearts use one
        or two lobes plus a point; spades and clubs add a small stem at the base.
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
        """Draw a face-down card back: a gold lattice on deep blue with a gold rim and shadow."""
        radius = self._s(6)
        self._draw_card_shadow(surface, rect)
        pygame.draw.rect(surface, CARD_BACK, rect, border_radius=radius)
        inner = rect.inflate(self._s(-8), self._s(-10))
        pygame.draw.rect(surface, CARD_BACK_DARK, inner, border_radius=self._s(4))

        # Diagonal gold lattice, clipped to the inner panel.
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
        """Close the window if one was opened. Idempotent; never global-quits pygame.

        Only :func:`pygame.display.quit` is called — a global :func:`pygame.quit` would de-init
        the font module and break other envs/tests sharing the process.
        """
        if self._screen is not None:
            pygame.display.quit()
            self._screen = None
