"""The shared four-seat card-table renderer for the local pygame play windows.

:class:`CardTableRenderer` extends :class:`local_play.render_base.PygameRenderer` with everything a
trick-taking card game draws the same way: the felt table background, the four N/E/S/W seat badges,
the growing centre trick, the view seat's fanned hand (legal cards raised and ringed, illegal cards
greyed), the face-down opponent rows, and the card primitives (antialiased suit pips, corner
indices, card backs) — plus the click hit-testing over the hand. Concrete games (Hearts, Spades)
subclass it and fill in only what differs: the overlay source, the seat-badge interior, the status
strip, and any extra centre content (Spades' bidding chips).

The card *encoding* is baked in as canonical defaults — ``suit_of``/``rank_of`` and the suit ids —
so a subclass inherits the standard ``card = suit * 13 + rank`` layout for free, yet may override
any of them if a future game numbers its deck differently. Per-game geometry that is *almost* the
same (the north badge's y, the north opponent row's y, the badge size) is exposed as class
attributes so a subclass tweaks a number rather than re-copying a method.

Like the base, this module imports only third-party packages (``pygame``, ``numpy``) and its
sibling :mod:`local_play.render_base` (relatively), never the harness, so ``scripts/generate.py``
syncs it verbatim into the student template as ``sandbox.render_cards``.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pygame

from .card_utils import card_from_obj
from .render_base import PygameRenderer

#: Card-face dimensions for the view seat's fanned hand.
CARD_W, CARD_H = 64, 92
#: Smaller card-face dimensions for trick cards and revealed opponent hands.
SMALL_W, SMALL_H = 48, 70
#: How far (logical px) a hovered hand card lifts, so the human sees which card is under the cursor.
HOVER_LIFT = 8

#: Supersampling factor for suit pips: each pip is drawn this many times larger and smoothscaled
#: back down, so pygame's non-antialiased ``draw`` primitives still yield smooth edges. 4x is the
#: sweet spot — visibly smooth without paying for a much larger scratch surface.
SUIT_SS = 4
#: Padding (device px) added around a pip's scratch surface so its widest lobes never clip.
_SUIT_PAD = 2

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


def card_key(card: dict[str, int]) -> int:
    """Return a stable, unique identity (``0..51`` engine id) for a semantic card object.

    Cards flow as ``{"suit", "rank"}`` objects (face rank ``2..14``) through drawing, animation, and
    hit testing; this is the one place they are collapsed to a hashable int, used only where a
    map/set identity is needed (legal sets, matching a card across frames, hidden-card gaps) — never
    for drawing, which reads ``suit``/``rank`` straight off the object. Delegates to the shared codec
    so the object-to-id collapse lives in exactly one place.
    """
    return card_from_obj(card)


class CardTableRenderer(PygameRenderer):
    """Draw a four-seat trick-taking table to an offscreen surface (and optionally a window).

    The renderer is constructed once per environment and reused across steps. Subclasses implement
    :meth:`_extract_overlay`, :meth:`_draw_seat_content`, and :meth:`_draw_status`, and may override
    the codec attributes, the geometry hooks, ``_draw_center`` / ``_legal_cards_from_overlay``, or the
    :meth:`_draw_trick_won_badge` hook to add game-specific behaviour.

    The human-mode card fly-in and trick-won sweep animations live here too (see :meth:`_before_draw`
    and the ``_animate_*`` helpers), so both card games share one animation engine; the only per-game
    piece is the small pill drawn above the winner, supplied by :meth:`_draw_trick_won_badge`. In
    ``rgb_array`` mode the animations never run, so headless frames stay deterministic.
    """

    # -- per-game geometry hooks (defaults are the Hearts values) ------------------------------
    #: Y of the North seat badge's centre (just below the status strip).
    NORTH_BADGE_Y = 96
    #: Y of the North opponent row (just under the top seat badge).
    OPPONENT_ROW_NORTH_Y = 150
    #: Seat-badge size in logical px.
    BADGE_W, BADGE_H = 158, 56

    # -- card codec (canonical defaults; a subclass may override) -------------------------------
    #: Number of seats at the table.
    NUM_PLAYERS = 4
    #: Suit ids (the high part of the ``card = suit * 13 + rank`` encoding).
    CLUBS, DIAMONDS, SPADES, HEARTS = 0, 1, 2, 3
    #: Rank labels indexed by rank id ``0..12`` (``0`` is the 2, ``12`` the ace). Cards carry the FACE
    #: rank (``2..14``), so a lookup is ``RANK_LABELS[card["rank"] - 2]``.
    RANK_LABELS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"]

    def __init__(self, render_mode: str) -> None:
        """Store ``render_mode`` and the shared per-frame draw state; defer pygame init to render."""
        super().__init__(render_mode)
        #: Cached opaque table background (gradient + vignette + central well); built once.
        self._bg: pygame.Surface | None = None
        #: (card object, rect) for each drawn hand card, in draw order (left to right).
        self._hand_rects: list[tuple[dict[str, int], pygame.Rect]] = []
        #: Legal card KEYS (see :func:`card_key`) from the most recent render, for click acceptance.
        self._legal_cards: set[int] = set()
        #: The hand card object to highlight on the next render (human hover feedback), or None. Stays
        #: None in rgb_array mode, so headless frames are byte-identical.
        self._hovered_card: dict[str, int] | None = None
        #: Cache of antialiased suit pips keyed by (suit, size, ink); a handful of distinct sizes
        #: and inks recur every frame, so this turns the per-pip supersample into a one-time cost.
        self._pip_cache: dict[tuple[int, int, tuple[int, int, int]], pygame.Surface] = {}
        # Bound in _ensure_init(); declared here with its concrete type (not None) so the winner-pill
        # draw helper sees Font, not Font | None.
        self._font_big: pygame.font.Font
        #: Count of completed tricks whose win animation has already played (human mode only).
        self._animated_tricks: int = 0
        #: The previously rendered overlay (human mode only), so the card fly-in knows where each card
        #: was last drawn.
        self._prev_overlay: dict[str, Any] | None = None

    def _ensure_init(self) -> None:
        """Initialize the shared fonts/surface plus the big font used by the winner pill."""
        if self._inited:
            return
        super()._ensure_init()
        self._font_big = pygame.font.Font(None, self._s(34))

    # -- public hit-testing helpers ------------------------------------------------------------

    def card_at_pos(self, pos: tuple[int, int]) -> dict[str, int] | None:
        """Return the view-seat card OBJECT under window pixel ``pos``, or ``None`` if none.

        Hand cards overlap, so the rects are scanned in reverse draw order (the visually
        front-most / right-most card first) so the card a human sees on top wins. Legality is
        ignored here; the caller decides whether to accept the click.
        """
        for card, rect in reversed(self._hand_rects):
            if rect.collidepoint(pos):
                return card
        return None

    def card_rect(self, card: dict[str, int]) -> pygame.Rect | None:
        """Return the rect drawn for ``card`` in the view seat's hand, or ``None`` if absent."""
        key = card_key(card)
        for drawn_card, rect in self._hand_rects:
            if card_key(drawn_card) == key:
                return rect
        return None

    def is_legal_card(self, card: dict[str, int]) -> bool:
        """Return whether ``card`` was legal in the most recently rendered frame."""
        return card_key(card) in self._legal_cards

    def set_hover(self, card: dict[str, int] | None) -> None:
        """Set the hand card to highlight on the next render (human hover feedback), or ``None``.

        The human controller calls this each frame with the card under the cursor; the browser gets
        the same affordance from PixiJS pointer events. Hover is human-mode chrome only — it never
        changes the rgb_array frame (``_hovered_card`` stays ``None`` there).
        """
        self._hovered_card = card

    # -- rendering (template method) -----------------------------------------------------------

    def render(self, env: Any) -> np.ndarray | None:
        """Draw the current state of ``env`` and return an rgb array (rgb_array) or ``None``.

        ``env.view_seat`` (default ``0``) is the seat shown at the bottom and the one whose hand
        is fanned and clickable. ``env.reveal_all`` (default ``False``) draws every seat's faces
        for spectating/replay; otherwise the three opponents are face-down.

        The draw order is fixed (table, seats, centre, opponents, hand, status); subclasses vary it
        only through the hooks (:meth:`_before_draw`, :meth:`_draw_center`, :meth:`_draw_seat_content`,
        :meth:`_draw_status`).
        """
        self._ensure_init()
        overlay = self._extract_overlay(env)
        view_seat = int(getattr(env, "view_seat", 0))
        reveal_all = bool(getattr(env, "reveal_all", False))

        surface = self._surface
        assert surface is not None

        self._before_draw(env, overlay, view_seat, reveal_all)

        self._draw_table(surface)
        self._draw_seats(surface, overlay, view_seat)
        self._draw_center(surface, overlay, view_seat)
        self._draw_opponents(surface, overlay, view_seat, reveal_all)
        self._draw_hand(surface, overlay, view_seat)
        self._draw_status(surface, overlay, view_seat)

        return self._finish_frame(surface)

    # -- subclass hooks ------------------------------------------------------------------------

    def _extract_overlay(self, env: Any) -> dict[str, Any]:
        """Return the per-step overlay dict for ``env``. Abstract: the shared module cannot import
        a game's ``overlay.py``, so each subclass supplies its own extractor."""
        raise NotImplementedError

    def _before_draw(self, env: Any, overlay: dict, view_seat: int, reveal_all: bool) -> None:
        """Run the human-mode card/trick animations from the previous overlay before the static frame.

        Resets the animation state on a fresh deal, then (human mode only) animates the move from the
        previous overlay to this one and remembers this overlay for the next diff. A card fly-in runs
        for the just-played card, chaining into the trick-won sweep when it was a trick's fourth card.
        The headless ``rgb_array`` path animates nothing and stays a single deterministic frame.
        """
        tricks_played = overlay["tricks_played"]
        if tricks_played < self._animated_tricks:
            self._animated_tricks = 0  # a fresh deal rewound the trick count
            self._prev_overlay = None  # ...and there is no prior frame to animate from
        if self.render_mode == "human":
            self._animate_transition(overlay, view_seat, reveal_all, tricks_played)
            self._prev_overlay = overlay

    def _draw_center(self, surface: pygame.Surface, overlay: dict, view_seat: int) -> None:
        """Draw the centre of the table. Default: the in-progress (or completed) trick."""
        self._draw_trick(surface, overlay, view_seat)

    def _suppress_completed_trick(self, overlay: dict) -> bool:
        """Keep the centre clear once a completed trick has been swept to its winner (human mode).

        The cards are "with" the winner now, so the centre stays clear through the post-trick pause.
        The headless rgb_array path never suppresses, so it always shows the completed trick.
        """
        return self.render_mode == "human" and overlay["tricks_played"] == self._animated_tricks

    def _draw_trick_won_badge(
        self,
        surface: pygame.Surface,
        overlay: dict,
        winner: int,
        anchor: tuple[int, int],
        t: float,
        hold: float,
    ) -> None:
        """Draw a game-specific flourish above the winner's seat during the trick-won sweep.

        Called every sweep frame with the sweep's ``t`` / ``hold`` so the badge can scale itself in
        via :meth:`_draw_pill`. Default: nothing. Hearts draws its ``+N`` points pill; Spades draws
        its ``won/bid`` pill.
        """

    def _legal_cards_from_overlay(self, overlay: dict) -> set[int]:
        """Return the legal-card KEYS (see :func:`card_key`) to treat as legal in the hand.

        Default: every card in ``overlay["legal_cards"]``. Spades' ``legal_cards`` is already empty
        during bidding (bids are a separate ``legal_bids`` key), so no override is needed there.
        """
        return {card_key(c) for c in overlay["legal_cards"]}

    def _draw_seat_content(
        self,
        surface: pygame.Surface,
        overlay: dict,
        seat: int,
        view_seat: int,
        badge: pygame.Rect,
        highlight: bool,
    ) -> None:
        """Draw the interior of a seat badge (name + game-specific line). Abstract."""
        raise NotImplementedError

    def _draw_status(self, surface: pygame.Surface, overlay: dict, view_seat: int) -> None:
        """Draw the top status strip. Abstract: the strip is fully game-specific."""
        raise NotImplementedError

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
        w, h = self._s(self.WIDTH), self._s(self.HEIGHT)
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
            0: (self._s(self.WIDTH // 2), self._s(self.HEIGHT - 150)),  # South (view seat)
            1: (self._s(130), self._s(self.HEIGHT // 2)),  # West
            2: (self._s(self.WIDTH // 2), self._s(self.NORTH_BADGE_Y)),  # North (below the strip)
            3: (self._s(self.WIDTH - 130), self._s(self.HEIGHT // 2)),  # East
        }
        return anchors[slot]

    def _slot_of_seat(self, seat: int, view_seat: int) -> int:
        """Map an absolute ``seat`` to a screen slot (``0=S,1=W,2=N,3=E``) with view at South."""
        return (seat - view_seat) % self.NUM_PLAYERS

    def _draw_seats(
        self, surface: pygame.Surface, overlay: dict, view_seat: int, winner_flash: int | None = None
    ) -> None:
        """Draw each seat's badge and the glow on the active seat; fill the interior via the hook.

        The active seat's halo breathes (a gold pulse) in human mode. ``winner_flash`` is set by a
        subclass's sweep animation to flash the trick winner's badge at full intensity. The badge's
        interior (name, scores/bids) is delegated to :meth:`_draw_seat_content`.
        """
        turn = overlay["turn"]
        terminal = overlay["terminal"]
        for seat in range(self.NUM_PLAYERS):
            slot = self._slot_of_seat(seat, view_seat)
            cx, cy = self._seat_anchor(slot)
            badge = pygame.Rect(0, 0, self._s(self.BADGE_W), self._s(self.BADGE_H))
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

            self._draw_seat_content(surface, overlay, seat, view_seat, badge, highlight)

    # -- trick (centre) ------------------------------------------------------------------------

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

        A subclass may suppress redrawing a completed trick (see :meth:`_suppress_completed_trick`)
        once it has swept the cards to the winner; otherwise the completed trick is always shown.
        """
        center = (self._s(self.WIDTH // 2), self._s(self.HEIGHT // 2))
        trick = overlay["current_trick"]
        winner = None
        if not trick:
            if overlay["last_trick"] is None:
                return
            if self._suppress_completed_trick(overlay):
                return
            trick = overlay["last_trick"]
            winner = overlay["last_trick_winner"]
        for entry in trick:
            seat, card = entry["seat"], entry["card"]
            slot = self._slot_of_seat(seat, view_seat)
            dx, dy = self._trick_offset(slot)
            rect = pygame.Rect(0, 0, self._s(SMALL_W), self._s(SMALL_H))
            rect.center = (center[0] + dx, center[1] + dy)
            highlight = WINNER_GLOW if winner is not None and seat == winner else None
            self._draw_card_face(surface, rect, card, self._font_small, border=highlight, border_w=4)

    # -- card layout (the single source of the fan / opponent-row geometry) ---------------------

    def _hand_layout(
        self, hand: list[dict[str, int]], legal_keys: set[int]
    ) -> list[tuple[dict[str, int], pygame.Rect]]:
        """Resting rect of every card in the view seat's fanned hand, in draw order (no hover lift).

        The one place the bottom fan's geometry is computed, reused by :meth:`_draw_hand` (drawing and
        the ``_hand_rects`` it records for hit-testing) and any fly-in origin, so a card flies from
        exactly where it was drawn. Legal cards (matched by :func:`card_key` against ``legal_keys``)
        sit a few px higher (a selectable cue).
        """
        count = len(hand)
        if count == 0:
            return []
        card_w, card_h = self._s(CARD_W), self._s(CARD_H)
        margin = self._s(40)
        avail = self._s(self.WIDTH) - 2 * margin
        # Overlap as needed so all cards fit within the available width.
        step = min(card_w + self._s(6), (avail - card_w) // (count - 1)) if count > 1 else 0
        run = step * (count - 1) + card_w
        start_x = (self._s(self.WIDTH) - run) // 2
        base_y = self._s(self.HEIGHT) - card_h - self._s(18)
        layout: list[tuple[dict[str, int], pygame.Rect]] = []
        for i, card in enumerate(hand):
            x = start_x + i * step
            # Raise legal cards a few px so they read as selectable.
            y = base_y - (self._s(10) if card_key(card) in legal_keys else 0)
            layout.append((card, pygame.Rect(x, y, card_w, card_h)))
        return layout

    def _opponent_row_layout(
        self, slot: int, hand: list[dict[str, int]]
    ) -> list[tuple[dict[str, int], pygame.Rect]]:
        """Rect of every card in an opponent's row along their table edge, in deal order.

        The one place the opponent-row geometry is computed, reused by :meth:`_draw_opponent_row` and
        any fly-in origin so an opponent's card flies from exactly where its back/face was drawn.
        """
        count = len(hand)
        if count == 0:
            return []
        vertical = slot in (1, 3)  # West / East sit along the side edges.
        small_w, small_h = self._s(SMALL_W), self._s(SMALL_H)
        span = self._s(self.HEIGHT if vertical else self.WIDTH) - self._s(360)
        step = min(small_w - self._s(14), span // max(count, 1)) if count > 1 else 0
        run = step * (count - 1) + small_w
        if vertical:
            x = self._s(36) if slot == 1 else self._s(self.WIDTH) - self._s(36) - small_w
            start = (self._s(self.HEIGHT) - run) // 2
            positions = [(x, start + i * step) for i in range(count)]
        else:
            y = self._s(self.OPPONENT_ROW_NORTH_Y)  # North row sits just under the top seat badge.
            start = (self._s(self.WIDTH) - run) // 2
            positions = [(start + i * step, y) for i in range(count)]
        return [
            (card, pygame.Rect(px, py, small_w, small_h))
            for card, (px, py) in zip(hand, positions, strict=False)
        ]

    def _draw_opponents(
        self,
        surface: pygame.Surface,
        overlay: dict,
        view_seat: int,
        reveal_all: bool,
        hidden_card: dict[str, int] | None = None,
    ) -> None:
        """Draw the three non-view seats: face-down backs, or small faces when ``reveal_all``.

        ``hidden_card`` (set during a fly-in) is skipped so its slot stays a placeholder gap while the
        layout keeps the full count, so the row does not re-pack while one card flies out.
        """
        for seat in range(self.NUM_PLAYERS):
            if seat == view_seat:
                continue
            slot = self._slot_of_seat(seat, view_seat)
            hand = overlay["hands"][seat]
            self._draw_opponent_row(surface, slot, hand, reveal_all, hidden_card)

    def _draw_opponent_row(
        self,
        surface: pygame.Surface,
        slot: int,
        hand: list[dict[str, int]],
        reveal_all: bool,
        hidden_card: dict[str, int] | None = None,
    ) -> None:
        """Lay an opponent's cards out along their table edge (backs unless revealing)."""
        hidden_key = None if hidden_card is None else card_key(hidden_card)
        for card, rect in self._opponent_row_layout(slot, hand):
            if hidden_key is not None and card_key(card) == hidden_key:
                continue  # placeholder gap during the fly-in (the flyer represents this card)
            if reveal_all:
                self._draw_card_face(surface, rect, card, self._font_small)
            else:
                self._draw_card_back(surface, rect)

    def _draw_hand(
        self,
        surface: pygame.Surface,
        overlay: dict,
        view_seat: int,
        hidden_card: dict[str, int] | None = None,
    ) -> None:
        """Fan the view seat's hand across the bottom, highlighting legal and greying illegal.

        The legal set comes from :meth:`_legal_cards_from_overlay` (a hook, so Spades can drop bid
        actions during bidding). ``hidden_card`` (set during a fly-in) is skipped so its slot stays a
        placeholder gap while the layout keeps the full count, so the fan does not re-pack while one
        card flies out.
        """
        self._hand_rects = []
        self._legal_cards = self._legal_cards_from_overlay(overlay)
        hidden_key = None if hidden_card is None else card_key(hidden_card)
        for card, rect in self._hand_layout(list(overlay["hands"][view_seat]), self._legal_cards):
            if hidden_key is not None and card_key(card) == hidden_key:
                continue  # placeholder gap during the fly-in (the flyer represents this card)
            # Record the resting rect for hit-testing before any hover lift, so hover never shifts the
            # click target (which would make the highlight flicker at a card's edge).
            self._hand_rects.append((card, rect))
            key = card_key(card)
            legal = key in self._legal_cards
            # Hover (human chrome; _hovered_card is None in rgb_array, so headless frames are unchanged):
            # lift the hovered card and ring it gold, mirroring the browser hover ring.
            hovered = self._hovered_card is not None and key == card_key(self._hovered_card)
            draw_rect = rect.move(0, -self._s(HOVER_LIFT)) if hovered else rect
            border = LEGAL_BORDER if legal else None
            self._draw_card_face(surface, draw_rect, card, self._font, border=border, border_w=4)
            if not legal:
                veil = pygame.Surface((rect.width, rect.height), pygame.SRCALPHA)
                veil.fill(GREY_VEIL)
                surface.blit(veil, draw_rect.topleft)
            if hovered:
                self._draw_glow_border(surface, draw_rect, GOLD, 4, 1.0)

    # -- card-play and trick-won animations (human mode only) ----------------------------------

    @staticmethod
    def _smoothstep(t: float) -> float:
        """Clamp ``t`` to ``[0, 1]`` and apply the classic smoothstep ease."""
        t = max(0.0, min(1.0, t))
        return t * t * (3.0 - 2.0 * t)

    def _animate_transition(
        self, overlay: dict, view_seat: int, reveal_all: bool, tricks_played: int
    ) -> None:
        """Animate the move from the previous overlay to this one (human mode).

        A card fly-in runs for the just-played card; when that play was a trick's fourth card it
        resolves the trick in the same step, so the fly-in chains into the trick-won sweep. Either
        piece is a no-op when not applicable, so a fresh deal or a repeated frame animates nothing.
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

    def _detect_play(
        self, overlay: dict
    ) -> tuple[int, dict[str, int], list[tuple[int, dict[str, int]]]] | None:
        """Return ``(seat, card, resting_pairs)`` for the card just played versus the previous
        overlay, or ``None``. Either one new pair was appended to the in-progress trick (cards 1–3),
        or the trick count went up and the new card shows only in the completed ``last_trick`` (the
        fourth card). Whether that play *completed* the trick — and so chains into the sweep — is
        decided separately by :meth:`_animate_transition` (``newly_completed``), so it is not carried
        here.
        """
        prev = self._prev_overlay
        if prev is None:
            return None
        p_trick = prev["current_trick"]
        n_trick = overlay["current_trick"]
        p_tricks = prev["tricks_played"]
        n_tricks = overlay["tricks_played"]
        if n_tricks == p_tricks and len(n_trick) == len(p_trick) + 1:
            entry = n_trick[-1]
            seat, card = entry["seat"], entry["card"]
            resting = [(e["seat"], e["card"]) for e in p_trick]
            return int(seat), card, resting
        if not n_trick and overlay["last_trick"] is not None and n_tricks == p_tricks + 1:
            resting_keys = {card_key(e["card"]) for e in p_trick}
            played = [e for e in overlay["last_trick"] if card_key(e["card"]) not in resting_keys]
            if not played:
                return None
            entry = played[0]
            seat, card = entry["seat"], entry["card"]
            resting = [(e["seat"], e["card"]) for e in p_trick]
            return int(seat), card, resting
        return None

    def _play_source(
        self, prev: dict, view_seat: int, seat: int, card: dict[str, int]
    ) -> tuple[int, int, int, int]:
        """Device-pixel centre and size ``(cx, cy, w, h)`` of ``card`` as it was drawn for ``seat`` in
        the previous overlay: the view seat's fanned hand, or an opponent row. Reuses the shared
        layout helpers (:meth:`_hand_layout` / :meth:`_opponent_row_layout`) so the source matches the
        actual draw to the pixel. Falls back to the seat badge if the card can't be located (defensive).
        """
        key = card_key(card)
        if seat == view_seat:
            layout = self._hand_layout(list(prev["hands"][view_seat]), self._legal_cards_from_overlay(prev))
        else:
            slot = self._slot_of_seat(seat, view_seat)
            layout = self._opponent_row_layout(slot, list(prev["hands"][seat]))
        for drawn_card, rect in layout:
            if card_key(drawn_card) == key:
                return rect.centerx, rect.centery, rect.width, rect.height
        ax, ay = self._seat_anchor(self._slot_of_seat(seat, view_seat))
        return ax, ay, self._s(SMALL_W), self._s(SMALL_H)

    def _animate_card_played(
        self,
        overlay: dict,
        view_seat: int,
        reveal_all: bool,
        play: tuple[int, dict[str, int], list[tuple[int, dict[str, int]]]],
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
        center = (self._s(self.WIDTH // 2), self._s(self.HEIGHT // 2))
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

        center = (self._s(self.WIDTH // 2), self._s(self.HEIGHT // 2))
        win_anchor = self._seat_anchor(self._slot_of_seat(winner, view_seat))
        cards: list[tuple[int, dict[str, int], tuple[int, int]]] = []
        for entry in trick:
            seat, card = entry["seat"], entry["card"]
            dx, dy = self._trick_offset(self._slot_of_seat(seat, view_seat))
            cards.append((seat, card, (center[0] + dx, center[1] + dy)))

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

            self._draw_trick_won_badge(surface, overlay, winner, win_anchor, t, hold)

            screen.blit(surface, (0, 0))
            pygame.event.pump()
            pygame.display.flip()
            clock.tick(60)

    def _draw_pill(
        self, surface: pygame.Surface, text: str, anchor: tuple[int, int], t: float, hold: float
    ) -> None:
        """Draw a rounded gold pill showing ``text`` above the winner's seat; it scales in during the
        hold. Shared by the games' trick-won badges (Hearts' ``+N`` points, Spades' ``won/bid``).
        """
        img = self._font_big.render(text, True, (32, 24, 18))
        pad = self._s(13)
        pill = pygame.Surface((img.get_width() + pad * 2, img.get_height() + self._s(8)), pygame.SRCALPHA)
        rrect = pill.get_rect()
        radius = rrect.height // 2
        pygame.draw.rect(pill, (*GOLD, 236), rrect, border_radius=radius)
        pygame.draw.rect(pill, (255, 244, 206), rrect, width=max(1, self._s(2)), border_radius=radius)
        pill.blit(img, img.get_rect(center=rrect.center))

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
        card: dict[str, int],
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

        suit = card["suit"]
        ink = RED_INK if suit in (self.DIAMONDS, self.HEARTS) else BLACK_INK
        rank_str = self.RANK_LABELS[card["rank"] - 2]
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

        if suit == self.DIAMONDS:
            hw, hh = size * 0.36, size * 0.5
            pygame.draw.polygon(
                surface,
                ink,
                [(cx, int(cy - hh)), (int(cx + hw), cy), (cx, int(cy + hh)), (int(cx - hw), cy)],
            )
            return

        if suit == self.HEARTS:
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

        if suit == self.SPADES:
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
