"""Card helpers for Hearts agents: read semantic card objects and the observation.

You may import this module from your ``agent.py`` (``from sandbox import cards``). It is the one
piece of ``sandbox/`` you are meant to use from your agent, and importing it stays cheap: it is
plain Python with no third-party dependencies, so it does not drag in pettingzoo or pygame. Import
it at the top of ``agent.py``, not inside a method.

A card is a semantic object ``{"suit": 0..3, "rank": 2..14}``. Suits are ``0=clubs, 1=diamonds,
2=spades, 3=hearts`` and ranks are the FACE value printed on the card: ``2..10`` are themselves,
then ``11=J, 12=Q, 13=K, 14=A``. So the queen of spades is ``{"suit": 2, "rank": 12}``. Your
``act`` method returns an integer action, which you get by calling :func:`play` on the card object
you chose; you never need to build that integer by hand. The full encoding, the observation
fields, and the scoring are documented in ``environment.md``, shipped alongside the template.

The observation accessors take the whole ``observation`` dict your ``act`` method receives (the one
with the ``"action_mask"`` and ``"observation"`` keys) and return plain Python ints, card objects,
and lists, so you never handle the raw NumPy arrays yourself.
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
    "CLUBS",
    "DIAMONDS",
    "HEARTS",
    "QUEEN_OF_SPADES",
    "RANK_NAMES",
    "SPADES",
    "SUIT_NAMES",
    "TWO_OF_CLUBS",
    "card_from_obj",
    "card_name",
    "card_points",
    "card_to_obj",
    "current_trick",
    "hand_cards",
    "hearts_broken",
    "led_suit",
    "legal_cards",
    "make_card",
    "my_seat",
    "play",
    "rank_of",
    "scores",
    "suit_of",
    "trick_winner_so_far",
]

#: The card that must lead the very first trick.
TWO_OF_CLUBS = {"suit": CLUBS, "rank": 2}
#: The 13-point penalty card.
QUEEN_OF_SPADES = {"suit": SPADES, "rank": 12}


def card_points(card: dict[str, int]) -> int:
    """Return the penalty points a card is worth: 13 for the queen of spades, 1 per heart, else 0."""
    if card == QUEEN_OF_SPADES:
        return 13
    if suit_of(card) == HEARTS:
        return 1
    return 0


def legal_cards(observation: Any) -> list[dict[str, int]]:
    """Return the cards you may legally play right now, read from the action mask.

    These are exactly the cards whose ``action_mask`` bit is set, so returning ``play(card)`` for
    any of them from ``act`` is always accepted. The mask already encodes every rule (follow suit,
    hearts not led until broken, the first-trick restrictions), so you never re-derive legality
    yourself.
    """
    mask = observation["action_mask"]
    return [card_to_obj(i) for i in range(52) if mask[i]]


def play(card: dict[str, int]) -> int:
    """Return the integer action for ``card``, the value your ``act`` method should return."""
    return card_from_obj(card)


def hand_cards(observation: Any) -> list[dict[str, int]]:
    """Return every card currently in your hand, legal to play this turn or not."""
    return list(observation["observation"]["hand"])


def my_seat(observation: Any) -> int:
    """Return your own seat id (``0..3``)."""
    return int(observation["observation"]["seat"])


def led_suit(observation: Any) -> int | None:
    """Return the suit led this trick (``0..3``), or ``None`` when you are the one leading."""
    led = int(observation["observation"]["led_suit"])
    return None if led == 4 else led


def hearts_broken(observation: Any) -> bool:
    """Return whether hearts have been broken (a heart has been played on an earlier trick)."""
    return bool(observation["observation"]["hearts_broken"])


def scores(observation: Any) -> list[int]:
    """Return the running penalty points taken so far by each seat, indexed by seat id."""
    return [int(points) for points in observation["observation"]["scores"]]


def current_trick(observation: Any) -> list[tuple[int, dict[str, int]]]:
    """Return the cards played so far this trick as ``(seat, card)`` pairs, in play order.

    The list starts with the trick leader and follows the table clockwise, holding only the seats
    that have already played. It is empty when you are leading a fresh trick.
    """
    trick = observation["observation"]["current_trick"]
    return [(int(entry["seat"]), entry["card"]) for entry in trick]


def trick_winner_so_far(observation: Any) -> tuple[int, dict[str, int]] | None:
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
