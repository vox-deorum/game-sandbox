"""The 'signaler' example agent: tell your partner your strong suit, and lead theirs when you learn it.

Its one idea is a partner signal. On its turn it announces the side suit it is strongest in (the
non-spade suit it holds the ace of, longest suit as the tiebreak) with a targeted message only its
partner sees. And when its partner has told it *their* strong suit, it leads that suit when it gets
the lead, because a suit your partner is strong in is a good one to drive: they can win or protect
tricks in it. Absent a signal it falls back to the template's lowest-legal-card play, so the signal
is the whole difference, and its behaviour provably depends on the message arriving.

Bidding is the honest count the counter example uses (high spades plus side aces, never nil): the
signal, not the bid, is this agent's point. Everything is read through the ``sandbox.cards`` helpers,
so it never decodes the combined ``Discrete(66)`` action space or the observation arrays by hand.
"""

from __future__ import annotations

from typing import Any

from sandbox.cards import (
    SPADES,
    SUIT_NAMES,
    bid_to_action,
    current_trick,
    hand_cards,
    is_bidding,
    legal_cards,
    my_seat,
    partner_of,
    rank_of,
    suit_of,
)

NAME = "signaler-spades"

#: A spade of this rank or higher (queen, king, ace) is a near-certain winner once spades are trump.
HIGH_SPADE_RANK = 10
#: The ace is the top rank in every suit.
ACE_RANK = 12
#: The prefix of the one message this agent speaks: ``strong:<suit name>``.
SIGNAL_PREFIX = "strong:"


class Agent:
    """Signal your strong side suit to your partner, and lead their strong suit once you know it."""

    def reset(self, seed: int) -> None:
        # Per-hand state: the seat and hand are restamped every turn from the observation (so chat,
        # which sees no observation, can read them); the partner's signalled suit and whether we have
        # already spoken persist across the hand.
        self._seat: int | None = None
        self._hand: list[int] = []
        self._partner_suit: int | None = None
        self._signalled = False

    def act(self, observation: Any) -> int:
        self._seat = my_seat(observation)
        self._hand = hand_cards(observation)
        if is_bidding(observation):
            return bid_to_action(self._honest_bid())
        return self._play(observation)

    def chat(self, inbox: list[dict]) -> list[dict]:
        # Read the partner's signal, if any, and remember the suit for the play phase.
        partner_slot = f"player_{partner_of(self._seat)}"
        for item in inbox:
            if item.get("from") == partner_slot:
                text = item.get("text", "")
                if text.startswith(SIGNAL_PREFIX):
                    name = text[len(SIGNAL_PREFIX) :]
                    if name in SUIT_NAMES:
                        self._partner_suit = SUIT_NAMES.index(name)
        # Speak our own signal exactly once per hand, when we have a side ace to point at.
        if not self._signalled:
            suit = self._strong_side_suit()
            if suit is not None:
                self._signalled = True
                return [{"to": partner_slot, "text": f"{SIGNAL_PREFIX}{SUIT_NAMES[suit]}"}]
        return []

    def _honest_bid(self) -> int:
        """Count likely tricks: high spades plus side-suit aces. Never nil, so floored at one."""
        high_spades = sum(1 for c in self._hand if suit_of(c) == SPADES and rank_of(c) >= HIGH_SPADE_RANK)
        side_aces = sum(1 for c in self._hand if suit_of(c) != SPADES and rank_of(c) == ACE_RANK)
        return max(1, min(13, high_spades + side_aces))

    def _strong_side_suit(self) -> int | None:
        """The non-spade suit we hold the ace of; the longest such suit, ties broken by lower suit id."""
        ace_suits = [suit_of(c) for c in self._hand if suit_of(c) != SPADES and rank_of(c) == ACE_RANK]
        if not ace_suits:
            return None
        return max(ace_suits, key=lambda s: (sum(1 for c in self._hand if suit_of(c) == s), -s))

    def _play(self, observation: Any) -> int:
        """When leading and we know the partner's strong suit, lead it; otherwise lowest legal card."""
        legal = legal_cards(observation)
        leading = not current_trick(observation)
        if leading and self._partner_suit is not None:
            suited = [c for c in legal if suit_of(c) == self._partner_suit]
            if suited:
                return min(suited, key=rank_of)
        return min(legal, key=lambda c: (rank_of(c), suit_of(c)))
