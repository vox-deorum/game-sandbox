"""Card helpers for Spades agents: read semantic card objects and the observation.

You may import this module from your ``agent.py`` (``from sandbox import cards``). It is the one
piece of ``sandbox/`` you are meant to use from your agent, and importing it stays cheap: it is
plain Python with no third-party dependencies, so it does not drag in pettingzoo or pygame. Import
it at the top of ``agent.py``, not inside a method.

A card is a semantic object ``{"suit": 0..3, "rank": 2..14}``. Suits are ``0=clubs, 1=diamonds,
2=spades, 3=hearts`` and ranks are the FACE value printed on the card: ``2..10`` are themselves,
then ``11=J, 12=Q, 13=K, 14=A``. So the ace of spades is ``{"suit": 2, "rank": 14}``.

Spades has two kinds of turn in one hand, and a single ``Discrete(66)`` action space covers both:
actions ``0..51`` are cards and action ``52 + k`` is a bid of ``k`` tricks (``0..13``, where ``0``
is nil). During the bidding round only bid actions are legal; during play only cards are. The
per-turn action mask already encodes that split, so you never decode the phase or re-derive
legality yourself: :func:`legal_bids` gives the bids you may make (as plain ``0..13`` numbers),
:func:`legal_cards` the cards you may play (as card objects), and exactly one of the two is
non-empty on your turn. Your ``act`` method still returns an integer action, which you get by
calling :func:`play` on the card object you chose, or :func:`bid` on the bid you chose — you never
need to build that integer by hand. The full encoding, the observation fields, and the scoring are
documented in ``environment.md``, shipped alongside the template.

The observation accessors take the whole ``observation`` dict your ``act`` method receives (the one
with the ``"action_mask"`` and ``"observation"`` keys) and return plain Python ints, card objects,
and lists, so you never handle the raw NumPy arrays or their one-element wrappers yourself.
"""

from __future__ import annotations

from typing import Any

from sandbox.card_utils import card_from_obj, card_to_obj
from sandbox.semantic_cards import (
    CLUBS,
    DIAMONDS,
    HEARTS,
    RANK_NAMES,
    SPADES,
    SUIT_NAMES,
    card_name,
    make_card,
    rank_of,
    suit_of,
)

__all__ = [
    "BID_OFFSET",
    "CLUBS",
    "DIAMONDS",
    "HEARTS",
    "NIL_BID",
    "NUM_BIDS",
    "NUM_CARDS",
    "RANK_NAMES",
    "SPADES",
    "SUIT_NAMES",
    "action_is_bid",
    "action_to_bid",
    "beats_current_winner",
    "bid",
    "bid_to_action",
    "bids",
    "card_from_obj",
    "card_name",
    "card_to_obj",
    "current_trick",
    "hand_cards",
    "is_bidding",
    "last_trick",
    "last_trick_winner",
    "led_suit",
    "legal_bids",
    "legal_cards",
    "make_card",
    "my_seat",
    "partner_of",
    "partner_seat",
    "play",
    "rank_of",
    "spades_broken",
    "suit_of",
    "team_scores",
    "trick_winner_so_far",
    "tricks_won",
]

#: Number of cards in the deck, so bids start at this offset in the combined action space.
NUM_CARDS = 52
#: Bids run 0..13 (fourteen distinct bids); a bid of 0 is nil.
NUM_BIDS = 14
#: The action-space offset of the bids: bid ``k`` is action ``52 + k``.
BID_OFFSET = NUM_CARDS
#: The bid meaning "I will take zero tricks", worth plus/minus one hundred to the bidder.
NIL_BID = 0

# -- the card encoding ------------------------------------------------------------------------


# -- actions: cards and bids -------------------------------------------------------------------


def play(card: dict[str, int]) -> int:
    """Return the integer action for ``card``, the value your ``act`` method should return."""
    return card_from_obj(card)


def bid(n: int) -> int:
    """Return the integer action for a bid of ``n`` tricks (``0..13``, where ``0`` is nil).

    Return this from ``act`` during the bidding round, for example ``return bid(3)``.
    """
    return BID_OFFSET + n


def bid_to_action(bid_value: int) -> int:
    """Encode a bid of ``bid_value`` tricks (``0..13``) as its action-space integer ``52 + bid_value``.

    An alias of :func:`bid` kept for examples that spell it out this way.
    """
    return BID_OFFSET + bid_value


def action_to_bid(action: int) -> int:
    """Decode a bid action ``52 + k`` back to the bid ``k``. Caller ensures it is a bid action."""
    return action - BID_OFFSET


def action_is_bid(action: int) -> bool:
    """Return whether ``action`` names a bid (``>= 52``) rather than a card (``0..51``)."""
    return action >= BID_OFFSET


# -- phase and legality (read from the action mask) -------------------------------------------


def is_bidding(observation: Any) -> bool:
    """Return whether it is the bidding round (you must return a bid), not the play phase.

    Read from the phase flag the observation carries, so it is defined for every seat, on turn or
    not. When ``True``, return a bid with :func:`bid`; when ``False``, return a card with
    :func:`play`.
    """
    return int(observation["observation"]["phase"]) == 0


def legal_bids(observation: Any) -> list[int]:
    """Return the bids you may make this turn as plain numbers ``0..13`` (nil is ``0``).

    Read from the action mask: every bid is always legal during the bidding round, so this is
    ``0..13`` on your bidding turn and empty during play. Encode your choice with :func:`bid`
    before returning it.
    """
    mask = observation["action_mask"]
    return [i - BID_OFFSET for i in range(BID_OFFSET, BID_OFFSET + NUM_BIDS) if mask[i]]


