"""The pure rules engine for four-player Hearts.

This module is the single source of truth for card legality and scoring. It is deliberately
dependency-free — it imports only the standard library — so the same rules can drive the
PettingZoo environment, a reference bot, the renderer, and any tests without dragging in
``pettingzoo``/``pygame``/``numpy``. Everything is expressed over the fixed integer card
encoding below, which downstream code relies on verbatim.

Card encoding (fixed): a card is an int ``0..51`` with ``card = suit * 13 + rank``. Suits are
``0=clubs, 1=diamonds, 2=spades, 3=hearts`` and ranks run ``0=2 .. 8=10, 9=J, 10=Q, 11=K,
12=A``. So ``2♣ == 0`` and ``Q♠ == 36``. Seats are ints ``0..3`` and the next seat clockwise
is ``(seat + 1) % 4``.
"""

from __future__ import annotations

import importlib
import random
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any


def _shared_card_utils() -> Any:
    """Return the shared :mod:`card_utils` under whichever name this file runs as.

    One source syncs into two layouts: :mod:`local_play.card_utils` inside the environments package,
    ``sandbox.card_utils`` in a composed template. A :class:`ModuleNotFoundError` naming the absent
    candidate is swallowed; one naming a real dependency is re-raised. This keeps the pure engine
    dependency-free while sharing one card encoding.
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

#: Suit ids, deck size, and the suit/rank codec, re-exported from the shared codec so the engine and
#: every reader share one encoding. The engine compares on the rank *index* (``0..12``, queen ``10``).
NUM_CARDS = _cu.NUM_CARDS
CLUBS = _cu.CLUBS
DIAMONDS = _cu.DIAMONDS
SPADES = _cu.SPADES
HEARTS = _cu.HEARTS
suit_of = _cu.suit_of
rank_of = _cu.rank_of

#: Number of seats at the table.
NUM_PLAYERS = 4
#: Cards dealt to each seat.
HAND_SIZE = 13
#: Tricks played in a full hand.
NUM_TRICKS = 13

#: The card that must lead the very first trick.
TWO_OF_CLUBS = 0
#: The 13-point penalty card.
QUEEN_OF_SPADES = 36


def card_points(card: int) -> int:
    """Return the penalty points a card is worth: 13 for ``Q♠``, 1 per heart, else 0."""
    if card == QUEEN_OF_SPADES:
        return 13
    if suit_of(card) == HEARTS:
        return 1
    return 0


@dataclass
class HeartsState:
    """The full mutable game state for one hand of Hearts.

    ``hands`` are kept sorted ascending. ``current_trick`` holds ``(seat, card)`` pairs in
    play order and is empty between tricks. ``taken`` accumulates the cards each seat has won
    in resolved tricks, which is all that scoring and shoot-the-moon detection need.
    """

    hands: list[list[int]]
    current_trick: list[tuple[int, int]] = field(default_factory=list)
    trick_leader: int = 0
    turn: int = 0
    hearts_broken: bool = False
    tricks_played: int = 0
    taken: list[list[int]] = field(default_factory=lambda: [[], [], [], []])
    last_trick: list[tuple[int, int]] | None = None
    last_trick_winner: int | None = None


def deal(rng: random.Random) -> HeartsState:
    """Shuffle a fresh deck with ``rng`` and deal a new hand, with 2♣ to lead."""
    deck = list(range(NUM_CARDS))
    rng.shuffle(deck)
    hands = [sorted(deck[seat * HAND_SIZE : (seat + 1) * HAND_SIZE]) for seat in range(NUM_PLAYERS)]
    leader = next(seat for seat in range(NUM_PLAYERS) if TWO_OF_CLUBS in hands[seat])
    return HeartsState(
        hands=hands,
        current_trick=[],
        trick_leader=leader,
        turn=leader,
        hearts_broken=False,
        tricks_played=0,
        taken=[[], [], [], []],
        last_trick=None,
        last_trick_winner=None,
    )


def led_suit(state: HeartsState) -> int | None:
    """Return the suit led in the current trick, or ``None`` if no card has been played yet."""
    if not state.current_trick:
        return None
    return suit_of(state.current_trick[0][1])


def legal_moves(state: HeartsState, seat: int) -> list[int]:
    """Return the sorted list of cards ``seat`` may legally play right now.

    Enforces the opening 2♣ lead, following suit, the hearts-not-broken lead restriction, and
    the no-penalty-cards-on-the-first-trick rule, with the standard escape valves so the
    result is never empty for a seat that still holds cards.
    """
    hand = state.hands[seat]
    if not hand:
        return []

    # Rule 1: the very first play of the game must be exactly the 2♣.
    if state.tricks_played == 0 and not state.current_trick:
        return [TWO_OF_CLUBS]

    led = led_suit(state)
    if led is not None:
        # Rule 2: must follow the led suit if able.
        same_suit = [card for card in hand if suit_of(card) == led]
        candidates = same_suit if same_suit else list(hand)
    else:
        # Rule 3: leading. Hearts are barred until broken, unless the hand is all hearts.
        non_hearts = [card for card in hand if suit_of(card) != HEARTS]
        candidates = list(hand) if state.hearts_broken or not non_hearts else non_hearts

    # Rule 4: no hearts or Q♠ on the first trick, unless that would leave nothing to play.
    if state.tricks_played == 0:
        non_penalty = [card for card in candidates if card_points(card) == 0]
        if non_penalty:
            candidates = non_penalty

    return sorted(candidates)


def is_legal(state: HeartsState, seat: int, card: int) -> bool:
    """Return whether ``seat`` may legally play ``card`` in the current state."""
    return card in legal_moves(state, seat)


def lowest_legal_card(state: HeartsState, seat: int) -> int:
    """Return the legal card with the lowest rank (ties broken by suit). The timeout default."""
    return min(legal_moves(state, seat), key=lambda card: (rank_of(card), suit_of(card)))


def play(state: HeartsState, card: int) -> None:
    """Apply ``card`` as the play of ``state.turn``, resolving the trick when it completes.

    The caller is expected to have validated legality; the assertion below is a defensive
    guard, not the primary check.
    """
    seat = state.turn
    assert is_legal(state, seat, card), (seat, card)

    state.hands[seat].remove(card)
    state.current_trick.append((seat, card))
    # Variant choice: only a heart breaks hearts. Playing the Q♠ does NOT break hearts here, even
    # though it is the highest-penalty card. Some house rules let the Q♠ break hearts too; this
    # engine deliberately follows the more common convention where hearts alone do (test_hearts.py
    # pins it). If that ever changes, `legal_moves`' hearts-not-led-until-broken rule follows from
    # this flag with no other edit.
    if suit_of(card) == HEARTS:
        state.hearts_broken = True

    if len(state.current_trick) == NUM_PLAYERS:
        led = suit_of(state.current_trick[0][1])
        winner = max(
            (pair for pair in state.current_trick if suit_of(pair[1]) == led),
            key=lambda pair: rank_of(pair[1]),
        )[0]
        state.taken[winner].extend(played_card for _, played_card in state.current_trick)
        state.last_trick = list(state.current_trick)
        state.last_trick_winner = winner
        state.current_trick = []
        state.trick_leader = winner
        state.turn = winner
        state.tricks_played += 1
    else:
        state.turn = (state.turn + 1) % NUM_PLAYERS


def is_terminal(state: HeartsState) -> bool:
    """Return whether all 13 tricks have been played."""
    return state.tricks_played == NUM_TRICKS


def points_taken(state: HeartsState) -> list[int]:
    """Return each seat's raw penalty points from cards taken (no shoot-the-moon flip)."""
    return [sum(card_points(card) for card in state.taken[seat]) for seat in range(NUM_PLAYERS)]


def final_penalties(state: HeartsState) -> list[int]:
    """Return raw penalties with the shoot-the-moon flip: a sole 26 becomes 0, others 26."""
    raw = points_taken(state)
    if raw.count(26) == 1:
        return [0 if points == 26 else 26 for points in raw]
    return raw


def penalty_scores(state: HeartsState) -> list[int]:
    """Return the per-seat display score (lower is better): final at terminal, else running."""
    if is_terminal(state):
        return final_penalties(state)
    return points_taken(state)


def leaderboard_scores(state: HeartsState) -> list[int]:
    """Return per-seat leaderboard scores (higher is better): the negated penalty scores."""
    return [-points for points in penalty_scores(state)]
