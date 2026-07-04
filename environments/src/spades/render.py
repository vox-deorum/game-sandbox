"""The pygame renderer for four-player partnership Spades.

This module turns the per-step overlay from :func:`spades.overlay.extract_overlay` into a frame a
human can watch and play. The table, four seat badges, centre trick, fanned hand, opponent rows, and
card primitives are the shared :class:`~local_play.render_cards.CardTableRenderer`;
:class:`SpadesRenderer` subclasses it and draws what Spades adds on top: per-seat ``bid/won`` badges
with a NIL marker, the partnership tint, the two team scores styled so the partnership reads at a
glance, a spades-broken indicator, a phase indicator, and — during the bidding round — a clickable
row of bid chips ``0..13`` (``0`` labelled "NIL") in the centre well.

It never reaches into the live environment for game facts; everything drawn comes from the overlay,
so this renderer and the future browser renderer stay in lockstep on legality (both grey from the
same emitted mask).

Two render modes are supported. ``"rgb_array"`` draws only to an offscreen :class:`pygame.Surface`
and returns an ``(H, W, 3)`` uint8 array, so it works headless in CI with no display. ``"human"``
additionally opens a window and blits the same offscreen surface to it. Click-to-select is served by
:meth:`~local_play.render_cards.CardTableRenderer.card_at_pos` (cards) and
:meth:`SpadesRenderer.bid_action_at_pos` (bid chips), which hit-test a window pixel against the rects
recorded during the most recent render.
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

# Palette the bid chips / badges / status strip still reference directly, re-exported from the
# shared module so there is one source of truth for it.
GOLD = _cards.GOLD
GOLD_DIM = _cards.GOLD_DIM
WHITE = _cards.WHITE
DIM = _cards.DIM

#: Fixed window / frame dimensions in pixels (kept as module names for the harness and tests).
WIDTH, HEIGHT = CardTableRenderer.WIDTH, CardTableRenderer.HEIGHT

#: Spades-specific palette (the shared card/table colours live in the card-table renderer).
NIL_INK = (240, 176, 96)
#: The two partnership accent colours, so the team score line and badges read as two teams.
TEAM_TINT = {0: (108, 196, 236), 1: (236, 156, 120)}
CHIP_BG = (18, 66, 45)
CHIP_BG_HOVER = (30, 96, 66)
CHIP_EDGE = (120, 200, 150)


class SpadesRenderer(CardTableRenderer):
    """Draw a Spades hand to an offscreen surface (and optionally a window) from the overlay.

    The renderer is constructed once per environment and reused across steps. It inherits the shared
    card-table drawing and adds the Spades overlay source, the bid/won seat line with its partnership
    tint, the bid chips, and the team-score status strip. Pygame is initialized lazily on the first
    :meth:`~local_play.render_cards.CardTableRenderer.render`, so the module stays importable without
    a display, and a window opens only in ``"human"`` mode.
    """

    WINDOW_CAPTION = "Spades"
    # Spades' badges are a touch taller than Hearts', so the seats and the north opponent row sit a
    # little lower to clear the taller status strip.
    NORTH_BADGE_Y = 112
    OPPONENT_ROW_NORTH_Y = 166
    BADGE_W, BADGE_H = 168, 62
    # Seat the West/East name boxes this far in from the side edges so the edge card stacks (a 36px
    # inset, SMALL_W=48 wide) no longer overlay them; the shared default (130) sat under the cards.
    SIDE_BADGE_INSET = 176

    def __init__(self, render_mode: str) -> None:
        """Store ``render_mode`` (``"human"`` or ``"rgb_array"``); defer pygame init to render."""
        super().__init__(render_mode)
        #: (bid value, rect) for each drawn bid chip, or empty when not in the bidding phase.
        self._bid_rects: list[tuple[int, pygame.Rect]] = []

    # -- overlay + hooks -----------------------------------------------------------------------

    def _extract_overlay(self, env: Any) -> dict[str, Any]:
        """Return the per-step Spades overlay for ``env``."""
        return extract_overlay(env)

    def _legal_cards_from_overlay(self, overlay: dict) -> set[int]:
        """Return the legal *card* ids for the hand, dropping bid actions.

        ``legal_actions`` names cards only during play; during bidding it names bid actions
        (``>= 52``), so filtering to ``< NUM_CARDS`` leaves no legal card and every hand card greys —
        the correct read: you cannot play a card until you have bid.
        """
        return {a for a in overlay["legal_actions"] if a < rules.NUM_CARDS}

    def _draw_center(self, surface: pygame.Surface, overlay: dict, view_seat: int) -> None:
        """Draw the centre: the clickable bid chips during bidding, else the trick."""
        if overlay["phase"] == "bidding":
            self._draw_bid_chips(surface, overlay, view_seat)
        else:
            self._bid_rects = []
            self._draw_trick(surface, overlay, view_seat)

    # -- public hit-testing (bid chips) --------------------------------------------------------

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

    # -- seat interior -------------------------------------------------------------------------

    def _seat_anchor(self, slot: int) -> tuple[int, int]:
        """Place the badge for a slot, insetting the side seats so the edge cards don't overlay them.

        Only the West/East slots (``1``/``3``) move: they slide in from the shared 130px edge inset to
        :attr:`SIDE_BADGE_INSET` so the "P1"/"P3" name boxes clear the side card stacks. North/South
        keep the shared placement.
        """
        if slot in (1, 3):
            inset = self.SIDE_BADGE_INSET if slot == 1 else self.WIDTH - self.SIDE_BADGE_INSET
            return (self._s(inset), self._s(self.HEIGHT // 2))
        return super()._seat_anchor(slot)

    def _draw_seat_content(
        self,
        surface: pygame.Surface,
        overlay: dict,
        seat: int,
        view_seat: int,
        badge: pygame.Rect,
        highlight: bool,
    ) -> None:
        """Draw the partnership tab, the seat name, and its ``bid/won`` line inside the badge."""
        cx, cy = badge.center
        # A short partnership tab down the badge's left edge, so the two teams read at a glance.
        tint = TEAM_TINT[rules.team_of(seat)]
        tab = pygame.Rect(
            badge.left + self._s(5), badge.top + self._s(9), self._s(4), badge.height - self._s(18)
        )
        pygame.draw.rect(surface, tint, tab, border_radius=self._s(2))

        you = "  (you)" if seat == view_seat else ""
        label = self._font.render(f"P{seat}{you}", True, WHITE)
        surface.blit(label, label.get_rect(center=(cx, cy - self._s(12))))
        self._draw_bid_won(
            surface,
            seat,
            overlay["bids"][seat],
            overlay["tricks_won"][seat],
            (cx, cy + self._s(14)),
            highlight,
        )

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

    #: Bid chips are laid out in this many columns; the 14 bids (NIL..13) wrap into two rows.
    BID_CHIP_COLS = 7

    def _draw_bid_chips(self, surface: pygame.Surface, overlay: dict, view_seat: int) -> None:
        """Draw the clickable grid of bid chips ``0..13`` in the centre well (``0`` labelled NIL).

        The chips wrap into a compact ``7 x 2`` grid (``NIL..6`` on top, ``7..13`` below) so the block
        stays clear of the side card stacks instead of running edge to edge. They are the view seat's
        affordance during bidding; their rects are recorded for hit-testing. When it is not the view
        seat's turn the chips still draw (so the table reads), but the human controller only accepts a
        click on its own turn.
        """
        self._bid_rects = []
        center_y = self._s(HEIGHT // 2)
        chip_w, chip_h = self._s(50), self._s(52)
        gap = self._s(4)
        vgap = self._s(8)
        count = rules.NUM_BIDS
        cols = self.BID_CHIP_COLS
        rows = (count + cols - 1) // cols
        run = cols * chip_w + (cols - 1) * gap
        start_x = (self._s(WIDTH) - run) // 2
        block_h = rows * chip_h + (rows - 1) * vgap
        start_y = center_y - block_h // 2
        view_turn = overlay["turn"] == view_seat and not overlay["terminal"]

        prompt = "Choose your bid" if view_turn else f"P{overlay['turn']} is bidding"
        p_img = self._font.render(prompt, True, GOLD if view_turn else WHITE)
        surface.blit(p_img, p_img.get_rect(center=(self._s(WIDTH // 2), start_y - self._s(26))))

        mouse = pygame.mouse.get_pos() if self.render_mode == "human" else (-1, -1)
        for bid in range(count):
            col, row = bid % cols, bid // cols
            rect = pygame.Rect(
                start_x + col * (chip_w + gap), start_y + row * (chip_h + vgap), chip_w, chip_h
            )
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
        """Pop a compact ``won/bid`` pill (e.g. "3/4") above the winner's seat during the sweep.

        ``tricks_won[winner]`` already counts the just-won trick, so it reads "now 3 of your bid 4";
        a nil bid is ``0``, so a nil-breaker naturally shows "1/0".
        """
        won = overlay["tricks_won"][winner]
        bid = overlay["bids"][winner]
        self._draw_pill(surface, f"{won}/{bid}", anchor, t, hold)

    # -- status strip --------------------------------------------------------------------------

    def _draw_status(self, surface: pygame.Surface, overlay: dict, view_seat: int) -> None:
        """Draw the constant two-row status strip across the top of the table.

        Primary row: the phase / trick number, a spade pip for the spades-broken flag, and a state
        message (whose turn / who took the trick / game over). Second row: the two team scores,
        styled by partnership. The strip is always present.
        """
        w = self._s(WIDTH)
        strip_h = self._s(55)
        panel = pygame.Surface((w, strip_h), pygame.SRCALPHA)
        panel.fill((0, 0, 0, 104))
        surface.blit(panel, (0, 0))
        pygame.draw.line(surface, GOLD_DIM, (0, strip_h), (w, strip_h), max(1, self._s(1)))

        terminal = overlay["terminal"]
        bidding = overlay["phase"] == "bidding"
        row1_y = self._s(7)
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

        # Second row: the two team scores, each tinted with its partnership colour. The gap below the
        # primary row is a little wider than the text stack strictly needs, so the two rows sit evenly
        # in the trimmed strip rather than bunching at the top.
        self._draw_team_scores(surface, overlay, view_seat, row1_y + t1.get_height() + self._s(8))

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
        # A trick that has been swept to its winner (human mode): name who took it. The last_trick
        # guard keeps this off during the opening bid round (last_trick is None until a trick lands).
        if (
            self.render_mode == "human"
            and not overlay["current_trick"]
            and overlay["last_trick"] is not None
            and overlay["last_trick_winner"] is not None
            and overlay["tricks_played"] == self._animated_tricks
        ):
            winner = overlay["last_trick_winner"]
            who = "You" if winner == view_seat else f"P{winner}"
            return f"{who} took the trick", GOLD
        turn = overlay["turn"]
        verb = "to bid" if overlay["phase"] == "bidding" else "to play"
        if turn == view_seat:
            return ("Your bid" if overlay["phase"] == "bidding" else "Your turn"), GOLD
        return f"P{turn} {verb}", WHITE
