"""Card helpers for Spades agents: decode the combined action space and read the observation.

You may import this module from your ``agent.py`` (``from sandbox import cards``). It is the one
piece of ``sandbox/`` you are meant to use from your agent, and importing it stays cheap: it is
plain Python with no third-party dependencies, so it does not drag in pettingzoo or pygame. Import
it at the top of ``agent.py``, not inside a method.

Spades has two kinds of turn in one hand, and a single ``Discrete(66)`` action space covers both:
actions ``0..51`` are cards and action ``52 + k`` is a bid of ``k`` tricks (``0..13``, where ``0``
is nil). During the bidding round only bid actions are legal; during play only cards are. The
per-turn action mask already encodes that split, so you never decode the phase or re-derive
legality yourself: :func:`legal_bids` gives the bids you may make (as plain ``0..13`` numbers),
:func:`legal_cards` the cards you may play, and exactly one of the two is non-empty on your turn.

The card encoding (fixed, identical to Hearts): a card is an int ``0..51`` with
``card = suit * 13 + rank``. Suits are ``0=clubs, 1=diamonds, 2=spades, 3=hearts`` and ranks run
``0=2 .. 8=10, 9=J, 10=Q, 11=K, 12=A``. So the 2 of clubs is ``0`` and the ace of spades is ``38``.
The full encoding, the observation fields, and the scoring are documented in ``environment.md``,
shipped alongside the template.

The observation accessors take the whole ``observation`` dict your ``act`` method receives (the one
with the ``"action_mask"`` and ``"observation"`` keys) and return plain Python ints and lists, so
you never handle the raw NumPy arrays or their one-element wrappers yourself.
"""

from __future__ import annotations

from typing import Any

#: Suit ids, which are also the high bits of the card encoding.
CLUBS = 0
DIAMONDS = 1
SPADES = 2
HEARTS = 3

#: Number of cards in the deck, so bids start at this offset in the combined action space.
NUM_CARDS = 52
#: Bids run 0..13 (fourteen distinct bids); a bid of 0 is nil.
NUM_BIDS = 14
#: The action-space offset of the bids: bid ``k`` is action ``52 + k``.
BID_OFFSET = NUM_CARDS
#: The bid meaning "I will take zero tricks", worth plus/minus one hundred to the bidder.
NIL_BID = 0

#: Suit names indexed by suit id, and rank names indexed by rank id. Used by :func:`card_name`.
SUIT_NAMES: tuple[str, ...] = ("clubs", "diamonds", "spades", "hearts")
RANK_NAMES: tuple[str, ...] = ("2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A")


# -- the card encoding ------------------------------------------------------------------------


def suit_of(card: int) -> int:
    """Return the suit id (``0..3``) of ``card``."""
    return card // 13


def rank_of(card: int) -> int:
    """Return the rank id (``0..12``, where ``0`` is the 2 and ``12`` the ace) of ``card``."""
    return card % 13


def make_card(suit: int, rank: int) -> int:
    """Return the card id for a ``suit`` (``0..3``) and ``rank`` (``0..12``)."""
    return suit * 13 + rank


def card_name(card: int) -> str:
    """Return a readable ASCII name for ``card``, for example ``"A of spades"`` or ``"2 of clubs"``."""
    return f"{RANK_NAMES[rank_of(card)]} of {SUIT_NAMES[suit_of(card)]}"


# -- the bid encoding -------------------------------------------------------------------------


