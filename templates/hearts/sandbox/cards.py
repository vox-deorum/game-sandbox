"""Card helpers for Hearts agents: decode the integer card encoding and read the observation.

You may import this module from your ``agent.py`` (``from sandbox import cards``). It is the one
piece of ``sandbox/`` you are meant to use from your agent, and importing it stays cheap: it is
plain Python with no third-party dependencies, so it does not drag in pettingzoo or pygame. Import
it at the top of ``agent.py``, not inside a method.

Everything here is expressed over the fixed integer card encoding: a card is an int ``0..51`` with
``card = suit * 13 + rank``. Suits are ``0=clubs, 1=diamonds, 2=spades, 3=hearts`` and ranks run
``0=2 .. 8=10, 9=J, 10=Q, 11=K, 12=A``. So the 2 of clubs is ``0`` and the queen of spades is
``36``. The full encoding, the observation fields, and the scoring are documented in
``environment.md``, shipped alongside the template.

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

#: The card that must lead the very first trick.
TWO_OF_CLUBS = 0
#: The 13-point penalty card.
QUEEN_OF_SPADES = 36

#: Suit names indexed by suit id, and rank names indexed by rank id. Used by :func:`card_name`.
SUIT_NAMES: tuple[str, ...] = ("clubs", "diamonds", "spades", "hearts")
RANK_NAMES: tuple[str, ...] = ("2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A")


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
    """Return a readable ASCII name for ``card``, for example ``"Q of spades"`` or ``"2 of clubs"``."""
    return f"{RANK_NAMES[rank_of(card)]} of {SUIT_NAMES[suit_of(card)]}"


def card_points(card: int) -> int:
    """Return the penalty points a card is worth: 13 for the queen of spades, 1 per heart, else 0."""
    if card == QUEEN_OF_SPADES:
        return 13
    if suit_of(card) == HEARTS:
        return 1
    return 0


def legal_cards(observation: Any) -> list[int]:
    """Return the cards you may legally play right now, read from the action mask.

    These are exactly the cards whose ``action_mask`` bit is set, so returning any of them from
    ``act`` is always accepted. The mask already encodes every rule (follow suit, hearts not led
    until broken, the first-trick restrictions), so you never re-derive legality yourself.
    """
    mask = observation["action_mask"]
    return [card for card in range(52) if mask[card]]


def hand_cards(observation: Any) -> list[int]:
    """Return every card currently in your hand, legal to play this turn or not."""
    hand = observation["observation"]["hand"]
    return [card for card in range(52) if hand[card]]


def my_seat(observation: Any) -> int:
    """Return your own seat id (``0..3``)."""
    return int(observation["observation"]["position"][0])


def led_suit(observation: Any) -> int | None:
    """Return the suit led this trick (``0..3``), or ``None`` when you are the one leading."""
    led = int(observation["observation"]["led_suit"][0])
    return None if led == -1 else led


def hearts_broken(observation: Any) -> bool:
    """Return whether hearts have been broken (a heart has been played on an earlier trick)."""
    return bool(observation["observation"]["hearts_broken"][0])


def scores(observation: Any) -> list[int]:
    """Return the running penalty points taken so far by each seat, indexed by seat id."""
    return [int(points) for points in observation["observation"]["scores"]]


def current_trick(observation: Any) -> list[tuple[int, int]]:
    """Return the cards played so far this trick as ``(seat, card)`` pairs, in play order.

    The list starts with the trick leader and follows the table clockwise, holding only the seats
    that have already played. It is empty when you are leading a fresh trick.
    """
    trick = observation["observation"]["trick"]
    leader = int(observation["observation"]["trick_leader"][0])
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


def trick_winner_so_far(observation: Any) -> tuple[int, int] | None:
    """Return the ``(seat, card)`` currently winning this trick, or ``None`` if no card is down.

    The winner is the highest card of the led suit played so far. Cards that did not follow the led
    suit can never win, so they are ignored.
    """
    played = current_trick(observation)
    if not played:
        return None
    led = suit_of(played[0][1])
    following = [(seat, card) for seat, card in played if suit_of(card) == led]
    return max(following, key=lambda pair: rank_of(pair[1]))
