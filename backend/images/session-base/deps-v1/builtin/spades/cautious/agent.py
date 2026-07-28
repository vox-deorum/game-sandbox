"""The frozen v1 Cautious bidder for Spades.

It bids at least one trick, values only clear high-card winners, and follows every legal suit with
its lowest legal card. The action mask remains authoritative, so the policy never has to recreate
the game's legality rules.
"""

from __future__ import annotations

from typing import Any

_NUM_CARDS = 52
_SPADES = 2


class Agent:
    """Make a low, never-nil bid and play the lowest legal card."""

    def reset(self, seed: int) -> None:
        pass

    def act(self, observation: Any) -> int:
        mask = observation["action_mask"]
        if any(mask[action] for action in range(_NUM_CARDS, len(mask))):
            hand = observation["observation"]["hand"]
            return _NUM_CARDS + _cautious_bid(hand)
        return min(
            (card for card in range(_NUM_CARDS) if mask[card]),
            key=lambda card: (card % 13, card // 13),
        )


def _cautious_bid(hand: list[dict[str, int]]) -> int:
    """Count only aces, high spades, and long-spade support, never returning nil."""
    spades = [card for card in hand if card["suit"] == _SPADES]
    estimate = sum(1 for card in hand if card["rank"] == 14)
    estimate += sum(1 for card in spades if card["rank"] in {12, 13})
    estimate += max(0, len(spades) - 4)
    return max(1, min(13, estimate))
