"""The frozen v1 built-in Spades agent: the Naive baseline.

It plays exactly the move the environment's own timeout default applies: a never-nil suggested bid
during the bidding round and the lowest legal card during play. It reads the Spades observation
dict's ``action_mask`` and semantic ``hand`` values, so it needs no dependency beyond the standard
library.
"""

from __future__ import annotations

from typing import Any

_NUM_CARDS = 52
_SPADES = 2


def _suit(card: int) -> int:
    return card // 13


def _rank(card: int) -> int:
    return card % 13


class Agent:
    """Bid a never-nil suggested count, then play the lowest legal card."""

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation: Any) -> int:
        mask = observation["action_mask"]
        if any(mask[action] for action in range(_NUM_CARDS, len(mask))):
            hand = [card["suit"] * 13 + (card["rank"] - 2) for card in observation["observation"]["hand"]]
            return _NUM_CARDS + _suggested_bid(hand)
        return min(
            (card for card in range(_NUM_CARDS) if mask[card]), key=lambda card: (_rank(card), _suit(card))
        )


def _suggested_bid(hand: list[int]) -> int:
    """A deterministic, never-nil trick estimate for ``hand``."""
    estimate = 0
    spades = [card for card in hand if _suit(card) == _SPADES]
    estimate += sum(1 for card in spades if _rank(card) >= 10)
    estimate += max(0, len(spades) - 3)
    for suit in (0, 1, 3):
        suited = [card for card in hand if _suit(card) == suit]
        estimate += sum(1 for card in suited if _rank(card) == 12)
        estimate += sum(1 for card in suited if _rank(card) == 11 and len(suited) >= 2)
    return max(1, min(13, estimate))