def legal_cards(observation: Any) -> list[dict[str, int]]:
    """Return the cards you may legally play right now, read from the action mask.

    These are exactly the cards whose ``action_mask`` bit is set, so returning ``play(card)`` for
    any of them from ``act`` is always accepted. The mask already encodes every rule (follow suit,
    spades not led until broken), so you never re-derive legality yourself. Empty during the
    bidding round.
    """
    mask = observation["action_mask"]
    return [card_to_obj(i) for i in range(NUM_CARDS) if mask[i]]


# -- your hand, seat, and partnership ---------------------------------------------------------


def hand_cards(observation: Any) -> list[dict[str, int]]:
    """Return every card currently in your hand, legal to play this turn or not."""
    return list(observation["observation"]["hand"])


def my_seat(observation: Any) -> int:
    """Return your own seat id (``0..3``)."""
    return int(observation["observation"]["seat"])


def partner_seat(observation: Any) -> int:
    """Return your partner's seat id, read directly from the observation.

    Seats 0 and 2 are one partnership, seats 1 and 3 the other; the environment already computed
    this for you, so prefer this accessor over re-deriving it.
    """
    return int(observation["observation"]["partner_seat"])


def partner_of(seat: int) -> int:
    """Return the seat of ``seat``'s partner: the seat directly across the table (``(seat + 2) % 4``).

    Prefer :func:`partner_seat` when you have an observation in hand; this is for the rare case
    where you only have a seat id (for example, one read from a trick).
    """
    return (seat + 2) % 4


# -- bids and tricks --------------------------------------------------------------------------


def bids(observation: Any) -> list[int]:
    """Return the four seats' bids, indexed by seat; ``-1`` for a seat that has not bid yet.

    The observation encodes "not yet bid" as ``14``; this accessor remaps that to ``-1`` so
    ``bid < 0`` is the check for "hasn't bid" regardless of encoding. A bid of ``0`` is nil. Once
    the bidding round ends every entry is a real bid ``0..13``.
    """
    return [-1 if int(b) == 14 else int(b) for b in observation["observation"]["bids"]]


def tricks_won(observation: Any) -> list[int]:
    """Return the tricks taken so far by each seat, indexed by seat id."""
    return [int(count) for count in observation["observation"]["tricks_won"]]


def team_scores(observation: Any) -> list[int]:
    """Return the two teams' running hand scores: ``[team of seat 0/2, team of seat 1/3]``."""
    return [int(points) for points in observation["observation"]["team_scores"]]


def led_suit(observation: Any) -> int | None:
    """Return the suit led this trick (``0..3``), or ``None`` when you are the one leading."""
    led = int(observation["observation"]["led_suit"])
    return None if led == 4 else led


def spades_broken(observation: Any) -> bool:
    """Return whether spades have been broken (a spade has been played on an earlier trick)."""
    return bool(observation["observation"]["spades_broken"])


def current_trick(observation: Any) -> list[tuple[int, dict[str, int]]]:
    """Return the cards played so far this trick as ``(seat, card)`` pairs, in play order.

    The list starts with the trick leader and follows the table clockwise, holding only the seats
    that have already played. It is empty when you are leading a fresh trick.
    """
    trick = observation["observation"]["current_trick"]
    return [(int(entry["seat"]), entry["card"]) for entry in trick]


def last_trick(observation: Any) -> list[tuple[int, dict[str, int]]]:
    """Return the most recently completed trick as ``(seat, card)`` pairs, in play order.

    A trick is cleared from :func:`current_trick` the instant its fourth card lands, so this is how
    a seat that already played (or is leading the next trick) still sees every card of the trick
    just finished. Use :func:`last_trick_winner` for who took it. Empty until the first trick of
    the hand completes.
    """
    trick = observation["observation"]["last_trick"]
    return [(int(entry["seat"]), entry["card"]) for entry in trick]


def last_trick_winner(observation: Any) -> int | None:
    """Return the seat that won the most recently completed trick, or ``None`` before any completes."""
    winner = int(observation["observation"]["last_trick_winner"])
    return None if winner == 4 else winner


def trick_winner_so_far(observation: Any) -> tuple[int, dict[str, int]] | None:
    """Return the ``(seat, card)`` currently winning this trick, or ``None`` if no card is down.

    Spades are trump: the winner is the highest spade played so far, or, if no spade has been played,
    the highest card of the led suit. Cards that neither followed the led suit nor are spades can
    never win, so they are ignored.
    """
    played = current_trick(observation)
    if not played:
        return None
    return _winner_of(played)


def beats_current_winner(observation: Any, card: dict[str, int]) -> bool:
    """Return whether playing ``card`` now would take the trick (spades are trump).

    Useful for deciding whether to grab a trick or duck under it. When you are leading (no card is
    down yet) this is trivially ``True``. It does not check legality — gate the card through
    :func:`legal_cards` first.
    """
    winner = trick_winner_so_far(observation)
    if winner is None:  # leading: your card is the only one down, so it is "winning".
        return True
    seat = my_seat(observation)
    return _winner_of([*current_trick(observation), (seat, card)])[0] == seat


# -- internal trick helpers -------------------------------------------------------------------


def _winner_of(
    played: list[tuple[int, dict[str, int]]],
) -> tuple[int, dict[str, int]]:
    """Return the ``(seat, card)`` winning a non-empty (partial or full) trick under spades-trump."""
    led = suit_of(played[0][1])
    spades = [pair for pair in played if suit_of(pair[1]) == SPADES]
    if spades:
        return max(spades, key=lambda pair: rank_of(pair[1]))
    following = [pair for pair in played if suit_of(pair[1]) == led]
    return max(following, key=lambda pair: rank_of(pair[1]))