def bid_to_action(bid: int) -> int:
    """Encode a bid of ``bid`` tricks (``0..13``) as its action-space integer ``52 + bid``.

    Return this from ``act`` during the bidding round, for example ``return bid_to_action(3)``.
    """
    return BID_OFFSET + bid


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
    not. When ``True``, return a bid with :func:`bid_to_action`; when ``False``, return a card.
    """
    return int(observation["observation"]["phase"][0]) == 0


def legal_bids(observation: Any) -> list[int]:
    """Return the bids you may make this turn as plain numbers ``0..13`` (nil is ``0``).

    Read from the action mask: every bid is always legal during the bidding round, so this is
    ``0..13`` on your bidding turn and empty during play. Encode your choice with
    :func:`bid_to_action` before returning it.
    """
    mask = observation["action_mask"]
    return [action_to_bid(action) for action in range(BID_OFFSET, BID_OFFSET + NUM_BIDS) if mask[action]]


def legal_cards(observation: Any) -> list[int]:
    """Return the cards you may legally play right now, read from the action mask.

    These are exactly the cards whose ``action_mask`` bit is set, so returning any of them from
    ``act`` is always accepted. The mask already encodes every rule (follow suit, spades not led
    until broken), so you never re-derive legality yourself. Empty during the bidding round.
    """
    mask = observation["action_mask"]
    return [card for card in range(NUM_CARDS) if mask[card]]


# -- your hand, seat, and partnership ---------------------------------------------------------


def hand_cards(observation: Any) -> list[int]:
    """Return every card currently in your hand, legal to play this turn or not."""
    hand = observation["observation"]["hand"]
    return [card for card in range(NUM_CARDS) if hand[card]]


def my_seat(observation: Any) -> int:
    """Return your own seat id (``0..3``)."""
    return int(observation["observation"]["position"][0])


def partner_of(seat: int) -> int:
    """Return the seat of ``seat``'s partner: the seat directly across the table (``(seat + 2) % 4``).

    Seats 0 and 2 are one partnership, seats 1 and 3 the other, so your partner is always
    ``partner_of(my_seat(observation))``.
    """
    return (seat + 2) % 4


# -- bids and tricks --------------------------------------------------------------------------


def bids(observation: Any) -> list[int]:
    """Return the four seats' bids, indexed by seat; ``-1`` for a seat that has not bid yet.

    A bid of ``0`` is nil. Once the bidding round ends every entry is a real bid ``0..13``.
    """
    return [int(bid) for bid in observation["observation"]["bids"]]


def tricks_won(observation: Any) -> list[int]:
    """Return the tricks taken so far by each seat, indexed by seat id."""
    return [int(count) for count in observation["observation"]["tricks_won"]]


def led_suit(observation: Any) -> int | None:
    """Return the suit led this trick (``0..3``), or ``None`` when you are the one leading."""
    led = int(observation["observation"]["led_suit"][0])
    return None if led == -1 else led


def spades_broken(observation: Any) -> bool:
    """Return whether spades have been broken (a spade has been played on an earlier trick)."""
    return bool(observation["observation"]["spades_broken"][0])


def current_trick(observation: Any) -> list[tuple[int, int]]:
    """Return the cards played so far this trick as ``(seat, card)`` pairs, in play order.

    The list starts with the trick leader and follows the table clockwise, holding only the seats
    that have already played. It is empty when you are leading a fresh trick.
    """
    return _trick_pairs(
        observation["observation"]["trick"], int(observation["observation"]["trick_leader"][0])
    )


def last_trick(observation: Any) -> list[tuple[int, int]]:
    """Return the most recently completed trick as ``(seat, card)`` pairs, ordered by seat id.

    A trick is cleared from :func:`current_trick` the instant its fourth card lands, so this is how
    a seat that already played (or is leading the next trick) still sees every card of the trick just
    finished. All four seats played, so every seat appears; use :func:`last_trick_winner` for who
    took it. Empty until the first trick of the hand completes.
    """
    trick = observation["observation"]["last_trick"]
    return [(seat, int(trick[seat])) for seat in range(4) if int(trick[seat]) != -1]


def last_trick_winner(observation: Any) -> int | None:
    """Return the seat that won the most recently completed trick, or ``None`` before any completes."""
    winner = int(observation["observation"]["last_trick_winner"][0])
    return None if winner == -1 else winner


def trick_winner_so_far(observation: Any) -> tuple[int, int] | None:
    """Return the ``(seat, card)`` currently winning this trick, or ``None`` if no card is down.

    Spades are trump: the winner is the highest spade played so far, or, if no spade has been played,
    the highest card of the led suit. Cards that neither followed the led suit nor are spades can
    never win, so they are ignored.
    """
    played = current_trick(observation)
    if not played:
        return None
    return _winner_of(played)


def beats_current_winner(observation: Any, card: int) -> bool:
    """Return whether playing ``card`` now would take the trick (spades are trump).

    Useful for deciding whether to grab a trick or duck under it. When you are leading (no card is
    down yet) this is trivially ``True``. It does not check legality — gate the card through
    :func:`legal_cards` first.
    """
    winner = trick_winner_so_far(observation)
    if winner is None:  # leading: your card is the only one down, so it is "winning".
        return True
    return _winner_of([*current_trick(observation), (my_seat(observation), card)])[1] == card


# -- internal trick helpers -------------------------------------------------------------------


def _trick_pairs(trick: Any, leader: int) -> list[tuple[int, int]]:
    """Turn a seat-indexed ``trick`` array into ``(seat, card)`` pairs in play order from ``leader``."""
    played: list[tuple[int, int]] = []
    # The trick array is indexed by seat; play order runs from the leader clockwise, so walk the
    # seats in that order and stop collecting once we reach a seat that has not played yet.
    for offset in range(4):
        seat = (leader + offset) % 4
        card = int(trick[seat])
        if card == -1:
            break
        played.append((seat, card))
    return played


def _winner_of(played: list[tuple[int, int]]) -> tuple[int, int]:
    """Return the ``(seat, card)`` winning a non-empty (partial or full) trick under spades-trump."""
    led = suit_of(played[0][1])
    spades = [pair for pair in played if suit_of(pair[1]) == SPADES]
    if spades:
        return max(spades, key=lambda pair: rank_of(pair[1]))
    following = [pair for pair in played if suit_of(pair[1]) == led]
    return max(following, key=lambda pair: rank_of(pair[1]))
