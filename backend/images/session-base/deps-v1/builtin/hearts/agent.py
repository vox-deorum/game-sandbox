"""The frozen v1 built-in Hearts agent: the Naive baseline.

It always plays its lowest legal card: the lowest-ranked card the legal-action mask permits,
ties broken by suit, exactly the move the environment's own timeout default applies
(``hearts.rules.lowest_legal_card``). That keeps it trivially legal every turn while clinging to
the queen of spades and high hearts until they are forced onto it: the weak play a submitted
agent is expected to beat (see ``environments/hearts/examples/duck``). It reads the Hearts
observation dict's ``action_mask``, so it needs no dependency beyond the standard library.
"""

from __future__ import annotations

from typing import Any


class Agent:
    """Play the lowest legal card every turn (the env's own timeout default)."""

    def reset(self, seed: int) -> None:
        # Stateless: every legality question is answered by the per-step action mask.
        pass

    def act(self, observation: Any) -> int:
        # The mask flags one bit per card id 0..51 (card = suit * 13 + rank); pick the legal card
        # with the lowest rank (card % 13), ties broken by suit (card // 13).
        mask = observation["action_mask"]
        return min((card for card in range(52) if mask[card]), key=lambda c: (c % 13, c // 13))
