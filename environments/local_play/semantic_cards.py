"""Dependency-free helpers for semantic standard playing-card objects."""

from __future__ import annotations

CLUBS = 0
DIAMONDS = 1
SPADES = 2
HEARTS = 3

SUIT_NAMES: tuple[str, ...] = ("clubs", "diamonds", "spades", "hearts")
RANK_NAMES: tuple[str, ...] = (
    "",
    "",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "J",
    "Q",
    "K",
    "A",
)


def suit_of(card: dict[str, int]) -> int:
    """Return the suit id (``0..3``) of a semantic card object."""
    return card["suit"]


def rank_of(card: dict[str, int]) -> int:
    """Return the face-value rank (``2..14``) of a semantic card object."""
    return card["rank"]


def make_card(suit: int, rank: int) -> dict[str, int]:
    """Return the semantic card object for ``suit`` and face-value ``rank``."""
    return {"suit": suit, "rank": rank}


def card_name(card: dict[str, int]) -> str:
    """Return a readable ASCII card name, for example ``"Q of spades"``."""
    return f"{RANK_NAMES[rank_of(card)]} of {SUIT_NAMES[suit_of(card)]}"
